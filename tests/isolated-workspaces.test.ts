import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/service/store.ts';
import {QuestService} from '../src/service/quests.ts';
import {readGuidance} from '../src/service/isolated-workspaces.ts';
import {guidanceTools} from '../src/engine/guidance-tools.ts';
import type {WorkerSpec} from '../src/engine/protocol.ts';
import {createApp} from '../src/service/server.ts';
import {pathToFileURL} from 'node:url';
const exec = promisify(execFile);

async function fixture(t:TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'guildmaster-isolation-')));
  const repo = join(root,'repo'), dataDir = join(root,'data'); await mkdir(repo);
  const put = async(path:string,body:string)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,body);};
  const git = async(...args:string[])=>(await exec('git',args,{cwd:repo})).stdout.trim();
  await git('init'); await git('config','user.email','fixture@example.invalid'); await git('config','user.name','Fixture');
  await put(join(repo,'source.txt'),'original source'); await git('add','source.txt'); await git('commit','-m','Initial');
  const commit = await git('rev-parse','HEAD');
  await put(join(repo,'source.txt'),'local edits must survive');
  await put(join(repo,'.env'),'FIXTURE_ONLY=not-a-real-secret');
  await put(join(repo,'AGENTS.md'),'Use /inspect before substantive work.');
  await put(join(repo,'src/AGENTS.md'),'Nested source instructions.');
  const header = '---\nname: inspect\ndescription: Inspect the assigned code.\n---\n';
  await put(join(repo,'.claude/skills/inspect/SKILL.md'),header+'Read `.cursor/skills/inspect/SKILL.md` and follow it.');
  await put(join(repo,'.cursor/skills/inspect/SKILL.md'),header+'Run the sibling check.mjs in the assigned working directory.');
  await put(join(repo,'.cursor/skills/inspect/check.mjs'),`import {writeFileSync,existsSync} from 'node:fs';\nimport {join} from 'node:path';\nwriteFileSync('script-output.txt',process.cwd());\nconsole.log('SCRIPT_OK '+process.cwd());\nif (process.argv[2]) while (!existsSync(join(process.argv[2],'release'))) await new Promise(r=>setTimeout(r,20));\n`);
  let store = new Store(dataDir);
  let service = new QuestService({store,dataDir,defaultWorkspace:repo,workerPath:resolve('tests/fixtures/worker.ts')});
  t.after(async()=>{await service.close();store.close();await rm(root,{recursive:true,force:true});});
  const project = (await service.saveProject({name:'Example',repositories:[{name:'App',path:repo}],commandId:'project'})).project;
  const repositoryId = project.repositories[0].id;
  const until = async(predicate:()=>boolean,description='condition')=>{for(let n=0;n<500;n++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail(description+' '+JSON.stringify(store.list()));};
  const ready = async(id:string)=>until(()=>service.live.has(id)&&!store.pendingDeliveries(id).length,'worker readiness');
  const parent = (await service.create({objective:'[wait] Coordinate work.',projectId:project.id,tools:['read','bash'],commandId:'lead'})).quest;
  await ready(parent.id);
  return {root,repo,dataDir,put,git,commit,repositoryId,parent,until,ready,service:()=>service,store:()=>store,
    delegate:(commandId:string=randomUUID(),extra:Record<string,unknown>={})=>service.createDelegate(parent.id,{objective:'[wait] Inspect independently.',isolation:[{repositoryId,commit}],commandId,...extra}),
    finish:async(id:string)=>{await ready(id);service.live.get(id)!.child.send({type:'fixture-finish',text:'Done'});await until(()=>!service.live.has(id),'worker exit');},
    restart:async()=>{await service.close();store.close();store=new Store(dataDir);service=new QuestService({store,dataDir,defaultWorkspace:repo,workerPath:resolve('tests/fixtures/worker.ts')});}
  };
}

