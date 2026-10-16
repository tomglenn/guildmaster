import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createApp } from '../src/service/server.ts';

test('HTTP worker tokens are scoped to an active lead and its direct delegates', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'guildmaster-delegation-http-'));
  const app = createApp({ dataDir, port: 4173, models: [], workerPath: fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)) });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  function request(path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<{status: number; data: any; headers: Record<string, string>}> {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
    req.url = path; req.method = method ?? (body === undefined ? 'GET' : 'POST');
    req.headers = { host: '127.0.0.1:4173', 'content-type': 'application/json', ...headers };
    return new Promise(resolve => {
      const res = new EventEmitter() as any;
      const responseHeaders: Record<string,string> = {};
      res.statusCode = 200; res.headersSent = false;
      res.setHeader = (key: string, value: string) => { responseHeaders[key.toLowerCase()] = value; };
      res.writeHead = (status: number, values: Record<string,string> = {}) => {
        res.statusCode = status; res.headersSent = true;
        for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
      };
      res.end = (data: string) => resolve({ status: res.statusCode, data: JSON.parse(data), headers: responseHeaders });
      app.server.emit('request', req, res);
    });
  }
  const bootstrap = await request('/api/bootstrap');
  const human = { cookie: bootstrap.headers['set-cookie'].split(';')[0] };
  const first = (await app.service.create({ objective: '[wait] Start a follow-up quest for the first PR.', workspaceMode: 'none', tools: ['read'], commandId: 'alpha' })).quest;
  const second = (await app.service.create({ objective: '[wait] Lead Beta.', workspaceMode: 'none', tools: ['read'], commandId: 'beta' })).quest;
  const token = [...app.service.workerTokens.entries()].find(([, scope]) => scope.questId === first.id)![0];
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await request('/api/projects', undefined, auth)).status, 200);
  const agentsPath = `/api/quests/${first.id}/agents`;
  assert.equal((await request(agentsPath)).status, 401);
  const input = { objective: '[wait] Read the assigned files.', commandId: 'member' };
  const created = await request(agentsPath, input, auth);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const child = created.data.agent;
  const replay = await request(agentsPath, input, auth);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.agent.id, child.id);
  assert.equal((await request(agentsPath, undefined, auth)).data.agents.length, 1);
  assert.equal((await request(`${agentsPath}/${child.id}`, undefined, auth)).status, 200);

  const foreign = (await app.service.createDelegate(second.id, { objective: '[wait] Beta assignment.', commandId: 'foreign-child' })).agent;
  assert.equal((await request(`/api/quests/${second.id}/agents`, undefined, auth)).status, 403);
  assert.equal((await request(`${agentsPath}/${foreign.id}`, undefined, auth)).status, 403);
  assert.equal((await request(`${agentsPath}/${foreign.id}/continue`, { message: 'Cross-parent change', commandId: 'foreign-feedback' }, auth)).status, 403);
  assert.equal((await request(agentsPath, { objective: 'Escalate capabilities', tools: ['bash'], commandId: 'escalate' }, auth)).status, 403);
  assert.equal((await request(agentsPath, { objective: 'Escape assigned roots', repositoryIds: ['foreign-repository'], commandId: 'escape' }, auth)).status, 403);
  assert.equal((await request(`/api/quests/${child.id}/agents`, { objective: 'Nested delegation', commandId: 'nested' }, human)).status, 403);
  const followupPath = `/api/quests/${first.id}/followups`;
  const followupInput = {title:'Fix first PR',objective:'[wait] Fix the identified blockers.',userRequest:first.objective,workspacePolicy:'shared',commandId:'followup'};
  const followup = await request(followupPath,followupInput,auth);
  assert.equal(followup.status,201,JSON.stringify(followup.data));
  assert.equal((await request(followupPath,{...followupInput,commandId:'retry-followup'},auth)).data.quest.id,followup.data.quest.id);
  assert.equal((await request(`/api/quests/${second.id}/followups`,followupInput,auth)).status,403);
  assert.equal((await request(followupPath,{...followupInput,userRequest:'Invented',commandId:'invented'},auth)).status,403);
  assert.equal((await request(followupPath,followupInput,human)).status,403);
  const childSpec = JSON.parse(await readFile(join(dataDir, 'runs', `${child.activeRunId}.json`), 'utf8'));
  assert.equal((await request(`/api/quests/${child.id}/agents`, undefined, { authorization: `Bearer ${childSpec.serviceToken}` })).status, 401);

  assert.equal((await request(followupPath,followupInput,{authorization:`Bearer ${childSpec.serviceToken}`})).status,401);

  for (const [method, path] of [
    ['GET', '/api/settings'], ['POST', '/api/settings/provider'],
    ['POST', '/api/projects'], ['GET', '/api/folders'],
    ['GET', '/api/quests'], ['POST', '/api/quests'], ['POST', '/api/guildmaster'],
    ['POST', `/api/quests/${first.id}/accept`], ['POST', `/api/quests/${first.id}/cancel`],
  ]) {
    const response = await request(path, method === 'POST' ? { commandId: `forbidden-${path}` } : undefined, auth, method);
    assert.equal(response.status, 403, `${method} ${path} must reject the lead token.`);
  }
  app.service.workerTokens.set('stale-run-fixture', { questId: first.id, runId: 'previous-run' });
  assert.equal((await request(agentsPath, undefined, { authorization: 'Bearer stale-run-fixture' })).status, 403);
  app.service.workerTokens.delete('stale-run-fixture');

  await app.service.action(first.id, 'cancel', { commandId: 'cancel-lead' });
  for (let i = 0; i < 100 && app.service.live.has(first.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!app.service.workerTokens.has(token));
  assert.equal((await request(agentsPath, undefined, auth)).status, 401, 'A token from an exited lead must be revoked.');
});
