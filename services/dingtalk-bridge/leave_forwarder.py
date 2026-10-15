#!/usr/bin/env python3
"""Future-event-only leave notices. Stdlib; no subscription or send on import.

Send/readback schema adapters were verified against live DWS output on
2026-10-14: send is a two-step flow (async openTaskId, then
+messages-query-send-status for the real openMessageId); mget readback has
no receiver field, so verification is senderId == self + whitespace-
normalized exact text. The flattened event ENVELOPE is verified live
(top-level `type` = event key, snake_case fields); OA-specific flattened
field names stay fail-closed until the first real approval event.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import uuid

EVENTS = ('user_oa_approval_task_created', 'user_oa_approval_instance_cc')
DATE_FIELDS = {'开始时间', '结束时间', '开始日期', '结束日期', '请假开始时间',
               '请假结束时间', '请假日期', 'Start date', 'End date'}
LEAVE_TYPES = {'事假', '病假', '年假', '调休', '婚假', '产假', '陪产假', '丧假',
               '育儿假', '其他', '因私请假', '因病请假'}
DATE_VALUE = re.compile(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?(?:\s*(?:至|~|—)\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)?')


class SafeError(Exception):
    """Only constant, non-PII error codes may be passed here."""


def valid_string(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 512 and not any(ord(c) < 32 for c in value)


def load_config(path):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise SafeError('config_unreadable') from None
    if not isinstance(data, dict):
        raise SafeError('config_invalid')
    for key in ('profile', 'self_open_id', 'state_path'):
        if not valid_string(data.get(key)):
            raise SafeError('config_missing_required_field')
    if not Path(data['state_path']).is_absolute():
        raise SafeError('state_path_must_be_absolute')
    if 'dws_path' in data and not valid_string(data['dws_path']):
        raise SafeError('dws_path_invalid')
    codes = data.get('leave_process_codes')
    people = data.get('applicants')
    if not isinstance(codes, list) or not codes or not all(valid_string(c) for c in codes) or len(set(codes)) != len(codes):
        raise SafeError('process_codes_invalid')
    if not isinstance(people, list) or not people:
        raise SafeError('applicants_invalid')
    users, opens = set(), set()
    for p in people:
        if not isinstance(p, dict) or not all(valid_string(p.get(k)) for k in ('user_id', 'open_id', 'name', 'kind')):
            raise SafeError('applicant_unresolved')
        if p['kind'] not in ('direct_report', 'student') or p['user_id'] in users or p['open_id'] in opens:
            raise SafeError('applicant_invalid_or_duplicate')
        users.add(p['user_id'])
        opens.add(p['open_id'])
    return data


def detail_object(payload):
    if not isinstance(payload, dict) or payload.get('success') is False:
        raise SafeError('detail_schema_invalid')
    obj = payload.get('result', payload)
    if not isinstance(obj, dict):
        raise SafeError('detail_schema_invalid')
    originator = obj.get('originatorUserid', obj.get('originatorUserId'))
    forms = obj.get('formValueVOS', obj.get('formComponentValues'))
    if not valid_string(originator) or not isinstance(forms, list):
        raise SafeError('detail_schema_invalid')
    if ('originatorUserid' in obj and 'originatorUserId' in obj and obj['originatorUserid'] != obj['originatorUserId']):
        raise SafeError('detail_identity_conflict')
    if not all(isinstance(f, dict) and isinstance(f.get('name'), str) and 'value' in f for f in forms):
        raise SafeError('detail_schema_invalid')
    return {**obj, 'originatorUserId': originator, 'formComponentValues': forms}


def make_notice(config, instance, detail):
    person = next((p for p in config['applicants'] if p['user_id'] == detail['originatorUserId']), None)
    if person is None:
        return None
    # Raw approval titles can contain medical/reason text: never copy them.
    lines = ['请假申请', '申请人：' + person['name'],
             '类别：' + ('直属同事' if person['kind'] == 'direct_report' else 'AI班学生')]
    for field in detail['formComponentValues']:
        name, value = field['name'], field['value']
        if field.get('componentType') == 'DDHolidayField' and name == '["开始时间","结束时间"]' and isinstance(value, str):
            try:
                dates = json.loads(value)
            except ValueError:
                dates = None
            # Verified staff schema: first two values are dates; remaining
            # fields include leave type/private metadata and must not be copied.
            if isinstance(dates, list) and len(dates) >= 2 and all(
                isinstance(v, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}(?: (?:上午|下午|\d{2}:\d{2}))?', v)
                for v in dates[:2]
            ):
                lines.extend(['开始时间：' + dates[0], '结束时间：' + dates[1]])
        elif name in DATE_FIELDS and isinstance(value, str) and DATE_VALUE.fullmatch(value):
            lines.append(name + '：' + value)
        elif name in ('请假类型', '假期类型') and isinstance(value, str) and value in LEAVE_TYPES:
            lines.append('请假类型：' + value)
    lines.append('审批实例：' + instance)
    # URLs omitted until a concrete, verified link field/host contract exists.
    return '\n'.join(lines)


def task_id(payload):
    """Async openTaskId from a real +messages-send output (2026-10-14):
    {identity, ok, result:{result:{openTaskId}, success}, sendReceipt:{openTaskId}}.
    No openMessageId exists at this stage; conflicting IDs fail closed."""
    if not isinstance(payload, dict):
        return None
    if payload.get('success') is False or payload.get('ok') is False:
        return None
    result = payload.get('result')
    candidates = set()
    for obj in (payload.get('sendReceipt'), result,
                result.get('result') if isinstance(result, dict) else None):
        if isinstance(obj, dict) and valid_string(obj.get('openTaskId')):
            candidates.add(obj['openTaskId'])
    return next(iter(candidates)) if len(candidates) == 1 else None


def sent_message_id(payload):
    """Real openMessageId from a +messages-query-send-status output
    (verified 2026-10-14: result.openMessageId + result.sendStatus, plus a
    messageRef mirror). Non-SUCCESS status or conflicting IDs fail closed."""
    if not isinstance(payload, dict):
        return None
    if payload.get('success') is False or payload.get('ok') is False:
        return None
    result = payload.get('result')
    obj = result if isinstance(result, dict) else payload
    status = obj.get('sendStatus')
    if status is not None and status != 'SUCCESS':
        return None
    ref = payload.get('messageRef')
    candidates = set()
    for source in (obj, ref if isinstance(ref, dict) else None):
        if isinstance(source, dict) and valid_string(source.get('openMessageId')):
            candidates.add(source['openMessageId'])
    return next(iter(candidates)) if len(candidates) == 1 else None


def normalized_text(text):
    """DingTalk stores message text with newlines collapsed to spaces
    (live-verified 2026-10-14); compare whitespace-normalized."""
    return ' '.join(str(text).split())


def verified_message(payload, mid, text, self_id):
    """Verified readback for +messages-mget (real shape, 2026-10-14):
    top-level messages[] with messageId and space-joined text, and NO
    receiver field — so the row is verified as our own self-send via
    senderId == self_id (receiverOpenDingTalkId is still honored when a
    future API shape provides it). Unknown shape = False = uncertain."""
    if not isinstance(payload, dict):
        return False
    if payload.get('success') is False or payload.get('ok') is False:
        return False
    obj = payload.get('result', payload)
    messages = obj.get('messages') if isinstance(obj, dict) else obj
    if not isinstance(messages, list):
        return False
    matches = [m for m in messages if isinstance(m, dict) and m.get('openMessageId', m.get('messageId')) == mid]
    if len(matches) != 1:
        return False
    row = matches[0]
    if normalized_text(row.get('text')) != normalized_text(text):
        return False
    receiver = row.get('receiverOpenDingTalkId')
    if receiver is not None and receiver != self_id:
        return False
    return row.get('senderId', row.get('sender_open_dingtalk_id')) == self_id


class Dws:
    def __init__(self, config, stop):
        self.config, self.stop = config, stop

    def command(self, args):
        return [self.config.get('dws_path', os.environ.get('DWS_PATH', 'dws')), *args, '--profile', self.config['profile']]

    def run(self, args, timeout=45.0):
        if self.stop.is_set():
            raise SafeError('stopping')
        try:
            child = subprocess.Popen(self.command(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError:
            raise SafeError('dws_spawn_failed') from None
        deadline = time.monotonic() + timeout
        try:
            while True:
                if self.stop.is_set():
                    raise SafeError('stopping')
                if time.monotonic() >= deadline:
                    raise SafeError('dws_timeout')
                try:
                    out, _ = child.communicate(timeout=min(0.2, max(0.01, deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    continue
            if child.returncode != 0:
                raise SafeError('dws_command_failed')
            try:
                return json.loads(out)
            except (ValueError, UnicodeError):
                raise SafeError('dws_json_invalid') from None
        finally:
            terminate(child)

    def detail(self, instance):
        return detail_object(self.run(['oa', 'approval', 'detail', '--instance-id', instance, '--format', 'json']))


def terminate(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            # Do not SIGKILL: DWS must retain the opportunity to unsubscribe.
            raise SafeError('child_cleanup_timeout') from None
    for stream in (child.stdout, child.stderr):
        if stream:
            stream.close()


class State:
    def __init__(self, path):
        path = Path(path)
        if path.parent.is_symlink() or path.is_symlink():
            raise SafeError('unsafe_state_path')
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if stat.S_IMODE(path.parent.stat().st_mode) != 0o700:
            raise SafeError('state_directory_must_be_0700')
        self.fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.fchmod(self.fd, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            raise SafeError('already_running') from None
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS notices (instance TEXT PRIMARY KEY, state TEXT NOT NULL, notice TEXT, idem TEXT, message_id TEXT, error TEXT)')
        self.db.commit()

    def get(self, instance):
        return self.db.execute('SELECT state,notice,idem,message_id FROM notices WHERE instance=?', (instance,)).fetchone()

    def insert(self, instance, state, notice=None, idem=None, error=None):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO notices(instance,state,notice,idem,error) VALUES (?,?,?,?,?)', (instance, state, notice, idem, error))

    def update(self, instance, state, mid=None, error=None):
        with self.db:
            self.db.execute('UPDATE notices SET state=?,message_id=COALESCE(?,message_id),error=? WHERE instance=?', (state, mid, error, instance))

    def close(self):
        self.db.close()
        os.close(self.fd)


class Forwarder:
    def __init__(self, config, state, dws, stop):
        self.config, self.state, self.dws, self.stop = config, state, dws, stop

    def handle(self, event):
        if not isinstance(event, dict) or event.get('type') not in EVENTS:
            return 'invalid_event'
        instance = event.get('process_instance_id')
        code = event.get('process_code')
        if not valid_string(instance) or code not in self.config['leave_process_codes']:
            # Template codes are constant identifiers, not PII: surface unknown
            # codes so a student-side leave template can be discovered and
            # pinned instead of silently no-oping.
            print('leave_forwarder: not_leave process_code=%s' % (code if valid_string(code) else '-'), file=sys.stderr, flush=True)
            return 'not_leave'
        old = self.state.get(instance)
        if old and old[0] != 'pending':
            return old[0]
        if not old:
            try:
                detail = self.dws.detail(instance)
                if 'processCode' in detail and detail['processCode'] != event['process_code']:
                    raise SafeError('detail_process_mismatch')
                if 'processInstanceId' in detail and detail['processInstanceId'] != instance:
                    raise SafeError('detail_instance_mismatch')
                notice = make_notice(self.config, instance, detail)
            except SafeError as exc:
                self.state.insert(instance, 'error', error=str(exc))
                return 'error'
            if notice is None:
                self.state.insert(instance, 'filtered')
                return 'filtered'
            idem = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([self.config['profile'], self.config['self_open_id'], instance], ensure_ascii=True)))
            self.state.insert(instance, 'pending', notice, idem)
            old = self.state.get(instance)
        if self.stop.is_set():
            return 'pending'
        _, notice, idem, _ = old
        # Commit uncertainty BEFORE invoking the write. Crash/restart never resends.
        self.state.update(instance, 'uncertain', error='delivery_not_verified')
        try:
            # Verified two-step flow (2026-10-14): +messages-send returns an
            # async openTaskId; the real openMessageId comes from
            # +messages-query-send-status once sendStatus is SUCCESS.
            sent = self.dws.run(['chat', '+messages-send', '--as', 'user', '--open-dingtalk-id', self.config['self_open_id'], '--text', notice, '--idempotency-key', idem, '--yes', '--format', 'json'])
            task = task_id(sent)
            if task is None:
                raise SafeError('send_id_unknown')
            status = self.dws.run(['chat', '+messages-query-send-status', '--open-task-id', task, '--format', 'json'])
            mid = sent_message_id(status)
            if mid is None:
                raise SafeError('send_status_unknown')
            self.state.update(instance, 'uncertain', mid, 'verification_pending')
            got = self.dws.run(['chat', '+messages-mget', '--msg-ids', mid, '--format', 'json'])
            if not verified_message(got, mid, notice, self.config['self_open_id']):
                raise SafeError('verification_unknown_or_mismatch')
            self.state.update(instance, 'sent', mid)
            return 'sent'
        except SafeError as exc:
            self.state.update(instance, 'uncertain', error=str(exc))
            return 'uncertain'


def consume(config, forwarder, stop, ready_timeout=60.0):
    """One subscription attempt. Read both pipes; never replay raw stderr."""
    try:
        child = subprocess.Popen(forwarder.dws.command(['event', 'consume', *EVENTS, '--flatten', '-f', 'ndjson']), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        raise SafeError('subscription_spawn_failed') from None
    ready, buffered = False, []
    buffers = {'out': b'', 'err': b''}
    deadline = time.monotonic() + ready_timeout
    selector = selectors.DefaultSelector()
    assert child.stdout is not None and child.stderr is not None
    selector.register(child.stdout.fileno(), selectors.EVENT_READ, 'out')
    selector.register(child.stderr.fileno(), selectors.EVENT_READ, 'err')
    try:
        while not stop.is_set():
            if not ready and time.monotonic() > deadline:
                raise SafeError('subscription_ready_timeout')
            for key, _ in selector.select(0.2):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                kind = key.data
                buffers[kind] += chunk
                if len(buffers[kind]) > 1024 * 1024:
                    raise SafeError('stream_line_too_large')
                while b'\n' in buffers[kind]:
                    line, buffers[kind] = buffers[kind].split(b'\n', 1)
                    if kind == 'err':
                        if b'[event] ready' in line and not ready:
                            ready = True
                            print('leave_forwarder: ready', file=sys.stderr, flush=True)
                            for event in buffered:
                                print('leave_forwarder: ' + forwarder.handle(event), file=sys.stderr, flush=True)
                            buffered.clear()
                        elif b'[event] error' in line or b'[event] failed' in line:
                            raise SafeError('subscription_failed')
                    else:
                        try:
                            event = json.loads(line)
                        except (ValueError, UnicodeError):
                            print('leave_forwarder: invalid_event_json', file=sys.stderr, flush=True)
                            continue
                        if ready:
                            print('leave_forwarder: ' + forwarder.handle(event), file=sys.stderr, flush=True)
                        else:
                            buffered.append(event)
                            if len(buffered) > 100:
                                raise SafeError('pre_ready_buffer_exceeded')
            if child.poll() is not None and not selector.get_map():
                raise SafeError('subscription_ended')
    finally:
        selector.close()
        terminate(child)


def status(path):
    if not Path(path).exists():
        return {'states': {}, 'total': 0}
    uri = Path(path).as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as db:
        counts = dict(db.execute('SELECT state,COUNT(*) FROM notices GROUP BY state'))
    return {'states': counts, 'total': sum(counts.values())}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--status', action='store_true')
    modes.add_argument('--preview-instance')
    args = parser.parse_args(argv)
    stop = threading.Event()
    state = None
    try:
        config = load_config(args.config)
        if args.check:
            print(json.dumps({'valid': True, 'applicants': len(config['applicants']), 'process_codes': len(config['leave_process_codes'])}))
            return 0
        if args.status:
            print(json.dumps(status(config['state_path'])))
            return 0
        dws = Dws(config, stop)
        if args.preview_instance:
            if not valid_string(args.preview_instance):
                raise SafeError('instance_invalid')
            detail = dws.detail(args.preview_instance)
            if detail.get('processCode') not in config['leave_process_codes']:
                print(json.dumps({'result': 'not_leave_or_process_code_missing'}))
            else:
                notice = make_notice(config, args.preview_instance, detail)
                print(json.dumps({'result': 'match' if notice else 'filtered', 'notice': notice}, ensure_ascii=False))
            return 0
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        # Restrict SQLite rollback journals as well as the main database.
        os.umask(0o077)
        state = State(config['state_path'])
        consume(config, Forwarder(config, state, dws, stop), stop)
        return 0
    except SafeError as exc:
        print('leave_forwarder: ' + str(exc), file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error, ValueError):
        print('leave_forwarder: local_io_or_state_error', file=sys.stderr)
        return 1
    finally:
        if state:
            state.close()


if __name__ == '__main__':
    sys.exit(main())
