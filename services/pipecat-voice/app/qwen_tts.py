"""DashScope Qwen realtime TTS client (streaming PCM16 output)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from .pcm import pcm16_to_wav

logger = logging.getLogger("pipecat-voice.qwen_tts")

AudioHandler = Callable[[bytes], Awaitable[None]]
ErrorHandler = Callable[[str], Awaitable[None]]


def _event_id() -> str:
    return f"evt_{uuid.uuid4().hex[:16]}"


# DashScope realtime TTS rejects any single `input_text_buffer.append` over
# 2000 characters (CLIENT_ERROR: "A single text fragment exceeds the
# 2000-character limit"). Keep appends under that with a safety margin.
TTS_FRAGMENT_LIMIT = 1900
_FRAGMENT_SEPARATORS = "。！？；\n.!?;"


def split_text_fragments(text: str, limit: int = TTS_FRAGMENT_LIMIT) -> list[str]:
    """Split long text into appends under the per-fragment limit.

    Prefers sentence-boundary cuts; falls back to a hard cut. Whitespace is
    preserved verbatim so incremental streaming callers are unaffected.
    """
    if len(text) <= limit:
        return [text] if text else []
    fragments: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = 0
        for i in range(limit):
            if rest[i] in _FRAGMENT_SEPARATORS:
                cut = i + 1
        if cut == 0:
            cut = limit
        fragments.append(rest[:cut])
        rest = rest[cut:]
    if rest:
        fragments.append(rest)
    return fragments


class QwenRealtimeTtsSession:
    """One DashScope realtime TTS WebSocket session."""

    def __init__(
        self,
        *,
        api_key: str,
        ws_base: str,
        model: str,
        voice: str = "Cherry",
        language_type: str = "Auto",
        on_audio: AudioHandler | None = None,
        on_error: ErrorHandler | None = None,
    ) -> None:
        self.api_key = api_key
        self.ws_base = ws_base.rstrip("/")
        self.model = model
        self.voice = voice
        self.language_type = language_type
        self.on_audio = on_audio
        self.on_error = on_error
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task[None] | None = None
        self._closed = asyncio.Event()
        self._audio_done = asyncio.Event()
        self._pcm_chunks: list[bytes] = []
        self._appended_chars = 0
        self._session_finished = False
        self._upstream_failed = False
        self._reported_error = False
        self._failure_message = ""
        self.sample_rate = 24000

    @property
    def pcm(self) -> bytes:
        return b"".join(self._pcm_chunks)

    async def connect(self) -> None:
        url = f"{self.ws_base}?model={self.model}"
        headers = [
            ("Authorization", f"Bearer {self.api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
            ("User-Agent", "personaldash-pipecat-voice/1.0"),
        ]
        self._ws = await websockets.connect(
            url,
            additional_headers=headers,
            open_timeout=20,
            max_size=16 * 1024 * 1024,
        )
        self._reader = asyncio.create_task(self._read_loop())
        await self._send(
            {
                "type": "session.update",
                "session": {
                    "voice": self.voice,
                    "mode": "server_commit",
                    "language_type": self.language_type,
                    "response_format": "pcm",
                    "sample_rate": self.sample_rate,
                },
            }
        )

    async def append_text(self, text: str) -> None:
        if not text:
            return
        for fragment in split_text_fragments(text):
            self._appended_chars += len(fragment)
            await self._send({"type": "input_text_buffer.append", "text": fragment})

    def _finish_timeout_sec(self) -> float:
        # Synthesis runs ~4x realtime, but the drain tail after `session.finish`
        # scales with payload length; allow generous headroom for CJK-heavy
        # text (slower speech pace) plus handshake variance.
        return float(min(600, max(90, 30 + self._appended_chars * 0.15)))

    async def finish(self) -> bytes:
        if self._upstream_failed:
            raise RuntimeError(
                self._failure_message or "TTS connection closed by upstream"
            )
        await self._send({"type": "session.finish"})
        try:
            await asyncio.wait_for(
                self._closed.wait(), timeout=self._finish_timeout_sec()
            )
        except TimeoutError:
            logger.warning("TTS session.finish timed out")
            self._upstream_failed = True
            self._failure_message = "TTS session.finish timed out"
            if not self._reported_error:
                self._reported_error = True
                if self.on_error:
                    await self.on_error(self._failure_message)
        if self._upstream_failed:
            raise RuntimeError(
                self._failure_message or "TTS connection closed by upstream"
            )
        return self.pcm

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
            try:
                await self._reader
            except asyncio.CancelledError:
                pass
            self._reader = None
        if self._ws:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None
        self._closed.set()

    async def _send(self, payload: dict[str, Any]) -> None:
        if not self._ws:
            raise RuntimeError("TTS session is not connected")
        message = {"event_id": _event_id(), **payload}
        await self._ws.send(json.dumps(message))

    async def _read_loop(self) -> None:
        assert self._ws is not None
        cancelled = False
        try:
            async for raw in self._ws:
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._handle_event(event)
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception as exc:  # noqa: BLE001
            # %r keeps the WebSocket close code/reason (ConnectionClosedError)
            # visible instead of only the exception class name.
            logger.warning("TTS read loop ended: %r", exc)
            if not self._reported_error:
                self._upstream_failed = True
                self._reported_error = True
                self._failure_message = f"TTS connection closed: {exc}"
                if self.on_error:
                    await self.on_error(self._failure_message)
        finally:
            # A clean upstream close exits the loop with no exception and no
            # `session.finished`; treat it as a failure so callers never
            # mistake a dead session for a completed one.
            if (
                not cancelled
                and not self._session_finished
                and not self._reported_error
            ):
                self._upstream_failed = True
                self._reported_error = True
                self._failure_message = "TTS connection closed by upstream"
                logger.warning("TTS upstream closed before session.finished")
                if self.on_error:
                    await self.on_error(self._failure_message)
            self._closed.set()

    async def _handle_event(self, event: dict[str, Any]) -> None:
        etype = str(event.get("type") or "")
        if etype == "response.audio.delta":
            encoded = event.get("delta") or event.get("audio") or ""
            if not encoded:
                return
            chunk = base64.b64decode(encoded)
            self._pcm_chunks.append(chunk)
            if self.on_audio:
                await self.on_audio(chunk)
        elif etype == "response.audio.done":
            self._audio_done.set()
        elif etype == "error":
            detail = (
                event.get("error", {}).get("message")
                if isinstance(event.get("error"), dict)
                else event.get("message")
            ) or "Qwen TTS error"
            self._upstream_failed = True
            self._failure_message = str(detail)
            if not self._reported_error:
                self._reported_error = True
                if self.on_error:
                    await self.on_error(str(detail))
            self._closed.set()
        elif etype == "session.finished":
            self._session_finished = True
            self._closed.set()


_EXPLICIT_ERROR_TOKENS = (
    "invalid api",
    "unauthorized",
    "401",
    "403",
    "quota",
    "throttl",
    "rate limit",
    "arrear",
    "access denied",
)


def _is_explicit_provider_error(exc: Exception) -> bool:
    detail = str(exc).lower()
    return any(token in detail for token in _EXPLICIT_ERROR_TOKENS)


async def synthesize_text_once(
    text: str,
    *,
    api_key: str,
    ws_base: str,
    model: str,
    voice: str = "Cherry",
    language_type: str = "Auto",
    as_wav: bool = True,
    attempts: int = 2,
) -> bytes:
    """Synthesize full text and return WAV (default) or raw PCM bytes.

    Transient upstream failures (empty audio, connection closed before
    `session.finished`) are retried with a fresh session. Explicit provider
    rejections (auth, quota, throttling) fail immediately.
    """
    last_error: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        session = QwenRealtimeTtsSession(
            api_key=api_key,
            ws_base=ws_base,
            model=model,
            voice=voice,
            language_type=language_type,
        )
        try:
            await session.connect()
            await session.append_text(text)
            pcm = await session.finish()
            if not pcm:
                raise RuntimeError("Qwen TTS returned empty audio")
            if as_wav:
                return pcm16_to_wav(pcm, sample_rate=session.sample_rate)
            return pcm
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt >= attempts or _is_explicit_provider_error(exc):
                raise
            logger.warning(
                "TTS attempt %d/%d failed (%s: %s); retrying",
                attempt,
                attempts,
                type(exc).__name__,
                exc,
            )
            await asyncio.sleep(0.25 * attempt)
        finally:
            await session.close()
    raise last_error or RuntimeError("Qwen TTS failed")