test('isolated agents run real scripts concurrently at one commit without changing the shared checkout',async t=>{
  const f=await fixture(t);
  const first=(await f.delegate('one')).agent; const second=(await f.delegate('two')).agent;
  await Promise.all([f.ready(first.id),f.ready(second.id)]);
  assert.equal(f.service().get(first.id).status,'running'); assert.equal(f.service().get(second.id).status,'running');
  assert.notEqual(first.workspacePath,second.workspacePath);
  const tasks = [first,second].map(async agent=>{
    const manifest=await readGuidance(f.dataDir,agent.guidanceRevision!);
    const entry=manifest.skills.find(s=>s.repositoryId===f.repositoryId&&s.skill.filePath.includes('.cursor/skills/inspect'))!;
    const tools=guidanceTools({cwd:agent.workspacePath,tools:['read','bash']} as WorkerSpec,manifest,()=>{});
    const load=tools.find(tool=>tool.name==='load_skill')!;
    const loaded=await load.execute('load',{id:join(f.repo,'.claude/skills/inspect/SKILL.md')},undefined,undefined,{} as any);
    assert.match(JSON.stringify(loaded),/Run the sibling check/);
    assert.match(JSON.stringify(loaded),/Local guidance assets are copied/);
    assert.ok(manifest.instructions.some(file=>file.scope===join(agent.workspacePath,'src')));
    assert.equal(await readFile(join(agent.workspacePath,'source.txt'),'utf8'),'original source');
    assert.ok(!existsSync(join(agent.workspacePath,'.env')));
    return exec(process.execPath,[join(entry.skill.baseDir,'check.mjs'),agent.outputPath!],{cwd:agent.workspacePath,timeout:10000});
  });
  // Each script waits until both have written the same relative output file in their own folder.
  await f.until(()=>[first,second].every(agent=>existsSync(join(agent.workspacePath,'script-output.txt'))),'both scripts start before release');
  for (const agent of [first,second]) await writeFile(join(agent.outputPath!,'release'),'go');
  await Promise.all(tasks);
  for (const agent of [first,second]) assert.equal(await readFile(join(agent.workspacePath,'script-output.txt'),'utf8'),agent.workspacePath);
  assert.equal(await readFile(join(f.repo,'source.txt'),'utf8'),'local edits must survive');
  assert.ok(!existsSync(join(f.repo,'script-output.txt')));
  const shared=(await f.service().createDelegate(f.parent.id,{objective:'[wait] Shared implementation.',commandId:'shared'})).agent;
  assert.equal(f.service().get(shared.id).status,'queued');
  assert.equal(f.service().agents(f.parent.id).find(a=>a.id===shared.id)?.queueReason,'Waiting for workspace');
});

test('saved delegates reuse workspaces and fresh independent assignments get clean files and context',async t=>{
  const f=await fixture(t); const first=(await f.delegate()).agent; await f.finish(first.id);
  await writeFile(join(first.workspacePath,'local-output.txt'),'previous role evidence');
  await f.service().continueDelegate(f.parent.id,first.id,{message:'[wait] Follow up.',commandId:'followup'});
  assert.equal(f.service().get(first.id).workspacePath,first.workspacePath); await f.finish(first.id);
  const input={message:'[wait] Independent role.',freshContext:true,commandId:'fresh'};
  const [a,b]=await Promise.all([f.service().continueDelegate(f.parent.id,first.id,input),f.service().continueDelegate(f.parent.id,first.id,input)]);
  assert.equal(a.agent.workspacePath,b.agent.workspacePath);
  assert.notEqual(a.agent.workspacePath,first.workspacePath); assert.notEqual(a.agent.sessionPath,first.sessionPath);
  assert.equal(a.agent.workspaces[0].commit,f.commit);
  assert.ok(existsSync(join(first.workspacePath,'local-output.txt'))); assert.ok(!existsSync(join(a.agent.workspacePath,'local-output.txt')));
  await f.ready(first.id);
  await f.restart();
  const restored=f.service().get(first.id); assert.equal(restored.workspacePath,a.agent.workspacePath); assert.equal(restored.status,'interrupted');
  await f.service().continue(first.id,{commandId:'resume'},true);
  await f.until(()=>f.service().get(first.id).status==='completed','resumed delegate completes');
  assert.equal(f.service().get(first.id).workspacePath,restored.workspacePath);
});

