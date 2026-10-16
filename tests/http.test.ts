import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/service/server.ts';

test('HTTP handler validates local origin and authorization without a TCP listener', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'guildmaster-handler-'));
  const app = createApp({ dataDir, port: 4173, models: [], workerPath: fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)) });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  function request(path: string, body?: any, headers: Record<string, string> = {}, method?: string): Promise<{ status: number; data: any; headers: Record<string, string> }> {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
    req.url = path; req.method = method ?? (body === undefined ? 'GET' : 'POST');
    req.headers = { host: '127.0.0.1:4173', 'content-type': 'application/json', ...headers };
    return new Promise(resolve => {
      const res = new EventEmitter() as any;
      res.statusCode = 200; res.headersSent = false;
      const responseHeaders: Record<string,string> = {};
      res.setHeader = (key: string, value: string) => { responseHeaders[key.toLowerCase()] = value; };
      res.writeHead = (status: number, values: Record<string,string> = {}) => {
        res.statusCode = status; res.headersSent = true;
        for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
      };
      res.end = (data: string) => resolve({ status: res.statusCode, data: JSON.parse(data), headers: responseHeaders });
      app.server.emit('request', req, res);
    });
  }
  const spoof = { questId: 'forged-parent', runId: 'forged-run', text: 'FORGED_SOURCE_MUST_NOT_REACH_WORKER' };
  const body = { objective: 'A report from the HTTP handler', workspaceMode: 'none', commandId: 'handler-create', sourceRequest: spoof, delegationSource: spoof };
  assert.equal((await request('/api/quests', body)).status, 401);
  assert.equal((await request('/api/bootstrap', undefined, { host: 'evil.example:4173' })).status, 403);
  assert.equal((await request('/api/bootstrap', undefined, { origin: 'https://evil.example' })).status, 403);
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = bootstrap.headers['set-cookie'].split(';')[0];
  const created = await request('/api/quests', body, { cookie });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.quest.id;
  const detail = await request(`/api/quests/${id}`, undefined, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.quest.id, id);
  assert.ok(Array.isArray(detail.data.toolCalls));
  assert.equal(detail.data.messages[0].text, body.objective);
  assert.equal(detail.data.quest.sourceRequest, undefined);
  assert.doesNotMatch(JSON.stringify(detail.data.messages), /FORGED_SOURCE_MUST_NOT_REACH_WORKER/);
  assert.equal((await request('/api/quests', body, { cookie, origin: 'https://evil.example' })).status, 403);
  const invalid = await request('/api/quests', { ...body, commandId: 'bad-model-tools', tools: ['unknown'] }, { cookie });
  assert.equal(invalid.status, 400);

  const quest = app.service.get(id);
  app.store.message(id, 'assistant', 'PRIVATE_FULL_TRANSCRIPT_MARKER');
  const originalRequest = 'Investigate durability. Remember the exact phrase: silver marshmallow. Do not change files.';
  const originalRun = 'guildmaster-source-first';
  app.store.save({ ...quest, id: 'guildmaster-fixture', kind: 'guildmaster', workspacePath: await realpath(dataDir), tools: ['read'], status: 'running', activeRunId: originalRun });
  app.store.message('guildmaster-fixture', 'user', 'UNRELATED_OLDER_GUILDMASTER_HISTORY');
  app.store.message('guildmaster-fixture', 'user', originalRequest);
  app.store.run(originalRun, 'guildmaster-fixture', { status: 'running', prompt: originalRequest });
  app.service.gmTokens.set('guildmaster-scoped-token', 'guildmaster-fixture');
  const gmAuth = { authorization: 'Bearer guildmaster-scoped-token' };
  const folderPath = `/api/folders?path=${encodeURIComponent(dataDir)}`;
  assert.equal((await request(folderPath)).status, 401);
  assert.equal((await request(folderPath, undefined, gmAuth)).status, 403);
  assert.equal((await request(folderPath, undefined, { cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(folderPath, undefined, { cookie, host: 'evil.example:4173' })).status, 403);
  // The user can browse unregistered folders to choose a new project repository.
  const folders = await request(folderPath, undefined, { cookie });
  assert.equal(folders.status, 200, JSON.stringify(folders.data));
  assert.equal(folders.data.path, await realpath(dataDir));
  assert.ok(Array.isArray(folders.data.directories));
  assert.equal((await request('/api/folders?path=relative', undefined, { cookie })).status, 400);
  assert.equal((await request(folderPath, {}, { cookie })).status, 405);
  const settingsView = await request('/api/settings', undefined, { cookie });
  assert.equal(settingsView.status, 200, JSON.stringify(settingsView.data));
  const savedProvider = await request('/api/settings/provider', { providerId: 'anthropic', apiKey: 'fixture-http-secret-not-a-real-key' }, { cookie });
  assert.equal(savedProvider.status, 200, JSON.stringify(savedProvider.data));
  assert.doesNotMatch(JSON.stringify(savedProvider.data), /fixture-http-secret/);
  const savedCredentials = JSON.parse(await readFile(join(dataDir, 'engine', 'auth.json'), 'utf8'));
  assert.equal(savedCredentials.anthropic.key, 'fixture-http-secret-not-a-real-key');
  const settingsReadback = await request('/api/settings', undefined, { cookie });
  assert.equal(settingsReadback.status, 200);
  assert.doesNotMatch(JSON.stringify(settingsReadback.data), /fixture-http-secret/);
  for (const [method, path] of [
    ['GET', '/api/settings'],
    ['POST', '/api/settings/provider'],
    ['DELETE', '/api/settings/provider/anthropic'],
    ['POST', '/api/settings/preferences'],
    ['POST', '/api/settings/import-pi'],
    ['POST', '/api/settings/login'],
    ['GET', '/api/settings/login/fixture'],
    ['POST', '/api/settings/login/fixture'],
    ['DELETE', '/api/settings/login/fixture'],
  ]) assert.equal((await request(path, method === 'POST' ? {} : undefined, gmAuth, method)).status, 403, `${method} ${path} must be human-only`);
  const board = await request('/api/quests', undefined, gmAuth);
  assert.equal(board.status, 200);
  assert.equal(board.data[0].instructions, undefined);
  assert.equal(board.data[0].result, undefined);
  assert.doesNotMatch(JSON.stringify(board.data), /PRIVATE_FULL_TRANSCRIPT_MARKER/);
  const inspected = await request(`/api/quests/${id}`, undefined, gmAuth);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.data.messages, undefined);
  assert.equal(inspected.data.events, undefined);
  assert.doesNotMatch(JSON.stringify(inspected.data), /PRIVATE_FULL_TRANSCRIPT_MARKER/);
  for (const action of ['accept', 'cancel', 'resume', 'archive', 'restore']) {
    assert.equal((await request(`/api/quests/${id}/${action}`, { commandId: `gm-${action}` }, gmAuth)).status, 403);
  }
  assert.equal((await request(`/api/quests/${id}/continue`, { message: 'Continue outside current workspace', commandId: 'gm-outside' }, gmAuth)).status, 403);
  assert.equal((await request('/api/quests', { objective: 'Escalate tools', workspaceMode: 'existing', workspacePath: dataDir, tools: ['write'], commandId: 'gm-escalate' }, gmAuth)).status, 403);
  assert.equal((await request('/api/quests', { objective: 'Escalate workspace', workspaceMode: 'existing', workspacePath: tmpdir(), tools: ['read'], commandId: 'gm-other-workspace' }, gmAuth)).status, 403);
  const delegatedBody = { objective: 'An authorized delegated report', workspaceMode: 'existing', commandId: 'gm-authorized-create', sourceRequest: spoof, delegationSource: spoof };
  const delegated = await request('/api/quests', delegatedBody, gmAuth);
  assert.equal(delegated.status, 201, JSON.stringify(delegated.data));
  assert.equal(delegated.data.quest.instructions, undefined);
  assert.equal(delegated.data.quest.sessionPath, undefined);
  const delegatedId = delegated.data.quest.id;
  const delegatedDetail = app.service.detail(delegatedId);
  assert.equal(delegatedDetail.messages[0].source,'guildmaster');
  assert.equal(delegatedDetail.messages[0].displayText,delegatedBody.objective);
  assert.deepEqual(delegatedDetail.quest.sourceRequest, { questId: 'guildmaster-fixture', runId: originalRun, text: originalRequest });
  const delegatedPrompt = delegatedDetail.messages[0].text;
  assert.match(delegatedPrompt, /An authorized delegated report/);
  assert.match(delegatedPrompt, /silver marshmallow/);
  assert.doesNotMatch(delegatedPrompt, /UNRELATED_OLDER_GUILDMASTER_HISTORY|FORGED_SOURCE_MUST_NOT_REACH_WORKER/);
  const repeated = await request('/api/quests', delegatedBody, gmAuth);
  assert.equal(repeated.status, 201, JSON.stringify(repeated.data));
  assert.equal(repeated.data.quest.id, delegatedId);
  assert.equal(app.service.detail(delegatedId).messages.filter(m => m.role === 'user').length, 1);
  const scratch = await request('/api/quests', { objective: 'A report with no project', workspaceMode: 'none', commandId: 'gm-scratch-create' }, gmAuth);
  assert.equal(scratch.status, 201);
  const scratchId = scratch.data.quest.id;
  for (let i = 0; i < 60 && app.service.get(scratchId).status !== 'awaiting_review'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.service.get(scratchId).status, 'awaiting_review');
  const followupRequest = 'Explain the most important risk. Keep the new phrase: violet teapot.';
  const followupRun = 'guildmaster-source-followup';
  const gm = app.service.get('guildmaster-fixture');
  app.store.save({ ...gm, activeRunId: followupRun });
  app.store.message(gm.id, 'user', followupRequest);
  app.store.run(followupRun, gm.id, { status: 'running', prompt: followupRequest });
  const feedbackBody = { message: 'Add a brief summary', commandId: 'gm-scratch-followup', sourceRequest: spoof, delegationSource: spoof };
  const sessionBefore = app.service.get(scratchId).sessionPath;
  const scratchFeedback = await request(`/api/quests/${scratchId}/continue`, feedbackBody, gmAuth);
  assert.equal(scratchFeedback.status, 200, JSON.stringify(scratchFeedback.data));
  assert.equal(scratchFeedback.data.quest.result, undefined);
  assert.equal(scratchFeedback.data.quest.instructions, undefined);
  const scratchUserMessages = app.service.detail(scratchId).messages.filter(m => m.role === 'user');
  assert.equal(scratchUserMessages.length, 2);
  assert.match(scratchUserMessages[0].text, /silver marshmallow/);
  assert.match(scratchUserMessages[1].text, /Add a brief summary/);
  assert.match(scratchUserMessages[1].text, /violet teapot/);
  assert.doesNotMatch(scratchUserMessages[1].text, /UNRELATED_OLDER_GUILDMASTER_HISTORY|FORGED_SOURCE_MUST_NOT_REACH_WORKER|silver marshmallow/);
  assert.equal(app.service.get(scratchId).sessionPath, sessionBefore);
  const repeatedFeedback = await request(`/api/quests/${scratchId}/continue`, feedbackBody, gmAuth);
  assert.equal(repeatedFeedback.status, 200, JSON.stringify(repeatedFeedback.data));
  assert.equal(app.service.detail(scratchId).messages.filter(m => m.role === 'user').length, 2);
  for (let i = 0; i < 60 && app.service.get(scratchId).status !== 'awaiting_review'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.service.get(scratchId).status, 'awaiting_review');
  const savedSession = JSON.parse(await readFile(sessionBefore, 'utf8'));
  assert.equal(savedSession.history.length, 2);
  assert.match(savedSession.history[0], /silver marshmallow/);
  assert.match(savedSession.history[1], /violet teapot/);
  const humanFeedback = await request(`/api/quests/${scratchId}/continue`, { message: 'Human feedback without delegated context', commandId: 'human-feedback-spoof', sourceRequest: spoof, delegationSource: spoof }, { cookie });
  assert.equal(humanFeedback.status, 200, JSON.stringify(humanFeedback.data));
  assert.equal(app.service.detail(scratchId).messages.filter(m => m.role === 'user').at(-1)?.text, 'Human feedback without delegated context');
  for (const action of ['archive', 'restore']) {
    assert.equal((await request(`/api/quests/${id}/${action}`, { commandId: `unauthenticated-${action}` })).status, 401);
  }
  assert.equal((await request(`/api/quests/${id}/accept`, { commandId: 'http-accept-archive' }, { cookie })).status, 200);
  const archived = await request(`/api/quests/${id}/archive`, { commandId: 'http-archive' }, { cookie });
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.ok(archived.data.quest.archivedAt);
  const humanList = await request('/api/quests', undefined, { cookie });
  assert.equal(humanList.data.find((q: any) => q.id === id).archivedAt, archived.data.quest.archivedAt);
  const gmList = await request('/api/quests', undefined, gmAuth);
  assert.equal(gmList.data.find((q: any) => q.id === id).archivedAt, archived.data.quest.archivedAt);
  const restored = await request(`/api/quests/${id}/restore`, { commandId: 'http-restore' }, { cookie });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.quest.archivedAt, undefined);
  assert.equal(restored.data.quest.status, 'accepted');

  const repositoryPath = join(dataDir, 'registered-project'); await mkdir(repositoryPath);
  const projectInput = { name: 'Named project', aliases: ['named'], instructions: 'Keep changes scoped.',
    repositories: [{ name: 'Main', path: repositoryPath }], commandId: 'http-project-create' };
  assert.equal((await request('/api/projects', projectInput)).status, 401);
  const projectResponse = await request('/api/projects', projectInput, gmAuth);
  assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.data));
  const project = projectResponse.data.project;
  const projectId = project.id;
  assert.equal((await request('/api/projects', projectInput, { cookie })).data.project.id, projectId);
  const agentProjects = (await request('/api/projects', undefined, gmAuth)).data;
  assert.equal(agentProjects[0].id, projectId);
  assert.equal(agentProjects[0].instructions, undefined);
  const inspectedProject = (await request('/api/projects/named', undefined, gmAuth)).data.project;
  assert.equal(inspectedProject.id, projectId);
  assert.equal(inspectedProject.instructions, 'Keep changes scoped.');
  assert.equal((await request(`/api/projects/${projectId}`, { ...project, name: 'Agent rename', commandId: 'gm-project-edit' }, gmAuth)).status, 403);
  assert.equal((await request('/api/projects/default', { projectId, commandId: 'gm-project-default' }, gmAuth)).status, 404);
  assert.equal((await request('/api/projects/default', { projectId, commandId: 'http-project-default' }, { cookie })).status, 404);
  const projectBootstrap = (await request('/api/bootstrap')).data;
  assert.equal(Object.hasOwn(projectBootstrap, 'defaultProjectId'), false);
  assert.equal(projectBootstrap.projects[0].id, projectId);
  assert.equal((await request('/api/quests', { objective: 'Attempt expanded tools', projectId, tools: ['write'], commandId: 'gm-project-escalation' }, gmAuth)).status, 403);
  // A named registered project can be delegated without changing Guildmaster's existing raw cwd.
  const projectQuest = await request('/api/quests', { objective: 'Inspect the named project', projectId: 'named', commandId: 'gm-project-quest' }, gmAuth);
  assert.equal(projectQuest.status, 201, JSON.stringify(projectQuest.data));
  const projectQuestId = projectQuest.data.quest.id;
  assert.equal(projectQuest.data.quest.project.id, projectId);
  assert.equal(projectQuest.data.quest.workspacePath, await realpath(repositoryPath));
  for (let i = 0; i < 60 && app.service.get(projectQuestId).status !== 'awaiting_review'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const replacementPath = join(dataDir, 'replacement-project'); await mkdir(replacementPath);
  assert.equal((await request(`/api/projects/${projectId}`, { ...project, name: 'Renamed project', repositories: [{ ...project.repositories[0], path: replacementPath }], commandId: 'http-project-edit' }, { cookie })).status, 200);
  const projectFollowup = await request(`/api/quests/${projectQuestId}/continue`, { message: 'Continue using your saved workspace', commandId: 'gm-project-followup' }, gmAuth);
  assert.equal(projectFollowup.status, 200, JSON.stringify(projectFollowup.data));
  assert.equal(app.service.get(projectQuestId).workspacePath, await realpath(repositoryPath));
  assert.equal(app.service.get(projectQuestId).project?.name, 'Named project');
  const guidesPath = join(dataDir, 'guides'); await mkdir(guidesPath);
  const appendPath = '/api/projects/named/repositories';
  const addition = { repositories: [{ name: 'Guides', path: guidesPath, description: 'Where our guide content lives.' }], commandId: 'gm-project-add-repository' };
  assert.equal((await request(appendPath, addition)).status, 401);
  assert.equal((await request(appendPath, addition, { cookie, origin: 'https://evil.example' })).status, 403);
  const appended = await request(appendPath, addition, gmAuth);
  assert.equal(appended.status, 200, JSON.stringify(appended.data));
  assert.equal(appended.data.project.name, 'Renamed project');
  assert.equal(appended.data.project.instructions, 'Keep changes scoped.');
  assert.equal(appended.data.project.repositories[0].id, project.repositories[0].id);
  assert.equal(appended.data.project.repositories[1].description, 'Where our guide content lives.');
  assert.deepEqual((await request(appendPath, addition, gmAuth)).data, appended.data);
  const humanAddition = { repositories: [{ name: 'Original checkout', path: repositoryPath }], commandId: 'human-project-add-repository' };
  const humanAppended = await request(`/api/projects/${projectId}/repositories`, humanAddition, { cookie });
  assert.equal(humanAppended.status, 200, JSON.stringify(humanAppended.data));
  assert.equal(humanAppended.data.project.repositories.length, 3);
  const invalidAddition = await request(appendPath, { repositories: [{ name: 'Missing', path: join(dataDir, 'missing-addition') }], commandId: 'gm-invalid-repository' }, gmAuth);
  assert.equal(invalidAddition.status, 400);
  assert.equal(app.store.project(projectId)?.repositories.length, 3);
  assert.equal((await request(`/api/projects/${projectId}`, { ...appended.data.project, commandId: 'gm-still-no-replacement' }, gmAuth)).status, 403);

  assert.equal((await request(`/api/projects/${projectId}/archive`, { commandId: 'unauthorized-project-archive' })).status, 401);
  assert.equal((await request(`/api/projects/${projectId}/archive`, { commandId: 'evil-project-archive' }, { cookie, origin: 'https://evil.example' })).status, 403);
  const archivedProject = await request(`/api/projects/${projectId}/archive`, { commandId: 'gm-archive-project' }, gmAuth);
  assert.equal(archivedProject.status, 200, JSON.stringify(archivedProject.data));
  assert.ok(archivedProject.data.project.archivedAt);
  assert.deepEqual((await request('/api/projects', undefined, gmAuth)).data, []);
  const allProjects = (await request('/api/projects?includeArchived=true', undefined, gmAuth)).data;
  assert.equal(allProjects[0].archivedAt, archivedProject.data.project.archivedAt);
  assert.ok((await request('/api/bootstrap')).data.projects[0].archivedAt);
  assert.equal((await request('/api/quests', { objective: 'No new archived work', projectId, commandId: 'archived-project-quest' }, gmAuth)).status, 409);
  const restoredProject = await request(`/api/projects/${projectId}/restore`, { commandId: 'human-restore-project' }, { cookie });
  assert.equal(restoredProject.status, 200, JSON.stringify(restoredProject.data));
  assert.equal(restoredProject.data.project.archivedAt, undefined);
  assert.equal((await request('/api/projects', undefined, gmAuth)).data.length, 1);

  // Lead credentials can manage only this quest's delegates, never the registry or another quest.
  const leadId = 'lead-scope-fixture'; const leadRun = 'lead-scope-run';
  app.store.save({ ...quest, id: leadId, kind: 'quest', status: 'running', activeRunId: leadRun, tools: ['read'], project: undefined, workspaces: undefined });
  app.store.run(leadRun, leadId, { prompt: 'Coordinate a bounded investigation.' });
  app.service.workerTokens.set('lead-scoped-token', { questId: leadId, runId: leadRun });
  const leadAuth = { authorization: 'Bearer lead-scoped-token' };
  assert.equal((await request(`/api/projects/${projectId}/archive`, { commandId: 'lead-archive-project' }, leadAuth)).status, 403);
  app.service.workerEvent(leadId,leadRun,{type:'message_start',messageId:'http-stream-message'});
  app.service.workerEvent(leadId,leadRun,{type:'delta',messageId:'http-stream-message',text:'Inspecting files live.'});
  app.service.workerEvent(leadId,leadRun,{type:'tool_start',toolCallId:'http-tool',tool:'read',detail:'README.md'});
  const liveDetail = await request(`/api/quests/${leadId}`,undefined,{cookie});
  assert.deepEqual(liveDetail.data.live,{runId:leadRun,messageId:'http-stream-message',text:'Inspecting files live.'});
  assert.equal(liveDetail.data.toolCalls[0].status,'running');
  app.service.workerEvent(leadId,leadRun,{type:'tool_end',toolCallId:'http-tool',tool:'read',output:'Read completed.',isError:false});
  app.service.workerEvent(leadId,leadRun,{type:'message',messageId:'http-stream-message',text:'Inspecting files live.'});
  const savedDetail = await request(`/api/quests/${leadId}`,undefined,{cookie});
  assert.equal(savedDetail.data.live,undefined);
  assert.equal(savedDetail.data.toolCalls[0].status,'completed');
  assert.equal(savedDetail.data.messages.at(-1).id,'http-stream-message');

  assert.equal((await request('/api/projects', undefined, leadAuth)).status, 200);
  for (const path of ['/api/bootstrap','/api/quests','/api/settings',`/api/quests/${id}/agents`]) {
    assert.equal((await request(path, undefined, leadAuth)).status, 403, path);
  }
  assert.equal((await request(`/api/quests/${leadId}/agents`, undefined, gmAuth)).status, 403);
  const member = await request(`/api/quests/${leadId}/agents`, { objective: '[wait] Inspect the assigned files.', commandId: 'lead-member' }, leadAuth);
  assert.equal(member.status, 201, JSON.stringify(member.data));
  assert.equal(member.data.agent.kind, 'delegate');
  assert.equal(member.data.agent.parentQuestId, leadId);
  const memberId = member.data.agent.id;
  assert.equal((await request(`/api/quests/${leadId}/agents`, undefined, leadAuth)).data.agents.length, 1);
  assert.equal((await request(`/api/quests/${leadId}/agents/${memberId}`, undefined, {cookie})).data.quest.id, memberId);
  assert.equal((await request(`/api/quests/${leadId}/agents/${id}`, undefined, leadAuth)).status, 403);
  assert.equal((await request(`/api/quests/${leadId}/agents`, { objective: 'Escalate', tools: ['bash'], commandId:'lead-escalate' }, leadAuth)).status, 403);
  const memberSpec = JSON.parse(await readFile(join(dataDir, 'runs', member.data.agent.activeRunId + '.json'), 'utf8'));
  assert.ok(!app.service.workerTokens.has(memberSpec.serviceToken));
  assert.ok(!app.service.gmTokens.has(memberSpec.serviceToken));
  const waiting = await request(`/api/quests/${leadId}/wait`, { agentIds:[memberId],commandId:'lead-wait' }, leadAuth);
  assert.equal(waiting.status, 200); assert.equal(waiting.data.waiting, true);
  app.service.workerEvent(leadId, leadRun, {type:'yielded'});
  assert.equal((await request(`/api/quests/${leadId}/agents`, undefined, leadAuth)).status, 403, 'Yielded run token is fenced.');
  await app.service.action(leadId, 'cancel', {commandId:'lead-cleanup'});

});

