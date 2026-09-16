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
        await self._send({"type": "input_text_buffer.append", "text": text})

    async def finish(self) -> bytes:
        await self._send({"type": "session.finish"})
        try:
            await asyncio.wait_for(self._closed.wait(), timeout=60)
        except TimeoutError:
            logger.warning("TTS session.finish timed out")
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
        try:
            async for raw in self._ws:
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._handle_event(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("TTS read loop ended: %s", type(exc).__name__)
            if self.on_error:
                await self.on_error(f"TTS connection closed: {exc}")
        finally:
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
            if self.on_error:
                await self.on_error(str(detail))
        elif etype == "session.finished":
            self._closed.set()


async def synthesize_text_once(
    text: str,
    *,
    api_key: str,
    ws_base: str,
    model: str,
    voice: str = "Cherry",
    language_type: str = "Auto",
    as_wav: bool = True,
) -> bytes:
    """Synthesize full text and return WAV (default) or raw PCM bytes."""
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
    finally:
        await session.close()