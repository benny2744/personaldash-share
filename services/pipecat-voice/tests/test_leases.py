import time
import unittest

from app.leases import LeaseError, create_lease, verify_lease


class LeaseTests(unittest.TestCase):
    def test_round_trip(self):
        token = create_lease(
            secret="test-secret",
            mode="asr",
            ttl_seconds=60,
            jti="abc",
            now=1_700_000_000,
        )
        lease = verify_lease(
            token,
            secret="test-secret",
            expected_mode="asr",
            now=1_700_000_010,
        )
        self.assertEqual(lease.mode, "asr")
        self.assertEqual(lease.jti, "abc")
        self.assertEqual(lease.exp, 1_700_000_060)

    def test_rejects_bad_signature_and_expiry(self):
        token = create_lease(
            secret="test-secret",
            mode="tts",
            ttl_seconds=1,
            jti="x",
            now=100,
        )
        with self.assertRaises(LeaseError):
            verify_lease(token + "x", secret="test-secret", now=100)
        with self.assertRaises(LeaseError):
            verify_lease(token, secret="test-secret", now=102)


if __name__ == "__main__":
    unittest.main()