"""Small PCM helpers for WAV wrapping and size accounting."""

from __future__ import annotations

import struct


def pcm16_to_wav(pcm: bytes, *, sample_rate: int = 24000, channels: int = 1) -> bytes:
    """Wrap little-endian PCM16 mono/stereo samples in a WAV container."""
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm


def estimate_pcm_seconds(pcm_bytes: int, *, sample_rate: int = 16000) -> float:
    if pcm_bytes <= 0:
        return 0.0
    return pcm_bytes / float(sample_rate * 2)