test('lead preparation is idempotent and does not change its working directory or Git branch',async t=>{
  const f=await fixture(t); const branch=await f.git('symbolic-ref','HEAD');
  const input={repositoryId:f.repositoryId,commit:f.commit,commandId:'lead-copy'};
  const [a,b]=await Promise.all([f.service().createWorkspace(f.parent.id,input),f.service().createWorkspace(f.parent.id,input)]);
  assert.equal(a.workspace.id,b.workspace.id); assert.equal(f.service().get(f.parent.id).preparedWorkspaces?.length,1);
  assert.equal(f.service().get(f.parent.id).workspacePath,f.repo); assert.equal(await f.git('symbolic-ref','HEAD'),branch);
  assert.equal((await exec('git',['rev-parse','HEAD'],{cwd:a.workspace.workspacePath})).stdout.trim(),f.commit);
  await assert.rejects(f.service().createWorkspace(f.parent.id,{...input,commit:'HEAD',commandId:'bad-ref'}),/exact full/);
  await assert.rejects(f.service().createWorkspace(f.parent.id,{...input,repositoryId:'foreign',commandId:'foreign'}),/repository IDs/);
  await assert.rejects(f.service().createWorkspace(f.parent.id,{...input,commit:'HEAD'}),/different request/);
  await assert.rejects(f.service().createWorkspace(f.parent.id,input,'stale-run'),/no longer active/);
});

test('new commits require explicit fresh assignments and cached continuations preserve ownership checks',async t=>{
  const f=await fixture(t); const first=(await f.delegate()).agent; await f.finish(first.id);
  await f.put(join(f.repo,'source.txt'),'second committed revision'); await f.git('add','source.txt'); await f.git('commit','-m','Second');
  const commit=await f.git('rev-parse','HEAD');
  const isolation=[{repositoryId:f.repositoryId,commit}];
  await assert.rejects(f.service().continueDelegate(f.parent.id,first.id,{message:'[wait] New revision',isolation,commandId:'no-fresh'}),/freshContext/);
  const input={message:'[wait] New revision',freshContext:true,isolation,commandId:'new-revision'};
  const {agent}=await f.service().continueDelegate(f.parent.id,first.id,input);
  assert.equal(agent.workspaces[0].commit,commit);assert.equal(await readFile(join(agent.workspacePath,'source.txt'),'utf8'),'second committed revision');
  assert.equal(await readFile(join(first.workspacePath,'source.txt'),'utf8'),'original source');
  const other=(await f.service().create({objective:'[wait] Other quest',workspaceMode:'none',commandId:'other'})).quest;
  await assert.rejects(f.service().continueDelegate(other.id,first.id,input),/belongs to another/);
});

