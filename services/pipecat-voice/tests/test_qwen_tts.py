import asyncio
import json
import unittest
from unittest.mock import patch

from app.qwen_tts import (
    QwenRealtimeTtsSession,
    TTS_FRAGMENT_LIMIT,
    split_text_fragments,
    synthesize_text_once,
)


class _FakeUpstream:
    """Minimal async iterator standing in for the DashScope WebSocket."""

    def __init__(self, messages=(), error=None):
        self._messages = [json.dumps(m) for m in messages]
        self._error = error

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._messages:
            return self._messages.pop(0)
        if self._error is not None:
            raise self._error
        raise StopAsyncIteration


def _session(errors, messages=(), error=None):
    async def on_error(message):
        errors.append(message)

    session = QwenRealtimeTtsSession(
        api_key="test",
        ws_base="wss://example.invalid",
        model="qwen3-tts-instruct-flash-realtime",
        on_error=on_error,
    )
    session._ws = _FakeUpstream(messages=messages, error=error)
    return session


class ReadLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_clean_close_without_session_finished_reports_error(self):
        errors = []
        session = _session(errors)
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(errors, ["TTS connection closed by upstream"])
        self.assertTrue(session._upstream_failed)
        self.assertTrue(session._closed.is_set())

    async def test_clean_close_without_finish_raises_on_finish_call(self):
        errors = []
        session = _session(errors)
        await asyncio.wait_for(session._read_loop(), timeout=5)
        with self.assertRaisesRegex(RuntimeError, "closed by upstream"):
            await session.finish()

    async def test_clean_close_after_session_finished_is_silent(self):
        errors = []
        session = _session(errors, messages=[{"type": "session.finished"}])
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(errors, [])
        self.assertFalse(session._upstream_failed)
        self.assertTrue(session._session_finished)
        self.assertTrue(session._closed.is_set())

    async def test_abnormal_close_reports_error_once(self):
        errors = []
        session = _session(errors, error=RuntimeError("connection reset"))
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(len(errors), 1)
        self.assertIn("connection reset", errors[0])
        self.assertTrue(session._upstream_failed)

    async def test_error_event_reports_once_and_marks_failed(self):
        errors = []
        session = _session(
            errors, messages=[{"type": "error", "message": "boom"}]
        )
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(errors, ["boom"])
        self.assertTrue(session._upstream_failed)
        with self.assertRaisesRegex(RuntimeError, "boom"):
            await session.finish()


class _FakeRetrySession:
    instances = []
    finish_results = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.sample_rate = 24000
        type(self).instances.append(self)

    async def connect(self):
        pass

    async def append_text(self, text):
        pass

    async def finish(self):
        result = type(self).finish_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    async def close(self):
        pass


class SplitFragmentTests(unittest.IsolatedAsyncioTestCase):
    def test_short_text_is_single_fragment(self):
        self.assertEqual(split_text_fragments("你好"), ["你好"])
        self.assertEqual(split_text_fragments(""), [])

    def test_long_text_splits_on_sentence_boundaries(self):
        text = "第一句。第二句。" * 300
        fragments = split_text_fragments(text)
        self.assertGreater(len(fragments), 1)
        for fragment in fragments:
            self.assertLessEqual(len(fragment), TTS_FRAGMENT_LIMIT)
        self.assertEqual("".join(fragments), text)

    def test_long_text_hard_splits_without_separators(self):
        text = "a" * (TTS_FRAGMENT_LIMIT + 500)
        fragments = split_text_fragments(text)
        self.assertEqual("".join(fragments), text)
        for fragment in fragments:
            self.assertLessEqual(len(fragment), TTS_FRAGMENT_LIMIT)

    async def _append_frames(self, text):
        session = QwenRealtimeTtsSession(
            api_key="test",
            ws_base="wss://example.invalid",
            model="qwen3-tts-instruct-flash-realtime",
        )
        session._ws = _FakeUpstream()
        sent = []

        async def _record(payload):
            sent.append(payload)

        session._send = _record
        await session.append_text(text)
        return [p["text"] for p in sent if p.get("type") == "input_text_buffer.append"]

    async def test_append_text_splits_long_payload(self):
        text = "第一句。第二句。" * 300
        frames = await self._append_frames(text)
        self.assertGreater(len(frames), 1)
        for frame in frames:
            self.assertLessEqual(len(frame), TTS_FRAGMENT_LIMIT)
        self.assertEqual("".join(frames), text)

    async def test_append_text_single_frame_for_short_payload(self):
        frames = await self._append_frames("short")
        self.assertEqual(frames, ["short"])


class SynthesizeRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _FakeRetrySession.instances = []
        _FakeRetrySession.finish_results = []

    async def test_empty_audio_is_retried(self):
        _FakeRetrySession.finish_results = [b"", b"\x01\x02"]
        with patch("app.qwen_tts.QwenRealtimeTtsSession", _FakeRetrySession):
            wav = await synthesize_text_once(
                "hi", api_key="k", ws_base="wss://x", model="m"
            )
        self.assertEqual(len(_FakeRetrySession.instances), 2)
        self.assertTrue(wav.startswith(b"RIFF"))

    async def test_upstream_close_is_retried(self):
        _FakeRetrySession.finish_results = [
            RuntimeError("TTS connection closed by upstream"),
            b"\x01\x02",
        ]
        with patch("app.qwen_tts.QwenRealtimeTtsSession", _FakeRetrySession):
            wav = await synthesize_text_once(
                "hi", api_key="k", ws_base="wss://x", model="m"
            )
        self.assertEqual(len(_FakeRetrySession.instances), 2)
        self.assertTrue(wav.startswith(b"RIFF"))

    async def test_explicit_auth_error_is_not_retried(self):
        _FakeRetrySession.finish_results = [
            RuntimeError("Invalid API-key provided")
        ]
        with patch("app.qwen_tts.QwenRealtimeTtsSession", _FakeRetrySession):
            with self.assertRaisesRegex(RuntimeError, "Invalid API-key"):
                await synthesize_text_once(
                    "hi", api_key="k", ws_base="wss://x", model="m"
                )
        self.assertEqual(len(_FakeRetrySession.instances), 1)

    async def test_persistent_failure_raises_after_attempts(self):
        _FakeRetrySession.finish_results = [
            RuntimeError("TTS connection closed by upstream"),
            RuntimeError("TTS connection closed by upstream"),
        ]
        with patch("app.qwen_tts.QwenRealtimeTtsSession", _FakeRetrySession):
            with self.assertRaisesRegex(RuntimeError, "closed by upstream"):
                await synthesize_text_once(
                    "hi",
                    api_key="k",
                    ws_base="wss://x",
                    model="m",
                    attempts=2,
                )
        self.assertEqual(len(_FakeRetrySession.instances), 2)


if __name__ == "__main__":
    unittest.main()
