import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import type { Status } from '../src/domain/types.ts';

const workerPath = fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url));

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'guildmaster-delivery-'));
  const dataDir = join(root, 'data');
  let store = new Store(dataDir);
  let service = new QuestService({ store, dataDir, defaultWorkspace: root, workerPath });
  const close = async () => { await service.close(); store.close(); };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  async function state(id: string, status: Status, exited = true) {
    for (let i = 0; i < 150; i++) {
      const quest = service.get(id);
      if (quest.status === status && (!exited || !service.live.has(id))) return quest;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Expected ${status}: ${JSON.stringify(service.detail(id))}`);
  }
  return {
    service: () => service, store: () => store, state,
    create: async (objective = 'Remember the original objective.') => (await service.create({ objective, workspaceMode: 'none', commandId: 'create' })).quest,
    history: async (id: string): Promise<{ history: string[]; deliveryIds: string[] }> => JSON.parse(await readFile(service.get(id).sessionPath, 'utf8')),
    restart: async () => { await close(); store = new Store(dataDir); service = new QuestService({ store, dataDir, defaultWorkspace: root, workerPath }); },
  };
}

for (const marker of ['[fault-before-delivery]', '[fault-after-save]']) {
  test(`resume preserves exact feedback after ${marker}, with no duplicate on a lost acknowledgment`, async t => {
    const f = await fixture(t);
    const quest = await f.create();
    await f.state(quest.id, 'awaiting_review');
    const feedback = { message: `Rename only the copper lantern to “violet heron”. ${marker}`, commandId: 'feedback' };
    const failedRun = (await f.service().continue(quest.id, feedback)).quest.activeRunId!;
    await f.state(quest.id, 'failed');
    const pending = f.store().pendingDeliveries(quest.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].text, feedback.message);
    assert.equal(f.store().getRun(failedRun)?.data.prompt, feedback.message, 'Failure updates must preserve the original prompt.');
    await f.service().continue(quest.id, feedback);
    assert.equal(f.service().get(quest.id).runCount, 2, 'Command retry must not start another worker.');
    assert.equal(f.store().deliveries(quest.id).filter(item => item.commandId === 'feedback').length, 1);
    const before = await f.history(quest.id);
    assert.equal(before.history.filter(value => value === feedback.message).length, marker === '[fault-after-save]' ? 1 : 0);

    await f.restart();
    const resumed = await f.service().continue(quest.id, { commandId: 'resume' }, true);
    const activeRun = resumed.quest.activeRunId!;
    f.service().workerEvent(quest.id, failedRun, { type: 'delivered', ids: [pending[0].id] });
    assert.ok(f.store().pendingDeliveries(quest.id).some(item => item.id === pending[0].id), 'Stale run acknowledgments must not mark a delivery.');
    assert.throws(() => f.service().workerEvent(quest.id, activeRun, { type: 'delivered', ids: ['unassigned-delivery'] }), /Invalid delivery acknowledgment/);
    await f.service().continue(quest.id, { commandId: 'resume' }, true);
    assert.equal(f.service().get(quest.id).runCount, 3);
    await f.state(quest.id, 'awaiting_review');
    const after = await f.history(quest.id);
    assert.equal(after.history.filter(value => value === feedback.message).length, 1);
    assert.equal(after.deliveryIds.filter(id => id === pending[0].id).length, 1);
    assert.deepEqual(f.store().pendingDeliveries(quest.id), []);
    assert.match(f.service().get(quest.id).result!, /violet heron/);
    assert.ok(f.store().getRun(activeRun)?.data.prompt, 'Completion updates must preserve the run prompt.');
  });
}

for (const marker of ['[fault-answer-before-save]', '[fault-answer-after-save]']) {
  test(`a saved live answer survives restart after ${marker}`, async t => {
    const f = await fixture(t);
    const quest = await f.create('[question] Choose the precise color before continuing.');
    await f.state(quest.id, 'awaiting_input', false);
    const request = f.store().requests(quest.id).find(item => item.status === 'pending')!;
    const input = { answer: `Ultramarine, code #120A8F. ${marker}`, commandId: 'answer' };
    await f.service().answer(request.id, input);
    await f.state(quest.id, 'failed');
    const delivery = f.store().pendingDeliveries(quest.id)[0];
    assert.equal(delivery.kind, 'answer');
    assert.equal(delivery.answer, input.answer);
    assert.equal(delivery.toolCallId, request.toolCallId);
    assert.equal(f.store().getRequest(request.id)?.answer, input.answer);
    const before = await f.history(quest.id);
    assert.equal(before.history.filter(value => value === delivery.text).length, marker === '[fault-answer-after-save]' ? 1 : 0);
    await f.service().answer(request.id, input);
    assert.equal(f.store().deliveries(quest.id).filter(item => item.kind === 'answer').length, 1);
    await f.restart();
    await f.service().continue(quest.id, { commandId: 'resume-answer' }, true);
    await f.state(quest.id, 'awaiting_review');
    const after = await f.history(quest.id);
    assert.equal(after.history.filter(value => value === delivery.text).length, 1);
    assert.deepEqual(f.store().pendingDeliveries(quest.id), []);
    assert.match(f.service().get(quest.id).result!, /Ultramarine, code #120A8F/);
    assert.equal(f.store().requests(quest.id).filter(item => item.status === 'pending').length, 0);
  });
}

