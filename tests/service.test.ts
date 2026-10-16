import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';

const workerPath = fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-test-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  let store: Store;
  let service: QuestService;
  async function start() {
    const dataDir = join(directory, 'data');
    store = new Store(dataDir);
    service = new QuestService({ store, dataDir, workerPath, defaultWorkspace: workspace });
  }
  await start();
  const close = async () => { await service.close(); store.close(); };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  // Exercise real persistence and separate worker processes without needing a TCP listener.
  async function request(path: string, body?: any, expected = 200) {
    let value: any;
    let status = 200;
    try {
      const parts = path.split('/');
      if (path === '/api/guildmaster') value = await service.guildmaster(body);
      else if (path === '/api/quests') value = await service.create(body);
      else if (parts[2] === 'requests') value = await service.answer(parts[3], body);
      else if (!parts[4]) value = service.detail(parts[3]);
      else if (parts[4] === 'continue' || parts[4] === 'resume') value = await service.continue(parts[3], body, parts[4] === 'resume');
      else value = await service.action(parts[3], parts[4] as 'accept' | 'cancel' | 'archive' | 'restore', body);
    } catch (error: any) {
      status = error.status ?? 500;
      value = { error: error.message };
    }
    assert.equal(status, expected, JSON.stringify(value));
    return value;
  }
  async function state(id: string, predicate: (value: any) => boolean) {
    let last;
    for (let attempt = 0; attempt < 120; attempt++) {
      last = await request(`/api/quests/${id}`);
      if (predicate(last)) return last;
      await delay(50);
    }
    assert.fail(`Quest did not reach expected state: ${JSON.stringify(last)}`);
  }
  async function create(objective: string, extra: any = {}) {
    const value = await request('/api/quests', { objective, workspaceMode: 'none', commandId: crypto.randomUUID(), ...extra });
    return value.quest ?? value;
  }
  return {
    request, state, create, workspace, directory,
    service: () => service,
    restart: async () => { await close(); await start(); },
  };
}

test('feedback and reopening retain the same quest and disk session across worker processes', async t => {
  const f = await fixture(t);
  const quest = await f.create('Remember the secret phrase: amber owl.');
  const first = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.ok(first.quest.sessionPath);
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'What was the secret phrase?', commandId: 'feedback-1' });
  const second = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(second.quest.sessionPath, first.quest.sessionPath);
  const saved = JSON.parse(await readFile(first.quest.sessionPath, 'utf8'));
  assert.equal(saved.history.length, 2);
  assert.match(JSON.stringify(second.messages), /amber owl/);
  await f.request(`/api/quests/${quest.id}/accept`, { commandId: 'accept-1' });
  await f.state(quest.id, d => d.quest.status === 'accepted');
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'One more change, please.', commandId: 'reopen-1' });
  const reopened = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(reopened.quest.id, quest.id);
  assert.equal(reopened.quest.sessionPath, first.quest.sessionPath);
});

test('archive and restore persist independently of acceptance and retain the session and workspace', async t => {
  const f = await fixture(t);
  const quest = await f.create('[write] Remember the phrase: silver fern.', { tools: ['read', 'write'] });
  await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  await f.request(`/api/quests/${quest.id}/accept`, { commandId: 'accept-archive' });
  const before = f.service().detail(quest.id);
  const session = await readFile(before.quest.sessionPath, 'utf8');
  const archiveCommand = { commandId: 'archive-once' };
  const archived = await f.request(`/api/quests/${quest.id}/archive`, archiveCommand);
  assert.equal(archived.quest.status, 'accepted');
  assert.ok(archived.quest.archivedAt > 0);
  assert.equal(f.service().live.has(quest.id), false);
  await f.request(`/api/quests/${quest.id}/archive`, archiveCommand);
  await f.request(`/api/quests/${quest.id}/archive`, { commandId: 'archive-already-archived' });
  assert.equal(f.service().detail(quest.id).events.filter(e => e.type === 'archived').length, 1);
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'A hidden new run', commandId: 'archive-continue' }, 409);
  await f.request(`/api/quests/${quest.id}/resume`, { commandId: 'archive-resume' }, 409);
  await f.request(`/api/quests/${quest.id}/cancel`, { commandId: 'archive-cancel' }, 409);
  await f.restart();
  const persisted = f.service().detail(quest.id);
  assert.equal(persisted.quest.archivedAt, archived.quest.archivedAt);
  assert.equal(persisted.quest.status, 'accepted');
  assert.deepEqual(persisted.messages, before.messages);
  assert.equal(persisted.quest.result, before.quest.result);
  assert.equal(persisted.quest.workspacePath, before.quest.workspacePath);
  assert.equal(persisted.quest.runCount, before.quest.runCount);
  assert.equal(await readFile(persisted.quest.sessionPath, 'utf8'), session);
  assert.equal(await readFile(join(persisted.quest.workspacePath, 'quest-result.txt'), 'utf8'), 'Work produced by the fake test worker.');
  const restoreCommand = { commandId: 'restore-once' };
  await f.request(`/api/quests/${quest.id}/restore`, restoreCommand);
  await f.request(`/api/quests/${quest.id}/restore`, restoreCommand);
  await f.request(`/api/quests/${quest.id}/restore`, { commandId: 'restore-already-active' });
  await f.request(`/api/quests/${quest.id}/archive`, restoreCommand, 409);
  const restored = f.service().detail(quest.id);
  assert.equal(restored.quest.archivedAt, undefined);
  assert.equal(restored.quest.status, 'accepted');
  assert.equal(restored.events.filter(e => e.type === 'restored').length, 1);
  await f.restart();
  assert.equal(f.service().get(quest.id).archivedAt, undefined);
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'Repeat the remembered phrase', commandId: 'continue-restored' });
  const continued = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(continued.quest.sessionPath, before.quest.sessionPath);
  assert.match(continued.quest.result, /silver fern/);
});