test('concurrent preparation reserves delegate slots and legacy checkouts can opt into isolation',async t=>{
  const f=await fixture(t);
  const results=await Promise.allSettled(Array.from({length:6},(_,i)=>f.delegate(`concurrent-${i}`)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(f.service().agents(f.parent.id).length,5);
  await f.service().action(f.parent.id,'cancel',{commandId:'cancel-five'});
  const legacy=(await f.service().create({objective:'[wait] Legacy directory.',workspacePath:f.repo,tools:['read','bash'],commandId:'legacy'})).quest;
  await f.ready(legacy.id);
  const {agent}=await f.service().createDelegate(legacy.id,{objective:'[wait] Isolate legacy source.',isolation:[{repositoryId:'workspace',commit:f.commit}],commandId:'legacy-child'});
  await f.ready(agent.id);assert.notEqual(agent.workspacePath,f.repo);assert.equal(agent.workspaces?.[0].commit,f.commit);
});

test('five background slots are available while Guildmaster retains a reserved slot',async t=>{
  const f=await fixture(t);
  await f.finish(f.parent.id);
  await f.service().continue(f.parent.id,{message:'[wait] Coordinate parallel work.',commandId:'continue-lead'}); await f.ready(f.parent.id);
  const children=[];for(let i=0;i<5;i++)children.push((await f.delegate(`slot-${i}`)).agent);
  await f.service().waitForAgents(f.parent.id,{commandId:'wait'});f.service().live.get(f.parent.id)!.child.send({type:'fixture-yield'});
  await f.until(()=>!f.service().live.has(f.parent.id),'lead yielded');
  await Promise.all(children.map(child=>f.ready(child.id)));
  assert.equal(f.service().live.size,5);
  const gm=(await f.service().guildmaster({message:'[wait] Stay responsive.',workspaceMode:'none',commandId:'gm'})).quest;
  await f.ready(gm.id); assert.equal(f.service().live.size,6);
  await assert.rejects(f.delegate('sixth'),/five delegates/);
});

test('failed or cancelled workspace preparation never starts a delegate or silently uses the shared checkout',async t=>{
  const f=await fixture(t);
  const unknown='a'.repeat(40);
  await assert.rejects(f.delegate('missing',{isolation:[{repositoryId:f.repositoryId,commit:unknown}]}));
  assert.equal(f.service().agents(f.parent.id).length,0);
  await symlink(join(f.repo,'source.txt'),join(f.repo,'.cursor/skills/inspect/outside-link'));
  await assert.rejects(f.delegate('linked'),/symbolic link/);
  assert.equal(f.service().agents(f.parent.id).length,0);
  await rm(join(f.repo,'.cursor/skills/inspect/outside-link'));
  const inFlight=f.delegate('cancel-during-setup');
  const rejection=assert.rejects(inFlight,/no longer active/);
  await f.until(()=>existsSync(join(f.dataDir,'isolated')),'preparation begins');
  await f.service().action(f.parent.id,'cancel',{commandId:'cancel'});
  await rejection;
  assert.equal(f.service().agents(f.parent.id).length,0);
  assert.equal((await f.git('worktree','list','--porcelain')).split('worktree ').length-1,1);
});

test('preparation checkpoints identify interrupted setup without deleting saved workspaces',async t=>{
  const f=await fixture(t); const agent=(await f.delegate()).agent;
  const revision=agent.guidanceRevision!;
  const record=JSON.parse(await readFile(join(f.dataDir,'isolated',revision,'preparation.json'),'utf8'));
  assert.equal(record.state,'ready'); assert.equal(record.workspaces[0].commit,f.commit);
  await f.restart(); assert.ok(existsSync(agent.workspacePath));
});

test('native lead and delegate run copied skills and resolve delegate questions without user input', {timeout:30000},async t=>{
  const f=await fixture(t);
  await f.service().close();
  const dataDir=join(f.root,'native-data'), trace=join(f.root,'requests.jsonl');
  await f.put(join(dataDir,'engine/models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:'http://fixture.invalid/v1',api:'openai-completions',apiKey:'test-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:2048}]}}}));
  const worker=join(f.root,'native-worker.mjs');
  await f.put(worker,`process.env.GUILDMASTER_TEST_REQUESTS=${JSON.stringify(trace)};\nprocess.env.GUILDMASTER_TEST_COMMIT=${JSON.stringify(f.commit)};\nawait import(${JSON.stringify(pathToFileURL(resolve('tests/fixtures/isolation-fetch.mjs')).href)});\nawait import(${JSON.stringify(pathToFileURL(resolve('src/worker.ts')).href)});\n`);
  const app=createApp({dataDir,port:0,defaultWorkspace:f.repo,workerPath:worker});
  // Close the second service before the fixture removes its directories.
  try {
    await app.listen();app.service.modelDefaults.initialize('local-fixture/fixture');
    const project=(await app.service.saveProject({name:'Example',repositories:[{name:'App',path:f.repo}],commandId:'project'})).project;
    const {quest}=await app.service.create({objective:'Inspect the exact commit using separate workspaces.',workspacePolicy:'isolated',projectId:project.id,model:'local-fixture/fixture',tools:['read','bash'],commandId:'quest'});
    for(let n=0;n<800;n++){
      const failed=app.store.list().find(q=>['failed','interrupted'].includes(q.status));assert.ok(!failed,JSON.stringify(failed));
      if(app.service.get(quest.id).status==='awaiting_review'&&!app.service.live.size)break;
      await new Promise(r=>setTimeout(r,20));
    }
    const lead=app.service.get(quest.id), child=app.service.agents(quest.id)[0];
    assert.equal(lead.status,'awaiting_review',JSON.stringify(app.store.list()));
    assert.equal(child.status,'completed');
    const questions=app.store.requests(child.id);
    assert.equal(questions.length,1);
    assert.equal(questions[0].answer,'Use the assigned workspace.');
    assert.equal(questions[0].status,'answered');
    assert.equal(app.store.requests(lead.id).length,0);
    assert.equal(child.runCount,2);
    const own=lead.workspaces![0];
    assert.notEqual(own.workspacePath,child.workspacePath);
    for(const path of [own.workspacePath,child.workspacePath])assert.equal(await readFile(join(path,'script-output.txt'),'utf8'),path);
    assert.ok(!existsSync(join(f.repo,'script-output.txt')));
    const requests=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(requests.some(request=>JSON.stringify(request.messages).includes('Workspace policy: isolated.')),'Inherited workspace policy survives the lead yield and resume');
  } finally {await app.close();}
});

test('four isolated quests run twelve inherited delegates while preserving shared implementation locks', {timeout:30000}, async t=>{
  const f=await fixture(t);
  await f.service().action(f.parent.id,'cancel',{commandId:'cancel-bootstrap'});
  await f.until(()=>!f.service().live.size,'Bootstrap exits');
  assert.equal(f.service().maxWorkers,13);
  const parents=await Promise.all(Array.from({length:4},(_,i)=>f.service().create({
    title:'Concurrent quest '+i,objective:'[wait] Coordinate independent source inspection.',projectId:f.parent.project!.id,
    workspacePolicy:'isolated',tools:['read','bash'],commandId:'isolated-parent-'+i,
  }).then(r=>r.quest)));
  await Promise.all(parents.map(q=>f.ready(q.id)));
  assert.equal(new Set(parents.map(q=>q.workspacePath)).size,4);
  const children=[];
  for(const parent of parents) {
    for(let i=0;i<3;i++) children.push((await f.service().createDelegate(parent.id,{
      title:'Inspection '+i,objective:'[wait] Inspect and test the selected revision.',commandId:parent.id+'-'+i,
    })).agent);
    await f.service().waitForAgents(parent.id,{commandId:parent.id+'-wait'});
    f.service().live.get(parent.id)!.child.send({type:'fixture-yield'});
    await f.until(()=>!f.service().live.has(parent.id),'Lead releases capacity');
  }
  await Promise.all(children.map(q=>f.ready(q.id)));
  assert.equal(f.service().live.size,12);
  assert.equal(new Set([...parents,...children].map(q=>q.workspacePath)).size,16);
  for(const child of children) {
    assert.equal(child.workspacePolicy,'isolated');
    assert.equal(child.isolation?.[0].commit,f.commit);
    assert.equal(child.workspaces?.[0].commit,f.commit);
    assert.equal(await readFile(join(child.workspacePath,'source.txt'),'utf8'),'original source');
    assert.ok(!existsSync(join(child.workspacePath,'.env')));
  }
  const gm=(await f.service().guildmaster({message:'[wait] Stay responsive.',workspaceMode:'none',commandId:'pool-gm'})).quest;
  await f.ready(gm.id); assert.equal(f.service().live.size,13);
  const extra=(await f.service().create({objective:'[wait] Extra independent work.',workspacePolicy:'isolated',projectId:f.parent.project!.id,tools:['bash'],commandId:'extra-quest'})).quest;
  assert.equal(extra.status,'queued');
  assert.equal(f.service().detail(extra.id).quest.queueReason,'Waiting for an available worker');
  await f.finish(children[0].id);
  await f.ready(extra.id);
  assert.ok(children.slice(1).every(q=>f.service().live.has(q.id)),'A new quest starts without waiting for another entire quest');
  for(const parent of [...parents,extra]) await f.service().action(parent.id,'cancel',{commandId:'cancel-'+parent.id});
  await f.until(()=>f.service().live.size===1,'Background workers exit');
  const sharedA=(await f.service().create({objective:'[wait] Implement current changes.',workspacePolicy:'shared',projectId:f.parent.project!.id,tools:['bash'],commandId:'shared-a'})).quest;
  const sharedB=(await f.service().create({objective:'[wait] Follow-up on current files.',workspacePolicy:'shared',projectId:f.parent.project!.id,tools:['bash'],commandId:'shared-b'})).quest;
  await f.ready(sharedA.id);
  assert.equal(f.service().get(sharedB.id).status,'queued');
  assert.equal(f.service().detail(sharedB.id).quest.queueReason,'Waiting for workspace');
  assert.equal(await readFile(join(f.repo,'source.txt'),'utf8'),'local edits must survive');
});

test('revision selection is inherited, preserves running agents, and survives restart',async t=>{
  const f=await fixture(t);
  const input={objective:'[wait] Independent work.',workspacePolicy:'isolated' as const,projectId:f.parent.project!.id,tools:['read','bash'],commandId:'policy-lead'};
  const [a,b]=await Promise.all([f.service().create(input),f.service().create(input)]);
  assert.equal(a.quest.id,b.quest.id);
  const parent=a.quest; await f.ready(parent.id);
  const pinned=await f.service().createWorkspace(parent.id,{repositoryId:f.repositoryId,commit:f.commit,commandId:'same-revision'});
  assert.equal(pinned.workspace.workspacePath,parent.workspacePath,'Selecting the current revision reuses the assigned checkout');
  assert.equal(f.service().get(parent.id).preparedWorkspaces,undefined);
  const first=(await f.service().createDelegate(parent.id,{objective:'[wait] First pass.',commandId:'first-pass'})).agent;
  await f.ready(first.id);
  await f.put(join(f.repo,'revision.txt'),'second commit');await f.git('add','revision.txt');await f.git('commit','-m','Second revision');
  const next=await f.git('rev-parse','HEAD');
  const selected=await f.service().createWorkspace(parent.id,{repositoryId:f.repositoryId,commit:next,commandId:'select-next'});
  assert.notEqual(selected.workspace.workspacePath,parent.workspacePath);
  assert.equal(f.service().get(first.id).isolation?.[0].commit,f.commit);
  assert.equal(await readFile(join(first.workspacePath,'source.txt'),'utf8'),'original source');
  const second=(await f.service().createDelegate(parent.id,{objective:'[wait] Next pass.',commandId:'next-pass'})).agent;
  await f.ready(second.id);assert.equal(second.isolation?.[0].commit,next);
  assert.equal(await readFile(join(second.workspacePath,'revision.txt'),'utf8'),'second commit');
  await assert.rejects(f.service().createDelegate(parent.id,{objective:'Incorrect revision.',isolation:[{repositoryId:f.repositoryId,commit:f.commit}],commandId:'wrong-revision'}),/inherit that revision/);
  await f.finish(first.id);
  await assert.rejects(f.service().continueDelegate(parent.id,first.id,{message:'Continue',commandId:'old-context'}),/revision has changed/);
  await f.service().continueDelegate(parent.id,first.id,{message:'[wait] Fresh revision.',freshContext:true,commandId:'fresh-revision'});
  await f.ready(first.id);assert.equal(f.service().get(first.id).isolation?.[0].commit,next);
  const savedPath=f.service().get(first.id).workspacePath;
  await f.restart();
  assert.equal(f.service().get(parent.id).workspacePolicy,'isolated');
  assert.equal(f.service().get(parent.id).isolation?.[0].commit,next);
  assert.equal(f.service().get(first.id).workspacePath,savedPath);
  assert.equal(f.service().get(f.parent.id).workspacePolicy,undefined,'Legacy quests are not migrated');
});

test('isolated quest preparation rejects unavailable revisions without falling back to shared files',async t=>{
  const f=await fixture(t);
  const before=f.store().list().length;
  const trees=await f.git('worktree','list','--porcelain');
  await assert.rejects(f.service().create({
    objective:'Inspect missing revision.',workspacePolicy:'isolated',projectId:f.parent.project!.id,
    revisions:[{repositoryId:f.repositoryId,commit:'f'.repeat(40)}],commandId:'missing-revision',
  }));
  assert.equal(f.store().list().length,before);
  assert.equal(await f.git('worktree','list','--porcelain'),trees);
  const created=await f.service().create({
    objective:'[wait] Pin known source.',workspacePolicy:'isolated',projectId:f.parent.project!.id,
    revisions:[{repositoryId:f.repositoryId,commit:f.commit}],commandId:'known-revision',
  });
  assert.equal(created.quest.isolation?.[0].commit,f.commit);
});

test('cancelling the originating request rolls back isolated quest preparation',async t=>{
  const f=await fixture(t);
  const gm=(await f.service().guildmaster({message:'[wait] Start independent work.',workspaceMode:'none',commandId:'origin-gm'})).quest;
  await f.ready(gm.id);
  const source=f.service().delegationSource(f.service().get(gm.id));
  const inFlight=f.service().create({objective:'Independent work.',workspacePolicy:'isolated',projectId:f.parent.project!.id,commandId:'cancel-creation'},'quest',undefined,source);
  const rejected=assert.rejects(inFlight,/originating request stopped/);
  await f.until(()=>existsSync(join(f.dataDir,'isolated')),'Workspace preparation begins');
  await f.service().action(gm.id,'cancel',{commandId:'stop-origin'});
  await rejected;
  assert.equal(f.store().list().filter(q=>q.kind==='quest').length,1);
  assert.equal((await f.git('worktree','list','--porcelain')).split('worktree ').length-1,1);
});
