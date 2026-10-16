import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import type { Quest } from '../src/domain/types.ts';

const workerPath = fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url));

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'guildmaster-delegation-'));
  const dataDir = join(root, 'data');
  const web = join(root, 'web'); const api = join(root, 'api');
  await Promise.all([mkdir(web), mkdir(api)]);
  let store = new Store(dataDir);
  let service = new QuestService({ store, dataDir, defaultWorkspace: root, workerPath, maxWorkers:5 });
  const close = async () => { await service.close(); store.close(); };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const project = (await service.saveProject({ name: 'Fixture', repositories: [{ name: 'Web', path: web }, { name: 'API', path: api }], commandId: 'project' })).project;
  async function until(predicate: () => boolean, reason: string) {
    for (let i = 0; i < 250; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`${reason}: ${JSON.stringify(store.list().map(q => ({id:q.id,status:q.status,runCount:q.runCount,error:q.error})))}`);
  }
  const ready = (id: string) => until(() => service.live.has(id) && service.get(id).status === 'running' && !store.pendingDeliveries(id).length, 'Worker did not become ready');
  async function finish(id: string, text = 'Scoped task completed.') {
    const finished = () => ['awaiting_review', 'completed'].includes(service.get(id).status);
    await until(() => finished() || (service.live.has(id) && service.get(id).status === 'running' && !store.pendingDeliveries(id).length), 'Worker did not become ready to finish');
    if (finished()) {
      await until(() => !service.live.has(id), 'Completed worker did not exit');
      return;
    }
    service.live.get(id)!.child.send({ type: 'fixture-finish', text });
    await until(() => ['awaiting_review', 'completed'].includes(service.get(id).status) && !service.live.has(id), 'Worker did not finish');
  }
  async function yieldLeader(id: string, agentIds?: string[]) {
    await ready(id);
    await service.waitForAgents(id, { agentIds, commandId: randomUUID() });
    service.live.get(id)!.child.send({ type: 'fixture-yield' });
    await until(() => !service.live.has(id), 'Leader did not release its worker');
  }
  return {
    service: () => service, store: () => store, project, ready, finish, until, yieldLeader,
    leader: async (tools = ['read']) => (await service.create({ objective: '[wait] Coordinate independent work.', projectId: project.id, tools, commandId: randomUUID() })).quest,
    delegate: async (parentId: string, repositoryIds?: string[]) => (await service.createDelegate(parentId, { objective: '[wait] Complete one bounded assignment.', repositoryIds, tools: service.get(parentId).tools, commandId: randomUUID() })).agent,
    history: async (id: string): Promise<{history: string[]}> => JSON.parse(await readFile(service.get(id).sessionPath, 'utf8')),
    restart: async () => { await close(); store = new Store(dataDir); service = new QuestService({ store, dataDir, defaultWorkspace: root, workerPath, maxWorkers:5 }); },
  };
}

test('two quests share bounded parallel delegate slots and wake their saved leaders without Guildmaster messages', async t => {
  const f = await fixture(t);
  const gm = (await f.service().guildmaster({ message: 'Coordinate the work.', workspaceMode: 'none', commandId: 'gm' })).quest;
  await f.until(() => f.service().get(gm.id).status === 'awaiting_review' && !f.service().live.has(gm.id), 'Guildmaster did not finish');
  const gmMessages = f.store().messages(gm.id);
  const a = await f.leader(); const b = await f.leader();
  await Promise.all([f.ready(a.id), f.ready(b.id)]);
  let peak = 0;
  f.service().on('change', () => { peak = Math.max(peak, f.service().live.size); });
  const children: Quest[] = [];
  for (const parent of [a, b]) for (let i = 0; i < 2; i++) children.push(await f.delegate(parent.id));
  assert.ok(children.some(child => f.service().get(child.id).status === 'queued'));
  await f.yieldLeader(a.id); await f.yieldLeader(b.id);
  await f.until(() => children.filter(child => f.service().live.has(child.id)).length === 4, 'Four delegates did not run in parallel');
  for (let count = 0; count < children.length; count++) {
    await f.until(() => children.some(child => f.service().live.has(child.id) && !f.store().pendingDeliveries(child.id).length), 'No delegate can make progress');
    const child = children.find(item => f.service().live.has(item.id) && !f.store().pendingDeliveries(item.id).length)!;
    await f.finish(child.id, `Result from ${child.id}.`);
  }
  await f.until(() => f.service().get(a.id).runCount === 2 && f.service().get(b.id).runCount === 2, 'Results did not wake both leaders');
  await Promise.all([f.finish(a.id), f.finish(b.id)]);
  assert.ok(peak <= 4, `Global worker limit exceeded: ${peak}`);
  assert.equal(peak, 4);
  assert.equal(f.service().get(a.id).sessionPath, a.sessionPath);
  assert.equal(f.service().get(b.id).sessionPath, b.sessionPath);
  assert.deepEqual(f.store().messages(gm.id), gmMessages);
});