test('archive rejects unfinished work and Guildmaster, but settles a canceled worker before archiving', async t => {
  const f = await fixture(t);
  const quest = await f.create('[wait] Work in progress');
  await f.state(quest.id, d => JSON.stringify(d.events).includes('Waiting for cancellation'));
  await f.request(`/api/quests/${quest.id}/archive`, { commandId: 'archive-running' }, 409);
  assert.equal(f.service().get(quest.id).status, 'running');
  await f.request(`/api/quests/${quest.id}/cancel`, { commandId: 'cancel-for-archive' });
  const archived = await f.request(`/api/quests/${quest.id}/archive`, { commandId: 'archive-cancelled' });
  assert.equal(archived.quest.status, 'cancelled');
  assert.ok(archived.quest.archivedAt);
  assert.equal(f.service().live.has(quest.id), false);
  const restored = await f.request(`/api/quests/${quest.id}/restore`, { commandId: 'restore-cancelled' });
  assert.equal(restored.quest.status, 'cancelled');
  assert.equal(restored.quest.archivedAt, undefined);
  const review = await f.create('Pending acceptance');
  await f.state(review.id, d => d.quest.status === 'awaiting_review');
  await f.request(`/api/quests/${review.id}/archive`, { commandId: 'archive-review' }, 409);
  const service = f.service();
  service.store.save({ ...service.get(quest.id), id: 'gm-archive-fixture', kind: 'guildmaster' });
  await f.request('/api/quests/gm-archive-fixture/archive', { commandId: 'archive-gm' }, 409);
  await f.request('/api/quests/gm-archive-fixture/restore', { commandId: 'restore-gm' }, 409);
});

test('duplicate create and feedback commands each start only one run', async t => {
  const f = await fixture(t);
  const spec = { objective: 'A small report', workspaceMode: 'none', commandId: 'create-once' };
  const first = await f.request('/api/quests', spec);
  const duplicate = await f.request('/api/quests', spec);
  assert.equal((first.quest ?? first).id, (duplicate.quest ?? duplicate).id);
  const id = (first.quest ?? first).id;
  await f.state(id, d => d.quest.status === 'awaiting_review');
  const feedback = { message: 'Add one paragraph', commandId: 'feedback-once' };
  await f.request(`/api/quests/${id}/continue`, feedback);
  await f.request(`/api/quests/${id}/continue`, feedback);
  const result = await f.state(id, d => d.quest.status === 'awaiting_review');
  assert.equal(JSON.parse(await readFile(result.quest.sessionPath, 'utf8')).history.length, 2);
});

test('question and answer arrive through a durable inbox', async t => {
  const f = await fixture(t);
  const quest = await f.create('[question] Ask before choosing a color');
  const waiting = await f.state(quest.id, d => d.requests.some((r: any) => r.status === 'pending'));
  const request = waiting.requests.find((r: any) => r.status === 'pending');
  await f.request(`/api/requests/${request.id}/answer`, { answer: 'Blue', commandId: 'answer-once' });
  const complete = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.match(JSON.stringify(complete.messages), /Blue/);
  assert.equal(complete.requests.filter((r: any) => r.status === 'pending').length, 0);
  const answered = complete.requests.find((r:any) => r.id === request.id);
  assert.ok(answered.answerMessageId);
  assert.equal(complete.messages.find((message:any) => message.id === answered.answerMessageId)?.text, 'Blue');
  await f.restart();
  assert.equal(f.service().detail(quest.id).requests.find(item => item.id === request.id)?.answerMessageId, answered.answerMessageId);

});