test('a result without delivery acknowledgment requires reconciliation before review', async t => {
  const f = await fixture(t);
  const quest = await f.create('Remember the brass compass. [complete-without-ack]');
  await f.state(quest.id, 'interrupted');
  assert.equal(f.service().get(quest.id).result, undefined);
  assert.equal(f.store().pendingDeliveries(quest.id).length, 1);
  assert.equal((await f.history(quest.id)).history.length, 1);
  await f.restart();
  await f.service().continue(quest.id, { commandId: 'reconcile' }, true);
  await f.state(quest.id, 'awaiting_review');
  const history = (await f.history(quest.id)).history;
  assert.equal(history.filter(text => text === quest.objective).length, 1);
  assert.deepEqual(f.store().pendingDeliveries(quest.id), []);
});

test('canceling an undelivered instruction prevents its replay when the quest reopens', async t => {
  const f = await fixture(t);
  const quest = await f.create();
  await f.state(quest.id, 'awaiting_review');
  const abandoned = 'Do not replay this abandoned instruction. [fault-before-delivery]';
  await f.service().continue(quest.id, { message: abandoned, commandId: 'abandoned' });
  await f.state(quest.id, 'failed');
  const pending = f.store().pendingDeliveries(quest.id)[0];
  await f.service().action(quest.id, 'cancel', { commandId: 'cancel' });
  assert.ok(f.store().deliveries(quest.id).find(item => item.id === pending.id)?.cancelledAt);
  await f.restart();
  await f.service().continue(quest.id, { message: 'Perform the revised task only.', commandId: 'reopen' });
  await f.state(quest.id, 'awaiting_review');
  assert.ok(!(await f.history(quest.id)).history.includes(abandoned));
  assert.deepEqual(f.store().pendingDeliveries(quest.id), []);
});

test('Guildmaster preserves the exact delegation request across consecutive interrupted resumes', async t => {
  const f = await fixture(t);
  const first = await f.service().guildmaster({ message: 'Coordinate a feature.', workspaceMode: 'none', commandId: 'gm-create' });
  await f.state(first.quest.id, 'awaiting_review');
  const original = 'Implement only the API adapter. Remember “copper lantern”; leave UI files unchanged. [fault-before-delivery]';
  await f.service().guildmaster({ message: original, commandId: 'gm-followup' });
  await f.state(first.quest.id, 'failed');
  await f.restart();

  const resumed = (await f.service().continue(first.quest.id, { commandId: 'gm-resume-one' }, true)).quest;
  assert.equal(f.service().delegationSource(resumed).text, original);
  assert.match(f.store().getRun(resumed.activeRunId!)!.data.prompt!, /^Resume this quest/);
  assert.equal(f.store().getRun(resumed.activeRunId!)!.data.sourcePrompt, original);
  // Stop the first recovery while its worker is active, then recover a second time.
  await f.restart();
  const second = (await f.service().continue(first.quest.id, { commandId: 'gm-resume-two' }, true)).quest;
  assert.equal(f.service().delegationSource(second).text, original);
  assert.equal(f.store().getRun(second.activeRunId!)!.data.sourcePrompt, original);
  await f.state(second.id, 'awaiting_review');
  assert.equal((await f.history(second.id)).history.filter(text => text === original).length, 1);
});

test('Guildmaster retains an exact live answer in delegation context after recovery', async t => {
  const f = await fixture(t);
  const original = '[question] Coordinate the color change. Preserve the existing API.';
  const first = await f.service().guildmaster({ message: original, workspaceMode: 'none', commandId: 'gm-question' });
  await f.state(first.quest.id, 'awaiting_input', false);
  const request = f.store().requests(first.quest.id).find(item => item.status === 'pending')!;
  const answer = 'Use ultramarine #120A8F only for the button. [fault-answer-after-save]';
  await f.service().answer(request.id, { answer, commandId: 'gm-exact-answer' });
  const source = f.service().delegationSource(f.service().get(first.quest.id)).text;
  assert.ok(source.startsWith(original));
  assert.ok(source.includes(request.question));
  assert.ok(source.includes(answer));
  await f.state(first.quest.id, 'failed');
  await f.restart();
  const resumed = (await f.service().continue(first.quest.id, { commandId: 'gm-answer-resume' }, true)).quest;
  assert.equal(f.service().delegationSource(resumed).text, source);
  assert.equal(f.store().getRun(resumed.activeRunId!)!.data.sourcePrompt, source);
  await f.state(first.quest.id, 'awaiting_review');
});