test('delegate writers parallelize separate repositories and retain sessions through feedback', async t => {
  const f = await fixture(t);
  const leader = await f.leader(['read', 'write']); await f.ready(leader.id);
  const web = f.project.repositories[0].id; const api = f.project.repositories[1].id;
  const first = await f.delegate(leader.id, [web]);
  const second = await f.delegate(leader.id, [api]);
  assert.equal(f.service().get(first.id).status, 'queued', 'Lead owns its checkouts until its worker exits.');
  await f.yieldLeader(leader.id);
  await Promise.all([f.ready(first.id), f.ready(second.id)]);
  await f.finish(first.id);
  assert.ok(f.service().live.has(second.id), 'Independent repository work remains active.');
  await f.finish(second.id);
  await f.until(() => f.service().get(leader.id).runCount === 2, 'Leader was not resumed');
  await f.finish(leader.id);

  await f.service().continue(leader.id, { message: '[wait] Revise the Web result.', commandId: 'feedback' });
  await f.ready(leader.id);
  const continuation = { message: '[wait] Preserve the exact phrase copper lantern in the revision.', commandId: 'member-feedback' };
  await f.service().continueDelegate(leader.id, first.id, continuation);
  await f.service().continueDelegate(leader.id, first.id, continuation);
  await f.yieldLeader(leader.id, [first.id]);
  await f.finish(first.id, 'Revision complete: copper lantern.');
  await f.until(() => f.service().get(leader.id).runCount === 4, 'Feedback did not wake the same leader');
  await f.finish(leader.id);
  assert.equal(f.service().get(first.id).sessionPath, first.sessionPath);
  const presented=f.service().detail(first.id).messages.filter(message=>message.role==='user');
  assert.equal(presented[0].source,'quest_lead');
  assert.equal(presented.at(-1)?.source,'quest_lead');
  assert.match(presented.at(-1)?.displayText ?? '',/Preserve the exact phrase copper lantern/);
  assert.ok(f.service().detail(leader.id).messages.some(message=>message.source==='system' && message.text.startsWith('Your delegated work has returned.')));
  assert.equal(f.service().get(first.id).runCount, 2);
  assert.equal((await f.history(first.id)).history.filter(text => text.includes('Preserve the exact phrase copper lantern')).length, 1);
});

test('delegate writers sharing a checkout wait until the preceding writer exits', async t => {
  const f = await fixture(t);
  const leader = await f.leader(['read', 'write']); await f.ready(leader.id);
  const repository = f.project.repositories[0].id;
  const first = await f.delegate(leader.id, [repository]);
  const second = await f.delegate(leader.id, [repository]);
  await f.yieldLeader(leader.id);
  // Queue timestamps can tie; serialization does not promise which writer goes first.
  await f.until(() => [first, second].some(agent => f.service().live.has(agent.id)), 'No writer started');
  const active = [first, second].find(agent => f.service().live.has(agent.id))!;
  const waiting = active.id === first.id ? second : first;
  await f.ready(active.id);
  assert.equal(f.service().get(waiting.id).status, 'queued');
  assert.ok(!f.service().live.has(waiting.id));
  await f.finish(active.id);
  await f.ready(waiting.id);
  await f.finish(waiting.id);
  await f.until(() => f.service().get(leader.id).runCount === 2, 'Serial reports did not wake their leader');
  await f.finish(leader.id);
});