test('a question can be answered once after the service and its worker restart', async t => {
  const f = await fixture(t);
  const quest = await f.create('[question] Ask before choosing a color');
  const waiting = await f.state(quest.id, d => d.requests.some((r: any) => r.status === 'pending'));
  const request = waiting.requests.find((r: any) => r.status === 'pending');
  await f.restart();
  const interrupted = await f.state(quest.id, d => d.quest.status === 'interrupted');
  assert.equal(interrupted.requests.find((r: any) => r.id === request.id).status, 'pending');
  const answer = { answer: 'Violet', commandId: 'recovered-answer' };
  await f.request(`/api/requests/${request.id}/answer`, answer);
  await f.request(`/api/requests/${request.id}/answer`, answer);
  const complete = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(complete.quest.sessionPath, waiting.quest.sessionPath);
  assert.equal(JSON.parse(await readFile(complete.quest.sessionPath, 'utf8')).history.length, 2);
  assert.match(JSON.stringify(complete.messages), /Violet/);
  const answered = complete.requests.find((item:any) => item.id === request.id);
  assert.ok(answered.answerMessageId);
  const answerMessage = complete.messages.find((message:any) => message.id === answered.answerMessageId);
  assert.equal(answerMessage.role, 'user');
  assert.equal(answerMessage.source, 'user');
  assert.equal(answerMessage.displayText, 'Violet');
  assert.match(answerMessage.text, /The user answered: Violet/);
  assert.equal(complete.messages.filter((message:any) => message.id === answered.answerMessageId).length, 1);
  await f.restart();
  assert.equal(f.service().detail(quest.id).requests.find(item => item.id === request.id)?.answerMessageId, answered.answerMessageId);

});

test('a repeated engine question ID in another run creates a distinct answerable request', async t => {
  const f = await fixture(t);
  const quest = await f.create('[fixed-question] Ask a question');
  const first = await f.state(quest.id, d => d.requests.some((r: any) => r.status === 'pending'));
  const request = first.requests.find((r: any) => r.status === 'pending');
  await f.request(`/api/requests/${request.id}/answer`, { answer: 'Blue', commandId: 'first-fixed-answer' });
  await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  await f.request(`/api/quests/${quest.id}/continue`, { message: '[fixed-question] Ask again', commandId: 'repeat-fixed-question' });
  const second = await f.state(quest.id, d => d.requests.some((r: any) => r.status === 'pending'));
  const nextRequest = second.requests.find((r: any) => r.status === 'pending');
  assert.notEqual(nextRequest.id, request.id);
  await f.request(`/api/requests/${nextRequest.id}/answer`, { answer: 'Green', commandId: 'second-fixed-answer' });
  const complete = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.match(JSON.stringify(complete.messages), /Green/);
  assert.equal(complete.requests.length, 2);
  assert.notEqual(complete.requests[0].answerMessageId, complete.requests[1].answerMessageId);
  assert.ok(complete.requests.every((request:any) => complete.messages.some((message:any) => message.id === request.answerMessageId)));
});

test('answering after a worker failure starts a fresh run instead of reviving the failed process', async t => {
  const f = await fixture(t);
  const quest = await f.create('[question-fail] Ask and then lose the model transport');
  const failed = await f.state(quest.id, d => d.quest.status === 'failed');
  const request = failed.requests.find((r: any) => r.status === 'pending');
  assert.ok(request);
  await f.request(`/api/requests/${request.id}/answer`, { answer: 'Blue', commandId: 'answer-failed-worker' });
  const completed = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(completed.quest.runCount, 2);
  assert.match(JSON.stringify(completed.messages), /Blue/);
});

