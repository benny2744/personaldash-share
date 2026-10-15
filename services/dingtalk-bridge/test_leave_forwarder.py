"""Offline tests: DWS is always fake; no credentials/network/subscriptions used."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

import leave_forwarder as lf


class FakeDws:
    def __init__(self, detail, send=None, status=None, verify=None):
        self.payload = detail
        # Real +messages-send output shape (live-verified 2026-10-14):
        # async task receipt, no message id yet.
        self.send = send if send is not None else {
            'identity': 'user', 'ok': True,
            'result': {'result': {'openTaskId': 'task-1'}, 'success': True},
            'sendReceipt': {'openTaskId': 'task-1'}}
        # Real +messages-query-send-status shape for the task above.
        self.status = status if status is not None else {
            'success': True,
            'result': {'openConversationId': 'cid', 'openMessageId': 'fake-mid', 'sendStatus': 'SUCCESS'},
            'messageRef': {'openConversationId': 'cid', 'openMessageId': 'fake-mid'}}
        self.verify = verify
        self.calls = []
        self.detail_calls = 0

    def detail(self, instance):
        self.detail_calls += 1
        if isinstance(self.payload, Exception):
            raise self.payload
        return lf.detail_object(self.payload)

    def run(self, args):
        self.calls.append(args)
        if args[1] == '+messages-send':
            if isinstance(self.send, Exception):
                raise self.send
            return self.send
        if args[1] == '+messages-query-send-status':
            if isinstance(self.status, Exception):
                raise self.status
            return self.status
        if isinstance(self.verify, Exception):
            raise self.verify
        if self.verify is not None:
            return self.verify
        # Real +messages-mget shape (live-verified 2026-10-14): top-level
        # messages[], messageId key, space-joined text, senderId, no receiver.
        sent = next(a for a in self.calls if a[1] == '+messages-send')
        text = sent[sent.index('--text') + 1]
        return {'complete': True, 'foundCount': 1, 'messages': [
            {'messageId': 'fake-mid', 'text': ' '.join(text.split()), 'senderId': 'self'}]}


class ForwarderTests(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get('TMPDIR', '/home/user/.hermes/cache/scratch')
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.root = Path(self.tmp.name)
        self.config = {'profile': 'school-test', 'self_open_id': 'self',
                       'state_path': str(self.root / 'private' / 'state.sqlite'),
                       'leave_process_codes': ['PINNED'],
                       'applicants': [{'user_id': 'staff-id', 'open_id': 'staff-open', 'name': 'Test Person', 'kind': 'direct_report'},
                                      {'user_id': 'student-id', 'open_id': 'student-open', 'name': 'Test Student', 'kind': 'student'}]}
        self.payload = {'success': True, 'result': {'originatorUserid': 'staff-id', 'processCode': 'PINNED', 'processInstanceId': 'instance',
            'processInstanceTitle': 'secret medical diagnosis', 'formValueVOS': [
                {'name': '开始时间', 'value': '2026-10-13 08:00'},
                {'name': '结束时间', 'value': '2026-10-14 17:00'},
                {'name': '请假类型', 'value': '事假'},
                {'name': '请假事由 Reason', 'value': 'secret diagnosis'},
                {'name': '附件', 'value': 'https://private.example/secret'}]}}
        self.event = {'type': lf.EVENTS[0], 'process_instance_id': 'instance', 'process_code': 'PINNED', 'event_id': 'one'}
        self.stop = threading.Event()
        self.state = lf.State(self.config['state_path'])
        self.fake = FakeDws(self.payload)
        self.forwarder = lf.Forwarder(self.config, self.state, self.fake, self.stop)

    def tearDown(self):
        self.state.close()
        self.tmp.cleanup()

    def test_success_exact_verification_and_uuid(self):
        self.assertEqual(self.forwarder.handle(self.event), 'sent')
        args = self.fake.calls[0]
        self.assertEqual(str(uuid.UUID(args[args.index('--idempotency-key') + 1])), self.state.get('instance')[2])
        self.assertIn('--as', args)
        self.assertIn('--yes', args)
        # Verified two-step send: send -> query-send-status -> mget.
        self.assertEqual(len(self.fake.calls), 3)
        self.assertEqual(self.fake.calls[1][1], '+messages-query-send-status')
        self.assertEqual(self.fake.calls[2][1], '+messages-mget')
        self.assertEqual(self.state.get('instance')[3], 'fake-mid')

    def test_unknown_applicant_and_parent_not_inferred(self):
        self.payload['result']['originatorUserid'] = 'parent-id'
        self.payload['result']['formValueVOS'].append({'name': '学生', 'value': 'student-id'})
        self.assertEqual(self.forwarder.handle(self.event), 'filtered')
        self.assertFalse(self.fake.calls)

    def test_not_leave_no_detail_fetch(self):
        self.event['process_code'] = 'OTHER'
        self.event['title'] = '请假'
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.forwarder.handle(self.event), 'not_leave')
        # Unknown template codes are surfaced (constant id, not PII).
        self.assertIn('process_code=OTHER', err.getvalue())
        self.assertEqual(self.fake.detail_calls, 0)

    def test_invalid_event_no_detail_fetch(self):
        for event in ({'data': '{}'}, [], {'type': 'user_oa_approval_instance_finished'}, None):
            self.assertEqual(self.forwarder.handle(event), 'invalid_event')
        self.assertEqual(self.fake.detail_calls, 0)

    def test_duplicate_across_events_and_restart(self):
        self.assertEqual(self.forwarder.handle(self.event), 'sent')
        self.event['type'] = lf.EVENTS[1]
        self.event['event_id'] = 'two'
        self.assertEqual(self.forwarder.handle(self.event), 'sent')
        self.state.close()
        self.state = lf.State(self.config['state_path'])
        forwarder = lf.Forwarder(self.config, self.state, self.fake, self.stop)
        self.assertEqual(forwarder.handle(self.event), 'sent')
        self.assertEqual(len(self.fake.calls), 3)
        self.assertEqual(self.fake.detail_calls, 1)

    def test_timeout_uncertain_no_retry_after_restart(self):
        self.fake.send = lf.SafeError('dws_timeout')
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.state.close()
        self.state = lf.State(self.config['state_path'])
        other = lf.Forwarder(self.config, self.state, self.fake, self.stop)
        self.assertEqual(other.handle(self.event), 'uncertain')
        self.assertEqual(len(self.fake.calls), 1)

    def test_send_unknown_id_no_resend(self):
        self.fake.send = {'success': True}
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.assertEqual(len(self.fake.calls), 1)

    def test_send_failure_is_uncertain(self):
        self.fake.send = lf.SafeError('dws_command_failed')
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.assertEqual(self.state.get('instance')[0], 'uncertain')

    def test_verification_mismatch_no_resend(self):
        self.fake.verify = {'complete': True, 'messages': [{'messageId': 'fake-mid', 'text': 'wrong', 'senderId': 'self'}]}
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.assertEqual(self.state.get('instance')[3], 'fake-mid')
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.assertEqual(len(self.fake.calls), 3)

    def test_privacy_minimization(self):
        self.payload['result']['formValueVOS'].extend([
            {'name': '开始时间', 'value': '2026-10-13 secret'},
            {'name': '请假类型', 'value': 'medical diagnosis'},
            {'name': '请假日期', 'value': {'secret': 'medical'}},
            {'name': '结束日期', 'value': '2026-10-14\nsecret'}])
        self.assertEqual(self.forwarder.handle(self.event), 'sent')
        notice = self.state.get('instance')[1]
        self.assertIn('2026-10-13 08:00', notice)
        self.assertIn('事假', notice)
        for forbidden in ('secret', 'medical', 'private', '附件', 'Reason'):
            self.assertNotIn(forbidden, notice)

    def test_verified_holiday_dates_omit_private_tail(self):
        self.payload['result']['formValueVOS'] = [{
            'name': '["开始时间","结束时间"]', 'componentType': 'DDHolidayField',
            'value': json.dumps(['2026-09-24 下午', '2026-09-24 下午', 0.5, 'halfDay', 'private leave type', '请假类型']),
            'extValue': 'private medical metadata'}]
        notice = lf.make_notice(self.config, 'instance', lf.detail_object(self.payload))
        assert isinstance(notice, str)
        self.assertIn('开始时间：2026-09-24 下午', notice)
        self.assertIn('结束时间：2026-09-24 下午', notice)
        self.assertNotIn('private', notice)
        self.assertNotIn('halfDay', notice)
        self.payload['result']['formValueVOS'][0]['value'] = '["2026-09-24 下午 private", "2026-09-24 下午"]'
        notice = lf.make_notice(self.config, 'instance', lf.detail_object(self.payload))
        assert isinstance(notice, str)
        self.assertNotIn('开始时间', notice)

    def test_real_schema_and_legacy_schema(self):
        real = lf.detail_object(self.payload)
        self.assertEqual(real['originatorUserId'], 'staff-id')
        legacy = {'result': {'originatorUserId': 'student-id', 'formComponentValues': []}}
        self.assertIn('AI班学生', lf.make_notice(self.config, 'instance', lf.detail_object(legacy)))

    def test_schema_missing_or_conflicting_identity(self):
        for payload in ({}, {'success': False}, {'result': {'originatorUserid': 'staff-id', 'formValueVOS': {}}},
                        {'result': {'originatorUserid': 'staff-id', 'originatorUserId': 'student-id', 'formValueVOS': []}}):
            with self.assertRaises(lf.SafeError):
                lf.detail_object(payload)

    def test_detail_mismatch_and_error_fail_closed(self):
        self.payload['result']['processCode'] = 'OTHER'
        self.assertEqual(self.forwarder.handle(self.event), 'error')
        self.assertFalse(self.fake.calls)

    def test_pending_on_shutdown_no_send(self):
        self.stop.set()
        self.assertEqual(self.forwarder.handle(self.event), 'pending')
        self.assertFalse(self.fake.calls)
        self.stop.clear()
        self.assertEqual(self.forwarder.handle(self.event), 'sent')
        self.assertEqual(self.fake.detail_calls, 1)

    def test_crash_boundary_precommitted_uncertain(self):
        class Crash(Exception):
            pass
        with patch.object(self.fake, 'run', side_effect=Crash):
            with self.assertRaises(Crash):
                self.forwarder.handle(self.event)
        self.assertEqual(self.state.get('instance')[0], 'uncertain')
        self.assertEqual(self.forwarder.handle(self.event), 'uncertain')
        self.assertFalse(self.fake.calls)

    def test_permissions_lock_and_status_no_pii(self):
        self.forwarder.handle(self.event)
        self.assertEqual(os.stat(self.config['state_path']).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(Path(self.config['state_path']).parent).st_mode & 0o777, 0o700)
        with self.assertRaisesRegex(lf.SafeError, 'already_running'):
            lf.State(self.config['state_path'])
        self.assertEqual(lf.status(self.config['state_path']), {'states': {'sent': 1}, 'total': 1})
        self.assertNotIn('Test', json.dumps(lf.status(self.config['state_path'])))

    def test_config_validation_check_no_dws(self):
        path = self.root / 'config.json'
        path.write_text(json.dumps(self.config))
        with patch.object(lf.subprocess, 'Popen', side_effect=AssertionError('real subprocess forbidden')):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(lf.main(['--config', str(path), '--check']), 0)
            self.assertTrue(json.loads(out.getvalue())['valid'])
        for field in ('user_id', 'open_id'):
            bad = copy.deepcopy(self.config)
            del bad['applicants'][0][field]
            path.write_text(json.dumps(bad))
            with self.assertRaises(lf.SafeError):
                lf.load_config(path)

    def test_preview_readonly_no_send(self):
        path = self.root / 'config.json'
        path.write_text(json.dumps(self.config))
        with patch.object(lf.Dws, 'detail', return_value=lf.detail_object(self.payload)), patch.object(lf.Dws, 'run', side_effect=AssertionError('send forbidden')):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(lf.main(['--config', str(path), '--preview-instance', 'instance']), 0)
        self.assertEqual(json.loads(out.getvalue())['result'], 'match')
        self.assertEqual(lf.status(self.config['state_path'])['total'], 0)

    def test_message_adapters_fail_closed(self):
        # task_id: real shape OK; conflicting task ids, ok:False, junk -> None.
        self.assertEqual(lf.task_id({'ok': True, 'result': {'result': {'openTaskId': 't'}}, 'sendReceipt': {'openTaskId': 't'}}), 't')
        self.assertIsNone(lf.task_id({'ok': True, 'sendReceipt': {'openTaskId': 'a'}, 'result': {'result': {'openTaskId': 'b'}}}))
        self.assertIsNone(lf.task_id({'ok': False, 'sendReceipt': {'openTaskId': 't'}}))
        self.assertIsNone(lf.task_id({'ok': True}))
        self.assertIsNone(lf.task_id([]))
        # sent_message_id: SUCCESS + single id; non-SUCCESS/conflicts -> None.
        self.assertEqual(lf.sent_message_id({'success': True, 'result': {'openMessageId': 'm', 'sendStatus': 'SUCCESS'}, 'messageRef': {'openMessageId': 'm'}}), 'm')
        self.assertIsNone(lf.sent_message_id({'success': True, 'result': {'openMessageId': 'm', 'sendStatus': 'PROCESSING'}}))
        self.assertIsNone(lf.sent_message_id({'success': True, 'result': {'openMessageId': 'm'}, 'messageRef': {'openMessageId': 'other'}}))
        # verified_message: unknown shape or missing sender identity -> False.
        self.assertFalse(lf.verified_message({'result': {'messages': [{'openMessageId': 'id', 'text': 'text'}]}}, 'id', 'text', 'self'))
        self.assertFalse(lf.verified_message({'messages': 'junk'}, 'id', 'text', 'self'))
        # Whitespace-normalized exact text; newline collapse matches live wire.
        self.assertTrue(lf.verified_message(
            {'messages': [{'messageId': 'id', 'text': 'a b  c', 'senderId': 'self'}]},
            'id', 'a\nb\tc', 'self'))
        # Wrong sender is not our self-send even with matching text.
        self.assertFalse(lf.verified_message(
            {'messages': [{'messageId': 'id', 'text': 'text', 'senderId': 'other'}]},
            'id', 'text', 'self'))
        # Legacy receiver field is honored when present and matching.
        self.assertTrue(lf.verified_message(
            {'messages': [{'messageId': 'id', 'text': 'text', 'senderId': 'self', 'receiverOpenDingTalkId': 'self'}]},
            'id', 'text', 'self'))

    def stream_child(self, script):
        # This runs only Python fake streams, never DWS.
        return subprocess.Popen([sys.executable, '-u', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_stream_waits_ready_and_cleans_child(self):
        script = "import sys,time\nprint(%r,flush=True)\ntime.sleep(.05)\nprint('[event] ready event_count=2',file=sys.stderr,flush=True)\ntime.sleep(30)" % json.dumps(self.event)
        child = self.stream_child(script)
        fake = lf.Dws(self.config, self.stop)
        forwarder = lf.Forwarder(self.config, self.state, fake, self.stop)
        def handle(event):
            self.stop.set()
            return 'filtered'
        with patch.object(lf.subprocess, 'Popen', return_value=child) as popen, patch.object(forwarder, 'handle', side_effect=handle) as handler:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                lf.consume(self.config, forwarder, self.stop)
        self.assertEqual(handler.call_count, 1)
        self.assertIn('ready', err.getvalue())
        self.assertEqual(child.returncode, -signal.SIGTERM)
        self.assertEqual(popen.call_count, 1)
        command = popen.call_args.args[0]
        self.assertEqual(command[-2:], ['--profile', 'school-test'])
        self.assertIn('--flatten', command)

    def test_subscription_failure_no_retry_no_raw_log(self):
        child = self.stream_child("import sys\nprint('private sensitive subscription failure',file=sys.stderr)\nsys.exit(1)")
        fake = lf.Dws(self.config, self.stop)
        forwarder = lf.Forwarder(self.config, self.state, fake, self.stop)
        with patch.object(lf.subprocess, 'Popen', return_value=child) as popen, patch.object(forwarder, 'handle') as handler:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                with self.assertRaises(lf.SafeError):
                    lf.consume(self.config, forwarder, self.stop, ready_timeout=2)
        self.assertEqual(popen.call_count, 1)
        self.assertFalse(handler.called)
        self.assertNotIn('private', err.getvalue())

    def test_ready_timeout_terminates_without_processing(self):
        child = self.stream_child("import time\ntime.sleep(30)")
        forwarder = lf.Forwarder(self.config, self.state, lf.Dws(self.config, self.stop), self.stop)
        with patch.object(lf.subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(lf.SafeError, 'subscription_ready_timeout'):
                lf.consume(self.config, forwarder, self.stop, ready_timeout=.05)
        self.assertEqual(child.returncode, -signal.SIGTERM)

    def test_main_sigterm_cleans_fake_subscription(self):
        config_path = self.root / 'config.json'
        config = {**self.config, 'state_path': str(self.root / 'runtime' / 'state.sqlite')}
        config_path.write_text(json.dumps(config))
        marker = self.root / 'child-cleaned'
        child_code = (
            "import signal,sys,time\n"
            "def stop(*args):\n"
            " open(%r, 'w').write('cleaned')\n"
            " sys.exit(0)\n"
            "signal.signal(signal.SIGTERM, stop)\n"
            "print('[event] ready event_count=2', file=sys.stderr, flush=True)\n"
            "while True: time.sleep(.1)\n" % str(marker)
        )
        harness = (
            "import sys; import leave_forwarder as lf; "
            "lf.Dws.command=lambda self,args: [sys.executable,'-u','-c',%r]; "
            "sys.exit(lf.main(['--config',%r]))" % (child_code, str(config_path))
        )
        process = subprocess.Popen([sys.executable, '-B', '-u', '-c', harness], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            import selectors
            with selectors.DefaultSelector() as selector:
                selector.register(process.stderr, selectors.EVENT_READ)
                self.assertTrue(selector.select(5), 'fake runtime did not become ready')
            self.assertIn(b'leave_forwarder: ready', process.stderr.readline())
            process.terminate()
            _, err = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, err)
            self.assertEqual(marker.read_text(), 'cleaned')
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=12)
            for pipe in (process.stdout, process.stderr):
                if pipe:
                    pipe.close()

    def test_command_timeout_graceful_cleanup(self):
        child = self.stream_child("import time\ntime.sleep(30)")
        with patch.object(lf.subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(lf.SafeError, 'dws_timeout'):
                lf.Dws(self.config, self.stop).run(['mock'], timeout=.05)
        self.assertEqual(child.returncode, -signal.SIGTERM)


if __name__ == '__main__':
    unittest.main()