test('capacity queues new quests, and canceling queued work never starts its worker', async t => {
  const f = await fixture(t);
  const quests = [];
  for (let i = 0; i < 6; i++) quests.push((await f.service().create({ objective: '[wait] Independent task.', workspaceMode: 'none', commandId: `queued-${i}` })).quest);
  assert.equal(f.service().live.size, 4);
  assert.equal(f.service().get(quests[4].id).status, 'queued');
  const gm = (await f.service().guildmaster({ message: 'Report progress while background slots are busy.', workspaceMode: 'none', commandId: 'gm-reserved-slot' })).quest;
  assert.equal(f.service().get(gm.id).status, 'running');
  assert.equal(f.service().live.size, 5, 'Guildmaster retains its reserved slot while four background workers are busy.');
  await f.until(() => f.service().get(gm.id).status === 'awaiting_review' && !f.service().live.has(gm.id), 'Guildmaster could not answer during background work');
  await f.service().action(quests[5].id, 'cancel', { commandId: 'cancel-before-start' });
  await f.finish(quests[0].id);
  await f.ready(quests[4].id);
  assert.equal(f.service().get(quests[5].id).status, 'cancelled');
  assert.ok(!f.service().live.has(quests[5].id));
});

test('canceling a waiting quest cancels its delegates and prevents an automatic leader restart', async t => {
  const f = await fixture(t);
  const leader = await f.leader(); await f.ready(leader.id);
  const first = await f.delegate(leader.id); const second = await f.delegate(leader.id);
  await f.yieldLeader(leader.id);
  await Promise.all([f.ready(first.id), f.ready(second.id)]);
  await f.service().action(leader.id, 'cancel', { commandId: 'cancel-party' });
  await f.until(() => [leader.id, first.id, second.id].every(id => !f.service().live.has(id)), 'Canceled workers did not exit');
  for (const id of [leader.id, first.id, second.id]) assert.equal(f.service().get(id).status, 'cancelled');
  assert.equal(f.service().get(leader.id).runCount, 1);
});

test('delegation rejects nested agents, foreign members, unknown repositories, and capability expansion', async t => {
  const f = await fixture(t);
  const parent = await f.leader(); const other = await f.leader();
  await Promise.all([f.ready(parent.id), f.ready(other.id)]);
  const input = { objective: '[wait] Read the Web repository.', repositoryIds: [f.project.repositories[0].id], commandId: 'member-once' };
  const first = await f.service().createDelegate(parent.id, input);
  const repeated = await f.service().createDelegate(parent.id, input);
  assert.equal(repeated.agent.id, first.agent.id);
  assert.equal(f.service().agents(parent.id).length, 1);
  await assert.rejects(f.service().createDelegate(first.agent.id, { objective: 'Nested task', commandId: 'nested' }));
  await assert.rejects(f.service().continueDelegate(other.id, first.agent.id, { message: 'Foreign feedback', commandId: 'foreign' }));
  await assert.rejects(f.service().createDelegate(parent.id, { objective: 'Unselected repository', repositoryIds: ['foreign-repo'], commandId: 'foreign-repo' }));
  await assert.rejects(f.service().createDelegate(parent.id, { objective: 'Escalated tools', tools: ['write'], commandId: 'escalation' }));
  assert.equal(f.service().agents(parent.id).length, 1);
});

test('wrong-case delegate capabilities are rejected with the exact permitted tool IDs', async t => {
  const f = await fixture(t);
  const allowed = ['read', 'grep', 'find', 'ls', 'bash'];
  const parent = await f.leader(allowed); await f.ready(parent.id);
  await assert.rejects(f.service().createDelegate(parent.id, {
    objective: 'Inspect the source.', tools: ['Read', 'Grep', 'find', 'ls', 'Bash'], commandId: 'wrong-case-tools',
  }), (error: any) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /allowed/i);
    assert.ok(error.message.includes(allowed.join(', ')), 'The error must list usable capability IDs.');
    return true;
  });
  assert.equal(f.service().agents(parent.id).length, 0, 'Invalid casing must not create or normalize a delegate.');
  const readOnly = await f.leader(['read', 'grep']); await f.ready(readOnly.id);
  await assert.rejects(f.service().createDelegate(readOnly.id, {
    objective: 'Run a command.', tools: ['bash'], commandId: 'unavailable-bash',
  }), (error: any) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /allowed/i);
    assert.ok(error.message.includes('read, grep'));
    return true;
  });
  const created = await f.service().createDelegate(parent.id, {
    objective: '[wait] Inspect the source with exact IDs.', tools: ['read', 'bash'], commandId: 'canonical-tools',
  });
  assert.deepEqual(created.agent.tools, ['read', 'bash']);
});

