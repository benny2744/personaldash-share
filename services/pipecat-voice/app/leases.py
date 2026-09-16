"""HMAC voice lease tokens shared with PersonalDash."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any


class LeaseError(ValueError):
    """Raised when a lease token is missing, expired, or forged."""


@dataclass(frozen=True)
class VoiceLease:
    mode: str
    exp: int
    jti: str
    iat: int
    raw: dict[str, Any]


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def create_lease(
    *,
    secret: str,
    mode: str,
    ttl_seconds: int,
    jti: str,
    now: int | None = None,
) -> str:
    if mode not in {"asr", "tts"}:
        raise LeaseError("mode must be asr or tts")
    if not secret:
        raise LeaseError("VOICE_LEASE_SECRET is not configured")
    issued = int(now if now is not None else time.time())
    payload = {
        "v": 1,
        "mode": mode,
        "iat": issued,
        "exp": issued + int(ttl_seconds),
        "jti": jti,
    }
    body = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    sig = _b64url_encode(
        hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{body}.{sig}"


def verify_lease(
    token: str,
    *,
    secret: str,
    expected_mode: str | None = None,
    now: int | None = None,
) -> VoiceLease:
    if not secret:
        raise LeaseError("VOICE_LEASE_SECRET is not configured")
    if not token or "." not in token:
        raise LeaseError("Malformed lease token")

    body, sig = token.rsplit(".", 1)
    expected = _b64url_encode(
        hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected, sig):
        raise LeaseError("Invalid lease signature")

    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise LeaseError("Malformed lease payload") from exc

    mode = str(payload.get("mode") or "")
    if mode not in {"asr", "tts"}:
        raise LeaseError("Lease mode is invalid")
    if expected_mode and mode != expected_mode:
        raise LeaseError(f"Lease mode mismatch (wanted {expected_mode})")

    exp = int(payload.get("exp") or 0)
    iat = int(payload.get("iat") or 0)
    jti = str(payload.get("jti") or "")
    current = int(now if now is not None else time.time())
    if exp <= current:
        raise LeaseError("Lease expired")
    if not jti:
        raise LeaseError("Lease missing jti")

    return VoiceLease(mode=mode, exp=exp, jti=jti, iat=iat, raw=payload)