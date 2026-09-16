import unittest

from app.qwen_asr import QwenRealtimeAsrSession, preview_from_text_event


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


if __name__ == "__main__":
    unittest.main()