test('restart retains delegate snapshots and sessions and exposes interrupted work', async t => {
  const f = await fixture(t);
  const leader = await f.leader(['read', 'write']); await f.ready(leader.id);
  const child = await f.delegate(leader.id, [f.project.repositories[1].id]);
  await f.yieldLeader(leader.id);
  await f.ready(child.id);
  const savedChild = f.service().get(child.id);
  await f.restart();
  assert.equal(f.service().get(leader.id).status, 'interrupted');
  assert.equal(f.service().get(child.id).status, 'interrupted');
  assert.equal(f.service().live.size, 0);
  assert.deepEqual(f.service().get(child.id).project, savedChild.project);
  assert.deepEqual(f.service().get(child.id).workspaces, savedChild.workspaces);
  assert.equal(f.service().get(child.id).sessionPath, savedChild.sessionPath);
  await f.service().continue(leader.id, { message: '[wait] Continue the interrupted work.', commandId: 'resume-leader' });
  await f.ready(leader.id);
  await f.service().continueDelegate(leader.id, child.id, { message: '[wait] Continue the saved assignment.', commandId: 'resume-member' });
  await f.yieldLeader(leader.id, [child.id]);
  await f.finish(child.id);
  await f.until(() => f.service().get(leader.id).runCount === 3, 'Recovered member did not wake its leader');
  await f.finish(leader.id);
  assert.equal(f.service().get(child.id).sessionPath, savedChild.sessionPath);
  assert.ok((await f.history(child.id)).history.some(text => text.includes('Complete one bounded assignment.')));
});

test('a premature lead result automatically yields until an active delegate returns', async t => {
  const f = await fixture(t);
  const leader = await f.leader(['read', 'write']); await f.ready(leader.id);
  const child = await f.delegate(leader.id, [f.project.repositories[0].id]);
  assert.equal(f.service().get(child.id).status, 'queued');
  f.service().live.get(leader.id)!.child.send({ type: 'fixture-finish', text: 'Premature result without waiting for the delegate.' });
  await f.until(() => f.service().get(leader.id).status === 'waiting' && !f.service().live.has(leader.id), 'Premature result did not release the lead worker');
  assert.equal(f.service().get(leader.id).result, undefined);
  await f.ready(child.id);
  await f.finish(child.id);
  await f.until(() => f.service().get(leader.id).runCount === 2, 'Automatic wait did not resume the leader');
  await f.finish(leader.id, 'Reviewed the delegate result.');
  assert.equal(f.service().get(leader.id).result, 'Reviewed the delegate result.');
  assert.equal(f.service().get(leader.id).sessionPath, leader.sessionPath);
});

test('a completed but unconsumed delegate report also prevents a premature lead result', async t => {
  const f = await fixture(t);
  const leader = await f.leader(); await f.ready(leader.id);
  const child = await f.delegate(leader.id);
  await f.finish(child.id);
  assert.equal(f.service().get(leader.id).runCount, 1);
  f.service().live.get(leader.id)!.child.send({ type: 'fixture-finish', text: 'Result without inspecting the completed delegate.' });
  await f.until(() => f.service().get(leader.id).runCount === 2, 'Unconsumed report did not trigger a leader review run');
  assert.ok(f.store().events(leader.id).some(event => event.type === 'waiting'));
  assert.equal(f.service().get(leader.id).result, undefined);
  await f.finish(leader.id, 'Reviewed the previously completed report.');
  assert.equal(f.service().get(leader.id).status, 'awaiting_review');
  assert.equal(f.service().get(leader.id).result, 'Reviewed the previously completed report.');
});

