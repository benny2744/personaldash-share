"""DashScope Qwen realtime ASR client (manual commit / push-to-talk)."""

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

logger = logging.getLogger("pipecat-voice.qwen_asr")

TranscriptHandler = Callable[[str, bool], Awaitable[None]]
ErrorHandler = Callable[[str], Awaitable[None]]


def _event_id() -> str:
    return f"evt_{uuid.uuid4().hex[:16]}"


def preview_from_text_event(event: dict[str, Any] | None) -> str:
    """Build the live ASR preview from Qwen text/stash fields.

    Qwen emits a confirmed prefix in ``text`` and a revisable suffix in
    ``stash``. The UI preview is always ``text + stash``.
    """
    if not isinstance(event, dict):
        return ""
    confirmed = str(event.get("text") or "")
    stash = str(event.get("stash") or "")
    return f"{confirmed}{stash}".strip()


class QwenRealtimeAsrSession:
    """One DashScope realtime ASR WebSocket session."""

    def __init__(
        self,
        *,
        api_key: str,
        ws_base: str,
        model: str,
        language: str = "auto",
        on_transcript: TranscriptHandler | None = None,
        on_error: ErrorHandler | None = None,
    ) -> None:
        self.api_key = api_key
        self.ws_base = ws_base.rstrip("/")
        self.model = model
        self.language = language
        self.on_transcript = on_transcript
        self.on_error = on_error
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task[None] | None = None
        self._closed = asyncio.Event()
        self._final_text = ""
        self._audio_bytes = 0

    @property
    def audio_bytes(self) -> int:
        return self._audio_bytes

    @property
    def final_text(self) -> str:
        return self._final_text

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
        session: dict[str, Any] = {
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            # Manual mode for push-to-record.
            "turn_detection": None,
        }
        if self.language and self.language != "auto":
            session["input_audio_transcription"] = {"language": self.language}
        await self._send({"type": "session.update", "session": session})

    async def append_pcm(self, pcm: bytes) -> None:
        if not pcm or not self._ws:
            return
        self._audio_bytes += len(pcm)
        await self._send(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm).decode("ascii"),
            }
        )

    async def commit(self) -> None:
        await self._send({"type": "input_audio_buffer.commit"})

    async def finish(self) -> str:
        await self._send({"type": "session.finish"})
        try:
            await asyncio.wait_for(self._closed.wait(), timeout=30)
        except TimeoutError:
            logger.warning("ASR session.finish timed out")
        return self._final_text

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
            raise RuntimeError("ASR session is not connected")
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
            logger.warning("ASR read loop ended: %s", type(exc).__name__)
            if self.on_error:
                await self.on_error(f"ASR connection closed: {exc}")
        finally:
            self._closed.set()

    async def _handle_event(self, event: dict[str, Any]) -> None:
        etype = str(event.get("type") or "")
        if etype == "conversation.item.input_audio_transcription.text":
            preview = preview_from_text_event(event)
            if preview and self.on_transcript:
                await self.on_transcript(preview, False)
        elif etype == "conversation.item.input_audio_transcription.completed":
            text = str(event.get("transcript") or event.get("text") or "").strip()
            if text:
                self._final_text = text
            if self.on_transcript:
                await self.on_transcript(self._final_text, True)
        elif etype == "error":
            detail = (
                event.get("error", {}).get("message")
                if isinstance(event.get("error"), dict)
                else event.get("message")
            ) or "Qwen ASR error"
            if self.on_error:
                await self.on_error(str(detail))
        elif etype == "session.finished":
            self._closed.set()


async def transcribe_pcm_once(
    pcm: bytes,
    *,
    api_key: str,
    ws_base: str,
    model: str,
    language: str = "auto",
) -> str:
    """One-shot helper: append all PCM, commit, finish, return final text."""
    finals: list[str] = []

    async def on_transcript(text: str, is_final: bool) -> None:
        if is_final and text:
            finals.append(text)

    session = QwenRealtimeAsrSession(
        api_key=api_key,
        ws_base=ws_base,
        model=model,
        language=language,
        on_transcript=on_transcript,
    )
    try:
        await session.connect()
        # Stream in ~100ms frames.
        frame = 16000 * 2 // 10
        for offset in range(0, len(pcm), frame):
            await session.append_pcm(pcm[offset : offset + frame])
            await asyncio.sleep(0)
        await session.commit()
        text = await session.finish()
        return text or (finals[-1] if finals else "")
    finally:
        await session.close()
