import asyncio
import json
import unittest

from app.qwen_asr import QwenRealtimeAsrSession, preview_from_text_event


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


class PreviewFromTextEventTests(unittest.TestCase):
    def test_stash_only_then_confirmed_plus_stash(self):
        # Official Qwen progression: stash carries the unconfirmed suffix.
        self.assertEqual(
            preview_from_text_event({"text": "", "stash": "The weather is"}),
            "The weather is",
        )
        self.assertEqual(
            preview_from_text_event(
                {"text": "The weather is nice today,", "stash": " sunny and"}
            ),
            "The weather is nice today, sunny and",
        )
        self.assertEqual(
            preview_from_text_event(
                {"text": "The weather is nice today, sunny and bright.", "stash": ""}
            ),
            "The weather is nice today, sunny and bright.",
        )

    def test_empty_and_whitespace_edges(self):
        self.assertEqual(preview_from_text_event({}), "")
        self.assertEqual(preview_from_text_event({"text": "  ", "stash": "  "}), "")
        self.assertEqual(
            preview_from_text_event({"text": "Hello ", "stash": " world"}),
            "Hello  world".strip(),
        )


class HandleEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_partial_uses_text_plus_stash_and_final_uses_transcript(self):
        seen: list[tuple[str, bool]] = []

        async def on_transcript(text: str, is_final: bool) -> None:
            seen.append((text, is_final))

        session = QwenRealtimeAsrSession(
            api_key="test",
            ws_base="wss://example.invalid",
            model="qwen3-asr-flash-realtime",
            on_transcript=on_transcript,
        )

        await session._handle_event(
            {
                "type": "conversation.item.input_audio_transcription.text",
                "text": "",
                "stash": "Beijing's",
            }
        )
        await session._handle_event(
            {
                "type": "conversation.item.input_audio_transcription.text",
                "text": "Beijing's",
                "stash": " weather",
            }
        )
        await session._handle_event(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "Beijing's weather is clear.",
            }
        )

        self.assertEqual(
            seen,
            [
                ("Beijing's", False),
                ("Beijing's weather", False),
                ("Beijing's weather is clear.", True),
            ],
        )
        self.assertEqual(session.final_text, "Beijing's weather is clear.")

    async def test_confirmed_only_text_without_stash_still_works(self):
        seen: list[str] = []

        async def on_transcript(text: str, is_final: bool) -> None:
            if not is_final:
                seen.append(text)

        session = QwenRealtimeAsrSession(
            api_key="test",
            ws_base="wss://example.invalid",
            model="qwen3-asr-flash-realtime",
            on_transcript=on_transcript,
        )
        await session._handle_event(
            {
                "type": "conversation.item.input_audio_transcription.text",
                "text": "Hello",
                "stash": "",
            }
        )
        self.assertEqual(seen, ["Hello"])


class ReadLoopTests(unittest.IsolatedAsyncioTestCase):
    def _session(self, errors):
        async def on_error(message):
            errors.append(message)

        session = QwenRealtimeAsrSession(
            api_key="test",
            ws_base="wss://example.invalid",
            model="qwen3-asr-flash-realtime",
            on_error=on_error,
        )
        return session

    async def test_clean_close_without_session_finished_reports_error(self):
        errors: list[str] = []
        session = self._session(errors)
        session._ws = _FakeUpstream()
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(len(errors), 1)
        self.assertIn("closed by upstream", errors[0])
        self.assertTrue(session._closed.is_set())

    async def test_clean_close_after_session_finished_is_silent(self):
        errors: list[str] = []
        session = self._session(errors)
        session._ws = _FakeUpstream(
            messages=[{"type": "session.finished"}]
        )
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(errors, [])
        self.assertTrue(session._closed.is_set())

    async def test_abnormal_close_reports_error_once(self):
        errors: list[str] = []
        session = self._session(errors)
        session._ws = _FakeUpstream(error=RuntimeError("connection reset"))
        await asyncio.wait_for(session._read_loop(), timeout=5)
        self.assertEqual(len(errors), 1)
        self.assertIn("connection reset", errors[0])
        self.assertTrue(session._closed.is_set())

    async def test_close_cancels_reader_without_error(self):
        errors: list[str] = []
        session = self._session(errors)

        class _NeverEnding:
            def __aiter__(self):
                return self

            async def __anext__(self):
                await asyncio.sleep(3600)

        session._ws = _NeverEnding()
        reader = asyncio.create_task(session._read_loop())
        await asyncio.sleep(0.05)
        await asyncio.wait_for(session.close(), timeout=5)
        self.assertEqual(errors, [])
        self.assertIsNone(session._reader)


if __name__ == "__main__":
    unittest.main()