test('HTTP API authenticates requests and returns the durable quest detail', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'guildmaster-http-'));
  const app = await createApp({ dataDir, port: 0, workerPath: fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)) });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let address: { url: string; token: string };
  try { address = await app.listen(); }
  catch (error: any) {
    if (error.code === 'EPERM') { t.skip('This sandbox disallows localhost listeners; service/worker integration is exercised without sockets.'); return; }
    throw error;
  }
  const body = { objective: 'Create a report through HTTP', workspaceMode: 'none', commandId: 'http-create' };
  const unauthorized = await fetch(`${address.url}/api/quests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(unauthorized.status, 401);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${address.token}` };
  const created = await fetch(`${address.url}/api/quests`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.ok(created.ok, await created.clone().text());
  const { quest } = await created.json() as any;
  const detail = await fetch(`${address.url}/api/quests/${quest.id}`, { headers });
  assert.equal(detail.status, 200);
  const result = await detail.json() as any;
  assert.equal(result.quest.id, quest.id);
  assert.equal(result.messages[0].text, body.objective);
  assert.ok(Array.isArray(result.events));
  assert.ok(Array.isArray(result.requests));
});


test('HTTP answers decode browser-encoded question IDs for live and restarted workers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'guildmaster-answer-http-'));
  const options = { dataDir, port: 4173, models: [], workerPath: fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)) };
  let app = createApp(options);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  function request(path: string, body?: any, headers: Record<string, string> = {}, method?: string): Promise<{ status: number; data: any; headers: Record<string, string> }> {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
    req.url = path; req.method = method ?? (body === undefined ? 'GET' : 'POST');
    req.headers = { host: '127.0.0.1:4173', 'content-type': 'application/json', ...headers };
    return new Promise(resolve => {
      const res = new EventEmitter() as any;
      res.statusCode = 200; res.headersSent = false;
      const responseHeaders: Record<string,string> = {};
      res.setHeader = (key: string, value: string) => { responseHeaders[key.toLowerCase()] = value; };
      res.writeHead = (status: number, values: Record<string,string> = {}) => {
        res.statusCode = status; res.headersSent = true;
        for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
      };
      res.end = (data: string) => resolve({ status: res.statusCode, data: JSON.parse(data), headers: responseHeaders });
      app.server.emit('request', req, res);
    });
  }
  async function waitFor(id: string, status: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const detail = app.service.detail(id);
      if (detail.quest.status === status) return detail;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Quest did not reach ${status}`);
  }
  for (const restart of [false, true]) {
    let bootstrap = await request('/api/bootstrap');
    let cookie = bootstrap.headers['set-cookie'].split(';')[0];
    const created = await request('/api/quests', { objective: '[question] Choose a color', workspaceMode: 'none', commandId: `question-${restart}` }, { cookie });
    assert.equal(created.status, 201);
    const id = created.data.quest.id;
    await waitFor(id, 'awaiting_input');
    const detail = await request(`/api/quests/${id}`, undefined, { cookie });
    const question = detail.data.requests.find((item: any) => item.status === 'pending');
    assert.ok(question.id.includes(':'));
    if (restart) {
      await app.close(); app = createApp(options);
      bootstrap = await request('/api/bootstrap'); cookie = bootstrap.headers['set-cookie'].split(';')[0];
    }
    const url = `/api/requests/${encodeURIComponent(question.id)}/answer`;
    const answer = { answer: 'Blue', commandId: `answer-${restart}` };
    const response = await request(url, answer, { cookie });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal((await request(url, answer, { cookie })).status, 200, 'A transport retry must remain idempotent.');
    const finished = await waitFor(id, 'awaiting_review');
    const saved = finished.requests.find(item => item.id === question.id)!;
    assert.equal(saved.status, 'answered');
    assert.equal(saved.answer, 'Blue');
    assert.ok(finished.messages.some(message => message.id === saved.answerMessageId));
    assert.equal((await request(url, { answer: 'Green', commandId: `duplicate-${restart}` }, { cookie })).status, 409);
  }
});
