import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/service/store.ts';
import type { Quest } from '../src/domain/types.ts';

test('quest, conversation, pending question and command survive a new database connection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guildmaster-store-'));
  let store = new Store(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const quest: Quest = {
    id: 'quest-1', title: 'A durable quest', objective: 'Remember this', kind: 'quest', status: 'awaiting_input',
    workspaceMode: 'none', workspacePath: dir, model: 'fake/test', tools: ['read'], instructions: '',
    createdAt: Date.now(), updatedAt: Date.now(), sessionPath: join(dir, 'session.jsonl'), runCount: 1,
  };
  store.transaction(() => {
    store.save(quest);
    store.message(quest.id, 'user', 'Remember amber owl.');
    store.request({ id: 'question-1', questId: quest.id, runId: 'run-1', question: 'Which color?', status: 'pending', createdAt: Date.now() });
    store.saveCommand('command-1', 'fingerprint', { questId: quest.id });
  });
  store.close();
  store = new Store(dir);
  assert.equal(store.get(quest.id)?.sessionPath, quest.sessionPath);
  assert.equal(store.messages(quest.id)[0].text, 'Remember amber owl.');
  assert.equal(store.requests(quest.id)[0].status, 'pending');
  assert.deepEqual(store.command('command-1'), { fingerprint: 'fingerprint', response: { questId: quest.id } });
});

test('a failed transaction cannot leave an acknowledged command without its conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guildmaster-store-'));
  const store = new Store(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.throws(() => store.transaction(() => {
    store.message('quest-1', 'user', 'This must roll back');
    store.saveCommand('command-1', 'fingerprint', { accepted: true });
    throw new Error('Simulated write failure');
  }), /Simulated write failure/);
  assert.deepEqual(store.messages('quest-1'), []);
  assert.equal(store.command('command-1'), undefined);
});
