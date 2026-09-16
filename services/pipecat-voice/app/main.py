"""Authenticated Qwen realtime voice sidecar for PersonalDash."""

from __future__ import annotations

import base64
import logging
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response

from .config import get_settings
from .leases import LeaseError, verify_lease
from .qwen_asr import QwenRealtimeAsrSession, transcribe_pcm_once
from .qwen_tts import QwenRealtimeTtsSession, synthesize_text_once

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("pipecat-voice")

app = FastAPI(title="PersonalDash Qwen Voice", docs_url=None, redoc_url=None)
settings = get_settings()


def _require_configured() -> None:
    if not settings.configured:
        raise HTTPException(
            status_code=503,
            detail="DASHSCOPE_API_KEY and VOICE_LEASE_SECRET must be configured",
        )


def _check_internal(authorization: str | None) -> None:
    _require_configured()
    expected = f"Bearer {settings.lease_secret}"
    if not authorization or authorization != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "configured": settings.configured,
        "asr_model": settings.asr_model,
        "tts_model": settings.tts_model,
        "tts_voice": settings.tts_voice,
    }


@app.post("/v1/transcribe")
async def http_transcribe(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Internal one-shot ASR for PersonalDash HTTP fallback."""
    _check_internal(authorization)
    body = await request.json()
    audio_b64 = body.get("audio")
    if not isinstance(audio_b64, str) or not audio_b64:
        raise HTTPException(status_code=400, detail="Missing audio")
    language = str(body.get("language") or "auto")
    try:
        pcm = base64.b64decode(audio_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Invalid audio base64") from exc
    if len(pcm) > settings.max_audio_bytes:
        raise HTTPException(status_code=413, detail="Audio too large")
    try:
        text = await transcribe_pcm_once(
            pcm,
            api_key=settings.dashscope_api_key,
            ws_base=settings.dashscope_ws_base,
            model=settings.asr_model,
            language=language,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("HTTP ASR failed")
        raise HTTPException(status_code=502, detail=str(exc) or "ASR failed") from exc
    return JSONResponse(
        {
            "text": text,
            "provider": "qwen",
            "model": settings.asr_model,
            "bytes": len(pcm),
        }
    )


@app.post("/v1/speak")
async def http_speak(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Response:
    """Internal one-shot TTS for PersonalDash HTTP fallback."""
    _check_internal(authorization)
    body = await request.json()
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="Missing text")
    if len(text) > settings.max_text_chars:
        raise HTTPException(status_code=413, detail="Text too long")
    try:
        wav = await synthesize_text_once(
            text.strip(),
            api_key=settings.dashscope_api_key,
            ws_base=settings.dashscope_ws_base,
            model=settings.tts_model,
            voice=settings.tts_voice,
            as_wav=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("HTTP TTS failed")
        raise HTTPException(status_code=502, detail=str(exc) or "TTS failed") from exc
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Hermes-TTS-Provider": "qwen",
            "X-Hermes-TTS-Model": settings.tts_model,
            "X-Hermes-TTS-Voice": settings.tts_voice,
            "Cache-Control": "no-store",
        },
    )


async def _send_json(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_json(payload)


async def _voice_ws_handler(
    websocket: WebSocket,
    token: str,
) -> None:
    await websocket.accept()
    if not settings.configured:
        await _send_json(
            websocket,
            {"type": "error", "message": "Voice service is not configured"},
        )
        await websocket.close(code=1013)
        return

    try:
        lease = verify_lease(token, secret=settings.lease_secret)
    except LeaseError as exc:
        await _send_json(websocket, {"type": "error", "message": str(exc)})
        await websocket.close(code=1008)
        return

    started = time.monotonic()
    mode = lease.mode
    asr: QwenRealtimeAsrSession | None = None
    tts: QwenRealtimeTtsSession | None = None
    audio_bytes = 0
    text_chars = 0
    closed = False

    async def on_asr_transcript(text: str, is_final: bool) -> None:
        await _send_json(
            websocket,
            {
                "type": "transcript.final" if is_final else "transcript.partial",
                "text": text,
            },
        )

    async def on_tts_audio(chunk: bytes) -> None:
        await _send_json(
            websocket,
            {
                "type": "audio.delta",
                "audio": base64.b64encode(chunk).decode("ascii"),
                "sampleRate": 24000,
                "format": "pcm_s16le",
            },
        )

    async def on_error(message: str) -> None:
        nonlocal closed
        if closed:
            return
        await _send_json(websocket, {"type": "error", "message": message})

    try:
        if mode == "asr":
            asr = QwenRealtimeAsrSession(
                api_key=settings.dashscope_api_key,
                ws_base=settings.dashscope_ws_base,
                model=settings.asr_model,
                language="auto",
                on_transcript=on_asr_transcript,
                on_error=on_error,
            )
            await asr.connect()
            await _send_json(
                websocket,
                {
                    "type": "ready",
                    "mode": "asr",
                    "sampleRate": 16000,
                    "format": "pcm_s16le",
                    "model": settings.asr_model,
                    "provider": "qwen",
                    "expiresAt": lease.exp,
                },
            )
        else:
            tts = QwenRealtimeTtsSession(
                api_key=settings.dashscope_api_key,
                ws_base=settings.dashscope_ws_base,
                model=settings.tts_model,
                voice=settings.tts_voice,
                on_audio=on_tts_audio,
                on_error=on_error,
            )
            await tts.connect()
            await _send_json(
                websocket,
                {
                    "type": "ready",
                    "mode": "tts",
                    "sampleRate": 24000,
                    "format": "pcm_s16le",
                    "model": settings.tts_model,
                    "voice": settings.tts_voice,
                    "provider": "qwen",
                    "expiresAt": lease.exp,
                },
            )

        while True:
            if time.monotonic() - started > settings.max_session_seconds:
                await _send_json(websocket, {"type": "error", "message": "Voice session timed out"})
                break
            if lease.exp <= int(time.time()):
                await _send_json(websocket, {"type": "error", "message": "Lease expired"})
                break

            message = await websocket.receive_json()
            mtype = str(message.get("type") or "")

            if mtype == "cancel":
                break

            if mode == "asr":
                assert asr is not None
                if mtype == "audio.append":
                    encoded = message.get("audio")
                    if not isinstance(encoded, str):
                        continue
                    pcm = base64.b64decode(encoded)
                    audio_bytes += len(pcm)
                    if audio_bytes > settings.max_audio_bytes:
                        await _send_json(
                            websocket,
                            {"type": "error", "message": "Audio exceeds size limit"},
                        )
                        break
                    await asr.append_pcm(pcm)
                elif mtype == "commit":
                    await asr.commit()
                elif mtype == "finish":
                    text = await asr.finish()
                    if text:
                        await _send_json(
                            websocket,
                            {"type": "transcript.final", "text": text},
                        )
                    await _send_json(websocket, {"type": "finished", "mode": "asr"})
                    break
                else:
                    await _send_json(
                        websocket,
                        {"type": "error", "message": f"Unknown ASR event: {mtype}"},
                    )
            else:
                assert tts is not None
                if mtype == "text.append":
                    text = str(message.get("text") or "")
                    text_chars += len(text)
                    if text_chars > settings.max_text_chars:
                        await _send_json(
                            websocket,
                            {"type": "error", "message": "Text exceeds size limit"},
                        )
                        break
                    await tts.append_text(text)
                elif mtype == "finish":
                    await tts.finish()
                    await _send_json(
                        websocket,
                        {
                            "type": "audio.done",
                            "sampleRate": 24000,
                            "format": "pcm_s16le",
                        },
                    )
                    await _send_json(websocket, {"type": "finished", "mode": "tts"})
                    break
                else:
                    await _send_json(
                        websocket,
                        {"type": "error", "message": f"Unknown TTS event: {mtype}"},
                    )
    except WebSocketDisconnect:
        logger.info("Browser disconnected mode=%s", mode)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Voice WS failed")
        try:
            await _send_json(websocket, {"type": "error", "message": str(exc) or "Voice failed"})
        except Exception:  # noqa: BLE001
            pass
    finally:
        closed = True
        if asr:
            await asr.close()
        if tts:
            await tts.close()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


@app.websocket("/ws")
async def voice_ws_short(
    websocket: WebSocket,
    token: str = Query(default=""),
) -> None:
    await _voice_ws_handler(websocket, token)


@app.websocket("/api/hermes/voice/ws")
async def voice_ws_public(
    websocket: WebSocket,
    token: str = Query(default=""),
) -> None:
    await _voice_ws_handler(websocket, token)