test('retrying the first Guildmaster instruction does not create a second run', async t => {
  const f = await fixture(t);
  const input = { message: 'Arrange a small investigation', workspacePath: f.workspace, workspaceMode: 'existing', commandId: 'gm-initial' };
  const first = await f.request('/api/guildmaster', input);
  const second = await f.request('/api/guildmaster', input);
  assert.equal(first.quest.id, second.quest.id);
  const complete = await f.state(first.quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(JSON.parse(await readFile(complete.quest.sessionPath, 'utf8')).history.length, 1);
});

test('Guildmaster receives a fresh bounded board snapshot including accepted and archived work on every run', async t => {
  const f = await fixture(t);
  const old = await f.create('PRIVATE_OBJECTIVE_NOT_FOR_BOARD', {title:'Earlier investigation'});
  await f.state(old.id, d => d.quest.status === 'awaiting_review');
  await f.service().action(old.id,'accept',{commandId:'snapshot-accept'});
  await f.service().action(old.id,'archive',{commandId:'snapshot-archive'});
  const first = (await f.service().guildmaster({message:'Run a fresh investigation.',workspaceMode:'none',commandId:'snapshot-gm-first'})).quest;
  const spec = JSON.parse(await readFile(join(f.service().dataDir,'runs',first.activeRunId + '.json'),'utf8'));
  assert.equal(spec.questBoard.quests.length,1);
  assert.equal(spec.questBoard.quests[0].id,old.id);
  assert.equal(spec.questBoard.quests[0].status,'accepted');
  assert.ok(spec.questBoard.quests[0].archivedAt);
  assert.equal(spec.questBoard.omitted,0);
  assert.doesNotMatch(JSON.stringify(spec.questBoard),/PRIVATE_OBJECTIVE_NOT_FOR_BOARD|result|sessionPath/);
  assert.equal(spec.prompt,'Run a fresh investigation.','Board data does not alter the exact original user prompt.');
  await f.state(first.id,d=>d.quest.status==='awaiting_review');
  await f.service().action(old.id,'restore',{commandId:'snapshot-restore'});
  const second = (await f.service().guildmaster({message:'Check the board again.',commandId:'snapshot-gm-second'})).quest;
  const secondSpec = JSON.parse(await readFile(join(f.service().dataDir,'runs',second.activeRunId + '.json'),'utf8'));
  assert.equal(secondSpec.questBoard.quests[0].archivedAt,undefined);
  assert.ok(secondSpec.questBoard.capturedAt>=spec.questBoard.capturedAt);
  await f.state(first.id,d=>d.quest.status==='awaiting_review');
  for(let i=0;i<35;i++) f.service().store.save({...f.service().get(old.id),id:`snapshot-extra-${i}`,title:'x'.repeat(200),createdAt:Date.now()+i});
  const capped = (await f.service().guildmaster({message:'Check recent quests.',commandId:'snapshot-gm-cap'})).quest;
  const cappedSpec = JSON.parse(await readFile(join(f.service().dataDir,'runs',capped.activeRunId + '.json'),'utf8'));
  assert.equal(cappedSpec.questBoard.quests.length,30);
  assert.equal(cappedSpec.questBoard.omitted,6);
  assert.ok(cappedSpec.questBoard.quests.every((quest:any)=>quest.title.length<=160));
});

test('simultaneous first Guildmaster messages cannot create two main conversations', async t => {
  const f = await fixture(t);
  const service = f.service();
  const input = { message: '[wait] Arrange an investigation', workspacePath: f.workspace, workspaceMode: 'existing' };
  const outcomes = await Promise.allSettled([
    service.guildmaster({ ...input, commandId: 'gm-race-a' }),
    service.guildmaster({ ...input, commandId: 'gm-race-b' }),
  ]);
  assert.equal(service.store.list().filter(q => q.kind === 'guildmaster').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
});

test('a worker that cannot spawn releases its live slot and shutdown completes', async t => {
  const f = await fixture(t);
  const service = f.service();
  const executable = process.execPath;
  let quest: any;
  try {
    process.execPath = join(f.directory, 'missing-node-executable');
    quest = await f.create('This worker cannot launch');
  } finally { process.execPath = executable; }
  const failure = await f.state(quest.id, d => d.quest.status === 'failed');
  assert.match(failure.quest.error, /ENOENT|spawn/);
  for (let i = 0; i < 20 && service.live.size; i++) await delay(20);
  const liveCount = service.live.size;
  // No process exists after ENOENT. Avoid hanging test teardown if this regression returns.
  if (liveCount) service.live.clear();
  assert.equal(liveCount, 0, 'Failed spawn must not hold a worker slot or leave shutdown waiting forever.');
});

test('a synchronous worker launch failure removes its scoped management token', async t => {
  const f = await fixture(t);
  const service = f.service();
  service.workerPath = null as unknown as string;
  const quest = await f.create('This worker has an invalid module path');
  assert.equal(quest.status, 'failed');
  assert.equal(service.live.size, 0);
  assert.equal(service.workerTokens.size, 0);
  assert.equal(service.gmTokens.size, 0);
});

test('reusing a command ID for different feedback is rejected', async t => {
  const f = await fixture(t);
  const quest = await f.create('Write a short report');
  await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'Add a summary', commandId: 'shared-command' });
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'Delete the summary', commandId: 'shared-command' }, 409);
});