test('delegate questions release shared locks, wake their lead, and resume with its answer', async t => {
  const f = await fixture(t);
  const leader = await f.leader(['read','bash']); await f.ready(leader.id);
  const child = (await f.service().createDelegate(leader.id, {
    title: '[wait] Color consultation', objective: '[question] Ask which color to use.', commandId: 'question-member',
  })).agent;
  await f.yieldLeader(leader.id);
  await f.until(() => f.service().get(leader.id).runCount === 2, 'Question did not wake the lead');
  await f.ready(leader.id);
  assert.equal(f.service().get(child.id).status,'awaiting_input');
  assert.equal(f.service().live.has(child.id),false,'Question releases the shared writer lock');
  const request = f.store().requests(child.id)[0];
  assert.match((await f.history(leader.id)).history.at(-1)!,/Which color should I use/);
  assert.equal(f.service().withAgentSummary(f.service().get(leader.id)).agentSummary.needsAttention,0);
  const waiting = await f.service().waitForAgents(leader.id,{commandId:'pending-wait'});
  assert.equal(waiting.waiting,false);
  assert.equal(waiting.questions[0].id,request.id);
  await assert.rejects(f.service().answer(request.id,{answer:'blue',commandId:'human-answer'}),/quest lead answers/);
  const other = await f.leader();
  await assert.rejects(f.service().answer(request.id,{answer:'blue',commandId:'foreign-answer'},{parentId:other.id,agentId:child.id}),/another assignment/);
  const delegated = {parentId:leader.id,agentId:child.id,expectedRunId:f.service().get(leader.id).activeRunId};
  const input = {answer:'Use cedar green. [wait]',commandId:'lead-answer'};
  await f.service().answer(request.id,input,delegated);
  await f.service().answer(request.id,input,delegated);
  assert.equal(f.store().requests(child.id)[0].status,'answered');
  assert.equal(f.service().detail(child.id).messages.at(-1)?.source,'quest_lead');
  assert.equal(f.service().get(child.id).status,'queued');
  await f.yieldLeader(leader.id);
  await f.ready(child.id);
  assert.match((await f.history(child.id)).history.at(-1)!,/quest lead answered: Use cedar green/);
  assert.equal(f.service().get(child.id).sessionPath,child.sessionPath);
  await f.finish(child.id);
  await f.until(()=>f.service().get(leader.id).runCount===3,'Answer result did not return to lead');
  await f.finish(leader.id);
  await assert.rejects(f.service().answer(request.id,input,delegated),/active|run|lead/i,'Stale lead cannot replay a cached answer');
});

test('saved delegate questions are available when the lead resumes after restart', async t => {
  const f = await fixture(t);
  const leader = await f.leader(); await f.ready(leader.id);
  const child = (await f.service().createDelegate(leader.id,{objective:'[question] Ask for a decision.',commandId:'restart-question'})).agent;
  await f.until(()=>f.store().requests(child.id).length>0 && !f.service().live.has(child.id),'No saved question');
  const request = f.store().requests(child.id)[0];
  await f.restart();
  await f.service().continue(leader.id,{commandId:'resume-parent'},true);
  await f.ready(leader.id);
  assert.match((await f.history(leader.id)).history.at(-1)!,/Your delegates need your input/);
  assert.equal(f.store().requests(child.id)[0].id,request.id);
  await f.service().answer(request.id,{answer:'Use green.',commandId:'recovered-answer'},{parentId:leader.id,agentId:child.id});
  await f.until(()=>f.service().get(child.id).status==='completed','Recovered delegate did not finish');
});


test('five saved delegates inherit script capabilities, while a sixth is rejected', async t => {
  const f = await fixture(t);
  const parent = await f.leader(['read', 'bash']); await f.ready(parent.id);
  for (let index = 0; index < 5; index++) {
    const {agent} = await f.service().createDelegate(parent.id, {objective:'[wait] Run the review script.', commandId:`script-${index}`});
    assert.deepEqual(agent.tools, ['read', 'bash']);
    assert.equal(agent.guidanceRevision, f.service().get(parent.id).guidanceRevision);
    assert.equal(agent.status, 'queued', 'Shell workers respect the lead checkout lock');
  }
  assert.equal(f.service().agents(parent.id).length, 5);
  await assert.rejects(f.service().createDelegate(parent.id, {objective:'Sixth agent', commandId:'sixth'}), /five delegates/);
});

