import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import { delegationTools } from '../src/engine/delegation-tools.ts';
import type { WorkerSpec } from '../src/engine/protocol.ts';

async function fixture(t: TestContext, git = false) {
  const root = await mkdtemp(join(tmpdir(), 'guildmaster-followups-'));
  const dataDir = join(root,'data');
  const repo = join(root,'repo'); await mkdir(repo);
  if (git) {
    for (const args of [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','Initial']]) execFileSync('git',args,{cwd:repo});
  }
  const store = new Store(dataDir);
  const service = new QuestService({store,dataDir,defaultWorkspace:root});
  service.schedule = () => {}; // Test durable orchestration without starting model workers.
  t.after(async () => {await service.close();store.close();await rm(root,{recursive:true,force:true});});
  const project = (await service.saveProject({name:'Example',repositories:[{name:'Source',path:repo}],commandId:'project'})).project;
  const parent = (await service.create({title:'Review PRs',objective:'Start quests for the three requested PR fixes.',projectId:project.id,tools:['read','bash'],model:'test:model',instructions:'Preserve unrelated edits.',commandId:'parent'})).quest;
  parent.status='running';store.save(parent);
  service.modelDefaults.initialize('test:quest');
  const input = {title:'Fix PR 1',objective:'Fix the concrete review blockers. PR: https://example.test/pull/1. Do not push.',userRequest:parent.objective,workspacePolicy:'shared',commandId:'first'};
  return {root,store,service,parent,project,input};
}

test('requested follow-ups are independent linked quests with scoped context and capabilities',async t => {
  const {service,store,parent,project,input} = await fixture(t);
  const created = await service.createFollowup(parent.id,input,parent.activeRunId!);
  const q = created.quest;
  assert.equal(q.kind,'quest'); assert.equal(q.parentQuestId,undefined);
  assert.equal(q.project?.id,project.id);
  assert.deepEqual(q.tools,parent.tools); assert.equal(q.model,'test:quest');
  assert.equal(q.instructions,parent.instructions);
  assert.notEqual(q.sessionPath,parent.sessionPath);
  assert.equal(q.sourceRequest?.role,'quest'); assert.equal(q.sourceRequest?.questId,parent.id);
  const initial = store.messages(q.id)[0];
  assert.equal(initial.source,'quest_lead');assert.equal(initial.displayText,input.objective);
  assert.match(initial.text,/Assigned task from quest lead/);
  assert.match(initial.text,/not.*additional tool authorization/);
  assert.equal(service.detail(q.id).originQuest?.id,parent.id);
  assert.deepEqual(service.detail(parent.id).followups.map(q=>q.id),[q.id]);
  assert.equal(service.agents(parent.id).length,0);
  assert.equal(service.get(parent.id).status,'running');
  await service.action(parent.id,'cancel',{commandId:'cancel-parent'});
  assert.equal(service.get(q.id).status,'queued');
});

test('identical follow-up retries with different tool IDs create one quest',async t => {
  const {service,parent,input} = await fixture(t);
  const [a,b] = await Promise.all([service.createFollowup(parent.id,input,parent.activeRunId!), service.createFollowup(parent.id,{...input,commandId:'retry'},parent.activeRunId!)]);
  assert.equal(a.quest.id,b.quest.id);
  assert.equal(service.detail(parent.id).followups.length,1);
  await assert.rejects(service.createFollowup(parent.id,{...input,title:'Changed request'},parent.activeRunId!),/different request/);
});

test('authorization must cite the latest direct user message; inherited briefs cannot cascade',async t => {
  const {service,store,parent,input} = await fixture(t);
  await assert.rejects(service.createFollowup(parent.id,{...input,userRequest:'Invented approval'},parent.activeRunId!),/latest direct user/);
  const next = (await service.createFollowup(parent.id,input,parent.activeRunId!)).quest;
  next.status='running';store.save(next);
  await assert.rejects(service.createFollowup(next.id,{...input,userRequest:input.objective,commandId:'recursive'},next.activeRunId!),/latest direct user/);
  store.message(parent.id,'user','Stop. Just summarize the findings.',undefined,{source:'user'});
  await assert.rejects(service.createFollowup(parent.id,{...input,commandId:'after-stop'},parent.activeRunId!),/latest direct user/);
  assert.equal(service.detail(parent.id).followups.length,1);
});

test('stale runs and delegates cannot create follow-up quests',async t => {
  const {service,store,parent,input} = await fixture(t);
  await assert.rejects(service.createFollowup(parent.id,input,'stale-run'),/no longer active/);
  const delegate = {...parent,id:'delegate',kind:'delegate' as const,parentQuestId:parent.id};store.save(delegate);
  await assert.rejects(service.createFollowup(delegate.id,input,delegate.activeRunId!),/Only quest leads/);
});

test('project selection is explicit when changed and arbitrary capability/path overrides are ignored',async t => {
  const {service,parent,input,project} = await fixture(t);
  const q = (await service.createFollowup(parent.id,{...input,projectId:null,workspacePath:'/tmp',workspaceMode:'existing',tools:['write'],model:'other'},parent.activeRunId!)).quest;
  assert.equal(q.project,undefined);assert.equal(q.workspaceMode,'none');assert.notEqual(q.workspacePath,'/tmp');
  assert.deepEqual(q.tools,parent.tools);assert.equal(q.model,'test:quest');
  await assert.rejects(service.createFollowup(parent.id,{...input,repositoryIds:['foreign'],commandId:'foreign-repo'},parent.activeRunId!),/repository/i);
  await service.projectAction(project.id,'archive',{commandId:'archive-project'});
  await assert.rejects(service.createFollowup(parent.id,{...input,title:'Other fix',commandId:'archived'},parent.activeRunId!),/archived/i);
});

test('isolated follow-up starts from registered source with its own checkout and persists links',async t => {
  const {service,store,parent,input,project} = await fixture(t,true);
  const q = (await service.createFollowup(parent.id,{...input,workspacePolicy:'isolated'},parent.activeRunId!)).quest;
  assert.equal(q.workspacePolicy,'isolated');
  assert.notEqual(q.workspacePath,parent.workspacePath);
  assert.equal(q.workspaces?.[0].sourcePath,project.repositories[0].path);
  assert.equal(q.sourceRequest?.questId,parent.id);
  assert.equal(service.detail(q.id).messages[0].source,'quest_lead');
  // A fresh read from persistent storage retains provenance independently of the parent lifecycle.
  assert.equal(store.get(q.id)?.sourceRequest?.role,'quest');
});

test('follow-up tool is available only to leads, requires a user quote, and prohibits unsolicited creation',() => {
  const spec: WorkerSpec = {cwd:'.',prompt:'Start the requested quest.',sessionPath:'fixture-session',role:'quest',questId:'quest',runId:'run',tools:['read'],serviceUrl:'http://127.0.0.1:4173',serviceToken:'fixture'};
  const tool = delegationTools(spec,()=>{}).find(t=>t.name==='create_followup_quest')!;
  assert.ok(tool);assert.ok(tool.parameters.required?.includes('userRequest'));
  assert.match(tool.description,/ONLY when the user explicitly asks/);
  assert.match(tool.description,/Never create quests automatically/);
  assert.equal(delegationTools({...spec,role:'delegate'},()=>{}).length,0);
});

test('older running services return a clear restart instruction without creating anything',async t => {
  const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async (url:URL) => {urls.push(String(url));return new Response(JSON.stringify({capabilities:{}}));});
  const spec: WorkerSpec = {cwd:'.',prompt:'Start the requested quest.',sessionPath:'fixture-session',role:'quest',questId:'quest',runId:'run',tools:[],serviceUrl:'http://127.0.0.1:4173',serviceToken:'fixture'};
  const tool = delegationTools(spec,()=>{}).find(t=>t.name==='create_followup_quest')!;
  await assert.rejects(tool.execute('call',{title:'Fix',objective:'Fix blockers',userRequest:'Start a quest',workspacePolicy:'shared'},undefined,undefined,{} as any),/Restart the local service/);
  assert.deepEqual(urls,['http://127.0.0.1:4173/api/health']);
});
