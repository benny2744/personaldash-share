import struct
import unittest

from app.pcm import estimate_pcm_seconds, pcm16_to_wav


class PcmTests(unittest.TestCase):
    def test_wav_header(self):
        pcm = struct.pack("<4h", 0, 1, -1, 100)
        wav = pcm16_to_wav(pcm, sample_rate=24000)
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(wav[8:12], b"WAVE")
        self.assertEqual(len(wav), 44 + len(pcm))
        self.assertAlmostEqual(estimate_pcm_seconds(32000, sample_rate=16000), 1.0)


if __name__ == "__main__":
    unittest.main()