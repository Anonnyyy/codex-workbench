"""Exercise remote parsing without starting SSH, IPC or the polling loop."""
import ast
import datetime
import json
import pathlib
import tempfile
import time
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'server/remote_snapshot.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
functions = ast.Module(body=[node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name in ('millis', 'events')], type_ignores=[])


class RemoteMetadataTest(unittest.TestCase):
    def test_question_outputs_clear_only_the_matching_answer(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve()
            scope = dict(pathlib=pathlib, datetime=datetime, json=json, time=time, home=home, cache={})
            exec(compile(functions, str(source), 'exec'), scope)
            path = home / 'question.jsonl'
            now = datetime.datetime.now(datetime.timezone.utc)
            def record(payload, seconds):
                return dict(type='response_item', timestamp=(now+datetime.timedelta(seconds=seconds)).isoformat(), payload=payload)
            for name in ('request_user_input', 'functions.request_user_input_async'):
                scope['cache'].clear()
                records = [record(dict(type='function_call', name=name, call_id='q'), 0),
                           record(dict(type='function_call_output', call_id='other', output='{}'), 1)]
                if name.endswith('_async'):
                    records.append(record(dict(type='function_call_output', call_id='q', output='{"accepted":true}'), 2))
                path.write_text('\n'.join(map(json.dumps, records)), encoding='utf8')
                self.assertEqual(scope['events'](str(path))['attentionKind'], 'question')
                records.append(record(dict(type='function_call_output', call_id='q', output='{"answers":{}}'), 3))
                path.write_text('\n'.join(map(json.dumps, records)), encoding='utf8')
                result = scope['events'](str(path))
                self.assertIsNone(result['attentionKind'])
                self.assertEqual(result['state'], 'running')
                records.append(record(dict(type='reasoning'), 4))
                path.write_text('\n'.join(map(json.dumps, records)), encoding='utf8')
                self.assertIsNone(scope['events'](str(path))['attentionKind'])

    def test_capacity_failure_is_not_completed_and_next_turn_clears_error(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve()
            scope = dict(pathlib=pathlib, datetime=datetime, json=json, time=time, home=home, cache={})
            exec(compile(functions, str(source), 'exec'), scope)
            path = home / 'task.jsonl'
            failure = dict(type='event_msg', timestamp='2026-10-19T08:26:33Z', payload=dict(type='task_complete', turn_id='failed', error=dict(message='Selected model is at capacity.', codex_error_info='server_overloaded')))
            path.write_text(json.dumps(failure), encoding='utf8')
            result = scope['events'](str(path))
            self.assertEqual(result['state'], 'attention')
            self.assertIsNone(result['attentionKind'])
            self.assertEqual(result['turnStatus'], 'failed')
            self.assertEqual(result['turnId'], 'failed')
            start = dict(type='event_msg', timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(), payload=dict(type='task_started', turn_id='retry'))
            path.write_text(json.dumps(failure)+'\n'+json.dumps(start), encoding='utf8')
            result = scope['events'](str(path))
            self.assertEqual(result['turnStatus'], 'inProgress')
            self.assertIsNone(result['turnError'])

    def test_start_and_confirmation_request_advance_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve()
            scope = dict(pathlib=pathlib, datetime=datetime, json=json, time=time, home=home, cache={})
            exec(compile(functions, str(source), 'exec'), scope)
            path = home / 'task.jsonl'
            start, reply, attention = ('2026-10-16T06:50:00Z',
                '2026-10-16T06:51:05Z', '2026-10-16T06:53:21Z')
            records = [dict(type='event_msg', timestamp=start, payload=dict(type='task_started')),
                dict(type='response_item', timestamp=reply, payload=dict(type='message',
                    role='assistant', phase='final', content=[dict(type='output_text', text='done')])),
                dict(type='event_msg', timestamp=attention, payload=dict(type='request_user_input'))]
            path.write_text(json.dumps(records[0]), encoding='utf-8')
            self.assertEqual(scope['events'](str(path))['revision'], start)
            path.write_text('\n'.join(map(json.dumps, records)), encoding='utf-8')
            result = scope['events'](str(path))
            self.assertEqual(result['revision'], attention)
            self.assertEqual(result['state'], 'attention')
            self.assertEqual(result['attentionKind'], 'question')

    def test_async_question_survives_completion_until_user_answers(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve()
            scope = dict(pathlib=pathlib, datetime=datetime, json=json, time=time, home=home, cache={})
            exec(compile(functions, str(source), 'exec'), scope)
            path = home / 'task.jsonl'
            now = datetime.datetime.now(datetime.timezone.utc)
            stamp = lambda seconds: (now + datetime.timedelta(seconds=seconds)).isoformat()
            records = [dict(type='response_item', timestamp=stamp(0), payload=dict(type='function_call', name='functions.request_user_input_async')),
                dict(type='event_msg', timestamp=stamp(1), payload=dict(type='task_complete', error=None))]
            path.write_text('\n'.join(map(json.dumps, records)), encoding='utf-8')
            result = scope['events'](str(path))
            self.assertEqual((result['state'], result['attentionKind']), ('attention','question'))
            records.append(dict(type='event_msg', timestamp=stamp(2), payload=dict(type='user_message')))
            path.write_text('\n'.join(map(json.dumps, records)), encoding='utf-8')
            self.assertIsNone(scope['events'](str(path))['attentionKind'])
            records.append(dict(type='event_msg', timestamp=stamp(3), payload=dict(type='token_count')))
            path.write_text('\n'.join(map(json.dumps, records)), encoding='utf-8')
            self.assertIsNone(scope['events'](str(path))['attentionKind'])

    def test_source_survives_large_tail_and_cached_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve()
            scope = dict(pathlib=pathlib, datetime=datetime, json=json, time=time, home=home, cache={})
            exec(compile(functions, str(source), 'exec'), scope)
            for name, origin, expected, thread_source in (
                ('agent', {'subagent': {'thread_spawn': {'parent_thread_id': 'owner'}}}, 'subagent', 'subagent'),
                ('review', {'subagent': {'other': 'guardian'}}, 'subagent', 'guardian_review'),
                ('fork', 'vscode', 'conversation', 'user'),
            ):
                path = home / (name + '.jsonl')
                records = [dict(type='session_meta', payload=dict(source=origin, thread_source=thread_source,
                    parent_thread_id='owner', forked_from_id='history', padding='x' * 160000)),
                    dict(type='session_meta', payload=dict(source='vscode')),
                    dict(type='tool_result', payload=dict(text='x' * 900000)),
                    dict(type='response_item', timestamp='2026-09-23T05:00:00Z',
                         payload=dict(type='message', role='assistant', phase='final',
                                      content=[dict(type='output_text', text='done')]))]
                path.write_text('\n'.join(map(json.dumps, records)), encoding='utf-8')
                result = scope['events'](str(path))
                self.assertEqual(result['threadKind'], expected)
                self.assertEqual(result['parentId'], 'history' if name == 'fork' else 'owner')
                self.assertEqual(result['messages'][-1]['text'], 'done')
                self.assertEqual(scope['events'](str(path)), result)


if __name__ == '__main__':
    unittest.main()