test('an idle delegate can start independent context without losing earlier records or expanding slots', async t => {
  const f = await fixture(t);
  const parent = await f.leader(); await f.ready(parent.id);
  const agent = await f.delegate(parent.id); await f.ready(agent.id);
  await f.finish(agent.id, 'Earlier observer conclusion.');
  const oldPath = f.service().get(agent.id).sessionPath;
  const input = {message:'[wait] Independently verify the packet.', freshContext:true, commandId:'fresh-verifier'};
  await f.service().continueDelegate(parent.id, agent.id, input);
  await f.ready(agent.id);
  const current = f.service().get(agent.id);
  assert.notEqual(current.sessionPath, oldPath);
  assert.equal(current.sessionEstablished, true);
  assert.match(current.objective, /Independently verify/);
  assert.equal((await f.history(agent.id)).history.length, 1);
  assert.match((await f.history(agent.id)).history[0], /Independently verify/);
  assert.equal(JSON.parse(await readFile(oldPath, 'utf8')).history.length, 1);
  assert.ok(f.store().messages(agent.id).some(message => message.text === 'Earlier observer conclusion.'));
  assert.equal(f.service().agents(parent.id).length, 1);
  await f.service().continueDelegate(parent.id, agent.id, input);
  assert.equal(f.service().get(agent.id).sessionPath, current.sessionPath, 'Idempotent retry cannot reset the new session');
});

test('guidance refreshes for user follow-ups and stays pinned across automatic delegate handoffs', async t => {
  const f = await fixture(t);
  const path = join(f.project.repositories[0].path, 'AGENTS.md');
  await writeFile(path, 'First guidance version.');
  const parent = await f.leader(); await f.ready(parent.id);
  const original = f.service().get(parent.id).guidanceRevision;
  const agent = await f.delegate(parent.id); await f.ready(agent.id);
  await writeFile(path, 'Second guidance version.');
  await f.yieldLeader(parent.id); await f.finish(agent.id);
  await f.until(() => f.service().get(parent.id).runCount === 2, 'Lead did not resume');
  assert.equal(f.service().get(parent.id).guidanceRevision, original);
  await f.finish(parent.id);
  await f.service().continue(parent.id, {message:'[wait] New user request.',commandId:'new-guidance'});
  assert.notEqual(f.service().get(parent.id).guidanceRevision, original);
});

test('an unresolved delegate question cannot silently finish or indefinitely suspend its lead', async t => {
  const f=await fixture(t);
  const leader=await f.leader(); await f.ready(leader.id);
  const child=(await f.service().createDelegate(leader.id,{title:'[wait] Color consultation',objective:'[question] Ask for a decision.',commandId:'unresolved-question'})).agent;
  await f.until(()=>f.store().requests(child.id).length>0 && !f.service().live.has(child.id),'Question not saved');
  f.service().live.get(leader.id)!.child.send({type:'fixture-finish',text:'Premature result.'});
  await f.until(()=>f.service().get(leader.id).runCount===2,'Question did not wake lead');
  await f.ready(leader.id);
  f.service().live.get(leader.id)!.child.send({type:'fixture-finish',text:'Still unresolved.'});
  await f.until(()=>f.service().get(leader.id).status==='interrupted' && !f.service().live.has(leader.id),'Lead did not enter recoverable state');
  await assert.rejects(f.service().action(leader.id,'accept',{commandId:'accept-unresolved'}),/pending questions/);
  await f.service().continue(leader.id,{commandId:'recover-unresolved'},true);
  await f.ready(leader.id);
  assert.match((await f.history(leader.id)).history.at(-1)!,/Your delegates need your input/);
  await f.service().action(leader.id,'cancel',{commandId:'cancel-unresolved'});
  assert.equal(f.service().get(child.id).status,'cancelled');
  assert.equal(f.store().requests(child.id)[0].status,'answered');
});
