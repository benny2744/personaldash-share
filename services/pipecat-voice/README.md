# Qwen realtime voice sidecar

Authenticated media proxy that connects browsers to DashScope Qwen realtime ASR/TTS.

PersonalDash issues short-lived HMAC leases. This service never exposes `DASHSCOPE_API_KEY` to the browser and does not own Hermes sessions, tools, or history.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness + model config |
| `WS /ws?token=...` | Browser streaming ASR/TTS |
| `POST /v1/transcribe` | Internal one-shot PCM ASR |
| `POST /v1/speak` | Internal one-shot WAV TTS |

## Browser protocol

1. `POST /api/hermes/voice/lease` on PersonalDash with `{ "mode": "asr" | "tts" }`
2. Connect to `ws(s)://…/api/hermes/voice/ws?token=…`
3. Wait for `{ "type": "ready", … }`
4. ASR: stream `{ type: "audio.append", audio: base64pcm16 }` at 16 kHz, then `commit` / `finish`
   - Upstream Qwen `*.input_audio_transcription.text` events carry a confirmed prefix in `text` and a revisable suffix in `stash`. This sidecar forwards `text + stash` as `transcript.partial`.
   - `*.input_audio_transcription.completed` → `transcript` is forwarded as `transcript.final`.
5. TTS: send `{ type: "text.append", text }` then `finish`; play `audio.delta` PCM at 24 kHz

## Environment

- `DASHSCOPE_API_KEY` (required)
- `VOICE_LEASE_SECRET` (required, shared with PersonalDash)
- `QWEN_REALTIME_WS_BASE` (default China: `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`)
- `QWEN_ASR_REALTIME_MODEL` (default `qwen3-asr-flash-realtime`)
- `QWEN_TTS_REALTIME_MODEL` (default `qwen3-tts-flash-realtime`)
- `QWEN_TTS_VOICE` (default `Cherry`)

These adapters are intended for reuse by a later Pipecat WebRTC pipeline.