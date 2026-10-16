import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { QuestionBroker } from './tools.ts';
import { validateToolNames } from './protocol.ts';

test('native Pi session retains conversation and identity when reopened from disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-session-test-'));
  try {
    const path = join(directory, 'quest.jsonl');
    const first = SessionManager.open(path, undefined, directory);
    first.appendMessage({ role: 'user', content: 'Remember copper-otter.', timestamp: Date.now() });
    const second = SessionManager.open(path, undefined, directory);
    assert.equal(second.getSessionId(), first.getSessionId());
    assert.equal(second.getSessionFile(), path);
    second.appendMessage({ role: 'user', content: 'Continue the same quest.', timestamp: Date.now() });
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.filter((entry) => entry.type === 'session').length, 1);
    assert.equal(entries.filter((entry) => entry.type === 'message').length, 2);
    assert.ok(second.getEntries().some((entry) => entry.type === 'message' && entry.message.role === 'user'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('question broker delivers exact answers and releases interrupted questions', async () => {
  const events: unknown[] = [];
  const broker = new QuestionBroker((event) => events.push(event));
  const tool = broker.tool();
  const answer = tool.execute('question-1', { question: 'Which branch?' }, undefined, undefined, {} as any);
  assert.equal(events.length, 1);
  assert.equal(broker.pending.size, 1);
  broker.answer('question-1', 'Use feature/redwood.');
  assert.deepEqual((await answer).content, [{ type: 'text', text: 'Use feature/redwood.' }]);
  assert.equal(broker.pending.size, 0);
  const interrupted = tool.execute('question-2', { question: 'Continue?' }, undefined, undefined, {} as any);
  broker.abort();
  await assert.rejects(interrupted, /interrupted/);
  assert.equal(broker.pending.size, 0);
});

test('worker tool allowlist rejects patterns and unknown capabilities', () => {
  assert.deepEqual(validateToolNames(['read', 'read', 'ls']), ['read', 'ls']);
  assert.deepEqual(validateToolNames([]), []);
  assert.throws(() => validateToolNames(['*']), /Unsupported/);
  assert.throws(() => validateToolNames(['create_quest']), /Unsupported/);
});
