"""Environment configuration for the Qwen realtime voice sidecar."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _strip(value: str | None) -> str:
    trimmed = str(value or "").strip()
    if (trimmed.startswith('"') and trimmed.endswith('"')) or (
        trimmed.startswith("'") and trimmed.endswith("'")
    ):
        return trimmed[1:-1].strip()
    return trimmed


@dataclass(frozen=True)
class Settings:
    dashscope_api_key: str
    dashscope_ws_base: str
    asr_model: str
    tts_model: str
    tts_voice: str
    lease_secret: str
    max_session_seconds: int
    max_audio_bytes: int
    max_text_chars: int
    host: str
    port: int

    @property
    def configured(self) -> bool:
        return bool(self.dashscope_api_key and self.lease_secret)


def get_settings() -> Settings:
    return Settings(
        dashscope_api_key=_strip(
            os.environ.get("DASHSCOPE_API_KEY")
            or os.environ.get("QWEN_ASR_API_KEY")
            or ""
        ),
        dashscope_ws_base=_strip(
            os.environ.get("QWEN_REALTIME_WS_BASE")
            or "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
        ).rstrip("/"),
        asr_model=_strip(
            os.environ.get("QWEN_ASR_REALTIME_MODEL") or "qwen3-asr-flash-realtime"
        ),
        tts_model=_strip(
            os.environ.get("QWEN_TTS_REALTIME_MODEL") or "qwen3-tts-flash-realtime"
        ),
        tts_voice=_strip(os.environ.get("QWEN_TTS_VOICE") or "Cherry"),
        lease_secret=_strip(os.environ.get("VOICE_LEASE_SECRET") or ""),
        max_session_seconds=int(os.environ.get("VOICE_MAX_SESSION_SECONDS") or "180"),
        max_audio_bytes=int(os.environ.get("VOICE_MAX_AUDIO_BYTES") or str(8 * 1024 * 1024)),
        max_text_chars=int(os.environ.get("VOICE_MAX_TEXT_CHARS") or "4000"),
        host=_strip(os.environ.get("HOST") or "0.0.0.0"),
        port=int(os.environ.get("PORT") or "3015"),
    )