test('execution survives an absent browser and completed state survives a service restart', async t => {
  const f = await fixture(t);
  const quest = await f.create('[slow] Finish without an open client');
  // There is deliberately no browser, event stream, or polling connection during this turn.
  await delay(900);
  await f.restart();
  const result = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.match(JSON.stringify(result.messages), /Finish without an open client/);
});

test('active work is marked interrupted on restart and can continue with its session', async t => {
  const f = await fixture(t);
  const quest = await f.create('[wait] Hold this thought');
  const running = await f.state(quest.id, d => JSON.stringify(d.events).includes('Waiting for cancellation'));
  await f.restart();
  await f.state(quest.id, d => d.quest.status === 'interrupted');
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'RESUME and finish', commandId: 'resume-interrupted' });
  const completed = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(completed.quest.sessionPath, running.quest.sessionPath);
});

test('worker failure is visible and can be followed up', async t => {
  const f = await fixture(t);
  const quest = await f.create('[fail] Simulate a model transport failure');
  const failed = await f.state(quest.id, d => d.quest.status === 'failed');
  assert.match(JSON.stringify(failed), /Deliberate test worker failure/);
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'Try a different approach', commandId: 'recover-failure' });
  await f.state(quest.id, d => d.quest.status === 'awaiting_review');
});

test('writers cannot share a checkout while a read-only quest can inspect it', async t => {
  const f = await fixture(t);
  const writer = await f.create('[wait] Edit this project', { workspaceMode: 'existing', workspacePath: f.workspace, tools: ['read', 'write', 'edit', 'bash'] });
  await f.state(writer.id, d => JSON.stringify(d.events).includes('Waiting for cancellation'));
  const queued = await f.create('Edit it again', { workspaceMode: 'existing', workspacePath: f.workspace, tools: ['write'] });
  assert.equal(queued.status, 'queued');
  const reader = await f.create('Review files only', { workspaceMode: 'existing', workspacePath: f.workspace, tools: ['read', 'grep', 'find', 'ls'] });
  await f.state(reader.id, d => d.quest.status === 'awaiting_review');
  await f.request(`/api/quests/${writer.id}/cancel`, { commandId: 'cancel-writer' });
  await f.state(writer.id, d => d.quest.status === 'cancelled');
  await f.state(queued.id, d => d.quest.status === 'awaiting_review');
});

test('worktree changes are isolated and feedback retains the same branch and directory', async t => {
  const f = await fixture(t);
  await exec('git', ['init', '--quiet'], { cwd: f.workspace });
  await writeFile(join(f.workspace, 'README.md'), 'Original project\n');
  await exec('git', ['add', 'README.md'], { cwd: f.workspace });
  await exec('git', ['-c', 'user.name=Guildmaster Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Fixture'], { cwd: f.workspace });
  const quest = await f.create('[write] Implement a local artifact', { workspaceMode: 'worktree', workspacePath: f.workspace, tools: ['read', 'write'] });
  const first = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.notEqual(first.quest.workspacePath, f.workspace);
  assert.match(first.quest.branch, /^guildmaster\//);
  assert.equal(await readFile(join(first.quest.workspacePath, 'quest-result.txt'), 'utf8'), 'Work produced by the fake test worker.');
  await assert.rejects(readFile(join(f.workspace, 'quest-result.txt')), { code: 'ENOENT' });
  await f.request(`/api/quests/${quest.id}/continue`, { message: 'Review this local result', commandId: 'review-worktree' });
  const second = await f.state(quest.id, d => d.quest.status === 'awaiting_review');
  assert.equal(second.quest.workspacePath, first.quest.workspacePath);
  assert.equal(second.quest.branch, first.quest.branch);
  const { stdout } = await exec('git', ['remote'], { cwd: first.quest.workspacePath });
  assert.equal(stdout.trim(), '');
});

test('service rejects missing objectives, invalid paths, and unknown capabilities', async t => {
  const f = await fixture(t);
  await f.request('/api/quests', { objective: '', workspaceMode: 'none', commandId: 'empty' }, 400);
  await f.request('/api/quests', { objective: 'Inspect it', workspaceMode: 'existing', workspacePath: join(f.directory, 'absent'), commandId: 'bad-path' }, 400);
  await f.request('/api/quests', { objective: 'Use unknown capabilities', workspaceMode: 'none', tools: ['teleport'], commandId: 'bad-tools' }, 400);
});
