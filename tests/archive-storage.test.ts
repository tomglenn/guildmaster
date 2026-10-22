import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/service/store.ts';
import {QuestService} from '../src/service/quests.ts';
import {ArchiveStorage} from '../src/service/archive-storage.ts';
import {createApp} from '../src/service/server.ts';
import type {Quest} from '../src/domain/types.ts';
const exec=promisify(execFile);const DAY=86_400_000;
async function exists(path:string){return access(path).then(()=>true,()=>false);}
async function fixture(t:TestContext) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'guildmaster-delete-')));const data=join(root,'data');
  const store=new Store(data);const service=new QuestService({store,dataDir:data});const storage=new ArchiveStorage(service);
  t.after(async()=>{await storage.close();await service.close();store.close();await rm(root,{recursive:true,force:true});});
  const quest=(id:string,extra:Partial<Quest>={}):Quest=>{const q:Quest={id,title:id,objective:'Example assignment',kind:'quest',status:'accepted',workspaceMode:'none',workspacePath:join(data,'workspaces',id),sessionPath:join(data,'sessions',id,'session.jsonl'),model:'fixture/model',tools:[],instructions:'',runCount:1,createdAt:1,updatedAt:1,closedAt:Date.now(),...extra};store.save(q);return q;};
  async function file(path:string,text='saved content'){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text);}
  async function repo(){const path=join(root,'source');await mkdir(path);await exec('git',['init','-q'],{cwd:path});await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','--allow-empty','-qm','Initial'],{cwd:path});return path;}
  return {root,data,store,service,storage,quest,file,repo};
}

test('deletion removes the closed family, private files, and cached payloads; retries cannot resurrect it',async t=>{
  const f=await fixture(t);const q=f.quest('parent');const child=f.quest('child',{kind:'delegate',parentQuestId:q.id,status:'completed',archivedAt:undefined});const keep=f.quest('keep');
  for(const item of [q,child]) {
    f.store.message(item.id,'assistant','private report');f.store.event(item.id,'result','private event');
    f.store.run('run-'+item.id,item.id,{prompt:'private instructions'});
    f.store.saveToolCall({id:'tool-'+item.id,questId:item.id,runId:'run-'+item.id,tool:'read',detail:'private detail',status:'completed',startedAt:1});
    f.store.request({id:'request-'+item.id,questId:item.id,runId:'run-'+item.id,question:'private question',status:'answered',createdAt:1});
    f.store.saveDelivery({id:'delivery-'+item.id,questId:item.id,commandId:'command',kind:'prompt',text:'private delivery',createdAt:1,deliveredAt:2});
    await f.file(item.sessionPath);await f.file(join(item.workspacePath,'report.md'));await f.file(join(f.data,'runs','run-'+item.id+'.json'),'{}');
  }
  f.store.saveCommand('create-parent','hash',{quest:q});f.store.saveCommand('keep-command','other',{quest:keep});
  assert.deepEqual(await f.storage.delete([q.id]),{deleted:[q.id],failed:[]});
  for(const item of [q,child]) {
    assert.equal(f.store.get(item.id),undefined);assert.equal(await exists(item.sessionPath),false);assert.equal(await exists(item.workspacePath),false);
    for(const table of ['messages','events','requests','runs','deliveries','tool_calls'])assert.equal((f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE questId=?`).get(item.id) as {n:number}).n,0);
  }
  assert.throws(()=>f.store.command('create-parent'),/permanently deleted/);assert.ok(f.store.command('keep-command'));assert.ok(f.store.get(keep.id));
  assert.deepEqual(await f.storage.delete([q.id]),{deleted:[q.id],failed:[]});
});

test('only closed settled quests may be deleted and bulk failures retain their records',async t=>{
  const f=await fixture(t);f.quest('current',{closedAt:undefined,archivedAt:1});f.quest('running',{status:'running',activeRunId:'r'});f.quest('chat',{kind:'guildmaster'});f.quest('eligible');
  const result=await f.storage.delete(['current','running','chat','eligible']);
  assert.deepEqual(result.deleted,['eligible']);assert.equal(result.failed.length,3);for(const id of ['current','running','chat'])assert.ok(f.store.get(id));
  await assert.rejects(()=>f.storage.delete(['../source']),/Select between/);
  await assert.rejects(()=>f.storage.delete([]),/Select between/);
});

test('source repositories and shared checkouts survive deletion',async t=>{
  const f=await fixture(t);const repo=await f.repo();await f.file(join(repo,'keep.txt'),'keep me');
  f.quest('shared',{workspaceMode:'existing',workspacePath:repo,sourcePath:repo});
  assert.deepEqual((await f.storage.delete(['shared'])).failed,[]);
  assert.equal(await readFile(join(repo,'keep.txt'),'utf8'),'keep me');assert.equal(await exists(join(repo,'.git')),true);
});

test('owned Git worktrees are deregistered while source branches and commits remain',async t=>{
  const f=await fixture(t);const source=await f.repo();const path=join(f.data,'worktrees','owned');
  await exec('git',['worktree','add','-b','guildmaster/example',path],{cwd:source});
  await f.file(join(path,'uncommitted.txt'));
  f.quest('owned',{workspaceMode:'worktree',workspacePath:path,sourcePath:source,branch:'guildmaster/example'});
  assert.deepEqual((await f.storage.delete(['owned'])).failed,[]);assert.equal(await exists(path),false);
  const list=await exec('git',['worktree','list','--porcelain'],{cwd:source});assert.ok(!list.stdout.includes(path));
  assert.equal((await exec('git',['branch','--list','guildmaster/example'],{cwd:source})).stdout.trim(),'guildmaster/example');
});

test('current and historical isolated generations are cleaned; referenced generations and guidance are kept',async t=>{
  const f=await fixture(t);const source=await f.repo();const current=randomUUID(),old=randomUUID(),shared=randomUUID();
  for(const generation of [current,old,shared]) {
    const folder=join(f.data,'isolated',generation),path=join(folder,'0','repo');
    await mkdir(join(folder,'0'),{recursive:true});await exec('git',['worktree','add','--detach',path],{cwd:source});
    await f.file(join(folder,'preparation.json'),JSON.stringify({generation,state:'ready',workspaces:[{workspacePath:path,sourcePath:source,mode:'worktree'}]}));
    await f.file(join(f.data,'guidance',generation+'.json'),'{}');
  }
  const q=f.quest('isolated',{workspaceMode:'worktree',workspacePath:join(f.data,'isolated',current,'0','repo'),sourcePath:source,guidanceRevision:current});
  f.store.run('historical',q.id,{});await f.file(join(f.data,'runs','historical.json'),JSON.stringify({guidancePath:join(f.data,'guidance',old+'.json'),workspaces:[{workspacePath:join(f.data,'isolated',old,'0','repo'),sourcePath:source,mode:'worktree'}]}));
  q.preparedWorkspaces=[{id:shared,repositoryId:'r',name:'Shared',mode:'worktree',workspacePath:join(f.data,'isolated',shared,'0','repo'),sourcePath:source,guidanceRevision:shared,outputPath:join(f.data,'isolated',shared,'output')}];f.store.save(q);
  f.quest('other',{workspaceMode:'existing',workspacePath:join(f.data,'isolated',shared,'0','repo'),sourcePath:source,guidanceRevision:shared});
  assert.deepEqual((await f.storage.delete([q.id])).failed,[]);
  for(const generation of [current,old]){assert.equal(await exists(join(f.data,'isolated',generation)),false);assert.equal(await exists(join(f.data,'guidance',generation+'.json')),false);}
  assert.equal(await exists(join(f.data,'isolated',shared)),true);assert.equal(await exists(join(f.data,'guidance',shared+'.json')),true);
});

test('symlinked storage paths cannot remove outside files and can be retried after repair',async t=>{
  const f=await fixture(t);const outside=join(f.root,'outside');await mkdir(outside);await f.file(join(outside,'keep.txt'));
  await symlink(outside,join(f.data,'sessions'));f.quest('linked');
  const result=await f.storage.delete(['linked']);assert.equal(result.failed.length,1);assert.match(result.failed[0].error,/symbolic link/);assert.ok(f.store.get('linked'));assert.equal(await exists(join(outside,'keep.txt')),true);
  await rm(join(f.data,'sessions'));assert.deepEqual((await f.storage.delete(['linked'])).failed,[]);
});

test('another quest using a deterministic owned folder blocks deletion',async t=>{
  const f=await fixture(t);const q=f.quest('owner');await f.file(join(q.workspacePath,'keep.txt'));
  f.quest('dependent',{archivedAt:undefined,workspaceMode:'existing',workspacePath:q.workspacePath});
  assert.equal((await f.storage.delete([q.id])).failed.length,1);assert.equal(await exists(join(q.workspacePath,'keep.txt')),true);assert.ok(f.store.get(q.id));
});

test('retention defaults off, counts closure age, persists, and excludes open quests and chat history',async t=>{
  const f=await fixture(t);const now=Date.now();
  f.quest('old',{closedAt:now-40*DAY,updatedAt:now});f.quest('fresh',{closedAt:now-2*DAY,archivedAt:now-100*DAY,createdAt:now-100*DAY});f.quest('reopened',{closedAt:undefined,createdAt:1});f.quest('chat-history',{kind:'guildmaster',closedAt:now-100*DAY});
  assert.equal(f.storage.view().closedQuests,2);
  assert.equal(f.storage.view().retentionDays,null);await f.storage.cleanExpired(now);assert.ok(f.store.get('old'));
  await f.storage.savePolicy(30);await f.storage.cleanExpired();assert.equal(f.store.get('old'),undefined);for(const id of ['fresh','reopened','chat-history'])assert.ok(f.store.get(id));
  const second=new ArchiveStorage(f.service);assert.equal(second.view().retentionDays,30);await second.close();
  await f.storage.savePolicy(null);assert.equal(f.storage.view().retentionDays,null);
  for(const value of [0,-1,1.5,'30',3651,undefined])await assert.rejects(()=>f.storage.savePolicy(value),/whole number/);
});

test('cleanup rechecks a reopen that wins the service queue',async t=>{
  const f=await fixture(t);const closedAt=Date.now()-100*DAY;f.quest('race',{closedAt});f.store.saveSetting('storage',{retentionDays:30});
  const reopening=f.service.action('race','reopen',{commandId:'reopen-race',expectedRunCount:1,expectedClosedAt:closedAt});
  const cleanup=f.storage.cleanExpired();await reopening;assert.deepEqual(await cleanup,{deleted:[],failed:[]});assert.ok(f.store.get('race'));assert.equal(f.store.get('race')?.closedAt,undefined);
});

test('storage deletion endpoints require user authority and report partial failures',async t=>{
  const data=await mkdtemp(join(tmpdir(),'guildmaster-storage-http-'));const app=createApp({dataDir:data,port:0,models:[]});
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});const {url,token}=await app.listen();
  const q:Quest={id:'closed',title:'Closed example',objective:'Example',kind:'quest',status:'accepted',closedAt:Date.now(),workspaceMode:'none',workspacePath:join(data,'workspaces','closed'),sessionPath:join(data,'sessions','closed','session.jsonl'),model:'fixture/model',tools:[],instructions:'',runCount:0,createdAt:1,updatedAt:1};app.store.save(q);
  const post=(path:string,value:unknown,auth=token)=>fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post('/api/quests/delete',{ids:[q.id]},'bad')).status,401);
  app.store.save({...q,id:'gm',kind:'guildmaster',closedAt:undefined,workspacePath:join(data,'workspaces','gm'),sessionPath:join(data,'sessions','gm','session.jsonl')});app.service.gmTokens.set('agent-token','gm');assert.equal((await post('/api/quests/delete',{ids:[q.id]},'agent-token')).status,403);
  assert.equal((await post('/api/settings/storage',{retentionDays:30},'agent-token')).status,403);
  const response=await post('/api/quests/delete',{ids:[q.id]});assert.equal(response.status,200);assert.deepEqual(await response.json(),{deleted:[q.id],failed:[]});
  assert.equal((await fetch(url+'/api/quests/'+q.id,{headers:{Authorization:'Bearer '+token}})).status,404);
});

test('startup cleanup uses the saved policy without enabling deletion for a new installation',async t=>{
  const data=await mkdtemp(join(tmpdir(),'guildmaster-retention-startup-'));let app=createApp({dataDir:data,port:0,models:[]});
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});
  const q:Quest={id:'startup-old',title:'Old closed report',objective:'Example',kind:'quest',status:'accepted',closedAt:Date.now()-100*DAY,workspaceMode:'none',workspacePath:join(data,'workspaces','startup-old'),sessionPath:join(data,'sessions','startup-old','session.jsonl'),model:'fixture/model',tools:[],instructions:'',runCount:0,createdAt:1,updatedAt:1};
  app.store.save(q);await app.listen();await app.archiveStorage.cleanExpired();assert.ok(app.store.get(q.id));
  app.store.saveSetting('storage',{retentionDays:30});await app.close();
  app=createApp({dataDir:data,port:0,models:[]});await app.listen();await app.archiveStorage.cleanExpired();
  assert.equal(app.store.get(q.id),undefined);assert.equal(app.archiveStorage.view().retentionDays,30);
});

test('missing ownership records leave closed quests and workspace files intact',async t=>{
  const f=await fixture(t);const q=f.quest('untracked');const file=join(f.data,'worktrees',q.id,'keep.txt');await f.file(file);
  assert.equal((await f.storage.delete([q.id])).failed.length,1);assert.equal(await exists(file),true);assert.ok(f.store.get(q.id));
});

test('a stopping delegate and a registered project prevent deletion of their files',async t=>{
  const f=await fixture(t);const q=f.quest('guarded');f.quest('child',{kind:'delegate',parentQuestId:q.id,status:'running',activeRunId:'child-run',archivedAt:undefined});
  assert.equal((await f.storage.delete([q.id])).failed.length,1);assert.ok(f.store.get(q.id));
  const q2=f.quest('project-root');await f.file(join(q2.workspacePath,'keep.txt'));
  f.store.saveProject({id:'p',name:'Example',aliases:[],instructions:'',repositories:[{id:'r',name:'Example',path:q2.workspacePath}],createdAt:1,updatedAt:1});
  assert.equal((await f.storage.delete([q2.id])).failed.length,1);assert.equal(await exists(join(q2.workspacePath,'keep.txt')),true);
});

test('mixed isolation cleans its private checkout and preserves external shared worktrees',async t=>{
  const f=await fixture(t);const source=await f.repo();const shared=join(f.root,'shared-checkout');await exec('git',['worktree','add','-b','shared-example',shared],{cwd:source});await f.file(join(shared,'keep.txt'),'user-owned');
  const generation=randomUUID(),folder=join(f.data,'isolated',generation),privatePath=join(folder,'0','repo');await mkdir(join(folder,'0'),{recursive:true});await exec('git',['worktree','add','--detach',privatePath],{cwd:source});
  const workspaces=[{repositoryId:'private',name:'Private',workspacePath:privatePath,sourcePath:source,mode:'worktree' as const},{repositoryId:'shared',name:'Shared',workspacePath:shared,sourcePath:source,mode:'worktree' as const}];
  await f.file(join(folder,'preparation.json'),JSON.stringify({generation,state:'ready',workspaces}));
  f.quest('mixed',{workspaceMode:'worktree',workspacePath:privatePath,sourcePath:source,workspaces,guidanceRevision:generation});
  assert.deepEqual((await f.storage.delete(['mixed'])).failed,[]);assert.equal(await exists(privatePath),false);assert.equal(await readFile(join(shared,'keep.txt'),'utf8'),'user-owned');
  assert.ok((await exec('git',['worktree','list','--porcelain'],{cwd:source})).stdout.includes(shared));
});

test('turning retention off before a queued deletion preserves the closed quest',async t=>{
  const f=await fixture(t);f.quest('policy-race',{closedAt:Date.now()-100*DAY});f.store.saveSetting('storage',{retentionDays:30});
  const disabling=f.storage.savePolicy(null);const cleanup=f.storage.cleanExpired();await disabling;await cleanup;
  assert.ok(f.store.get('policy-race'));assert.equal(f.storage.view().retentionDays,null);
});

test('storage compatibility links preserve shared-path protection and Git worktree cleanup after a move',async t=>{
 const f=await fixture(t);const alias=join(f.root,'legacy-data');await symlink(f.data,alias);
 f.store.saveSetting('storage.pathAliases',[alias]);
 const owner=f.quest('alias-owner',{workspacePath:join(alias,'workspaces','alias-owner'),sessionPath:join(alias,'sessions','alias-owner','session.jsonl')});
 await f.file(join(owner.workspacePath,'keep.txt'));
 const shared=f.quest('alias-shared',{workspaceMode:'existing',workspacePath:owner.workspacePath,sourcePath:owner.workspacePath});
 assert.equal((await f.storage.delete([owner.id])).failed.length,1);
 assert.ok(await exists(join(owner.workspacePath,'keep.txt')));
 f.store.save({...shared,workspacePath:join(f.root,'outside'),sourcePath:join(f.root,'outside')});
 assert.deepEqual((await f.storage.delete([owner.id])).failed,[]);
 const source=await f.repo();const workspace=join(alias,'worktrees','alias-worktree');
 await exec('git',['worktree','add','--detach',workspace],{cwd:source});
 await f.file(join(workspace,'saved.txt'));
 f.quest('alias-worktree',{workspaceMode:'worktree',workspacePath:workspace,sourcePath:source});
 assert.deepEqual((await f.storage.delete(['alias-worktree'])).failed,[]);
 assert.equal(await exists(workspace),false);
 await rm(alias);f.quest('alias-missing');
 const failed=await f.storage.delete(['alias-missing']);assert.match(failed.failed[0].error,/compatibility link/);assert.ok(f.store.get('alias-missing'));
});


test('explicit deletion permits safely closed failed and interrupted families',async t=>{
  const f=await fixture(t);
  for(const status of ['failed','interrupted'] as const) {
    const q=f.quest(status,{status,archivedAt:undefined,closedAt:1,closeReason:'closed'});
    f.quest(status+'-child',{kind:'delegate',parentQuestId:q.id,status:'interrupted',archivedAt:undefined});
    await f.file(join(q.workspacePath,'result.md'));
    assert.deepEqual(await f.storage.delete([q.id]),{deleted:[q.id],failed:[]});
    assert.equal(await exists(q.workspacePath),false);
  }
});

test('an existing enabled policy deletes all old closures, not recently closed quests with ancient archive timestamps',async t=>{
  const f=await fixture(t);const now=Date.now();
  for(const closeReason of ['accepted','closed','legacy'] as const)f.quest(closeReason,{closedAt:now-100*DAY,closeReason});
  f.quest('recent',{archivedAt:now-100*DAY,closedAt:now});
  f.store.saveSetting('storage',{retentionDays:30});
  assert.deepEqual(new Set((await f.storage.cleanExpired(now)).deleted),new Set(['accepted','closed','legacy']));
  assert.ok(f.store.get('recent'));assert.equal(f.storage.view().retentionDays,30);assert.equal(f.storage.view().closedQuests,1);
});

test('reopening excludes retention and closing again starts a fresh timer',async t=>{
  const f=await fixture(t);const now=Date.now(),closedAt=now-100*DAY;
  f.quest('reclose',{status:'failed',closedAt});f.store.saveSetting('storage',{retentionDays:30});
  await f.service.action('reclose','reopen',{commandId:'reopen',expectedRunCount:1,expectedClosedAt:closedAt});
  assert.deepEqual(await f.storage.cleanExpired(now),{deleted:[],failed:[]});
  await f.service.action('reclose','close',{commandId:'close-again'});
  assert.ok(f.store.get('reclose')!.closedAt!>=now);
  assert.deepEqual(await f.storage.cleanExpired(now),{deleted:[],failed:[]});
  assert.deepEqual((await f.storage.cleanExpired(now+31*DAY)).deleted,['reclose']);
});

for(const status of ['failed','interrupted'] as const)test(`retention safely retries an old closed ${status} family`,async t=>{
  const f=await fixture(t);const now=Date.now();
  const q=f.quest('expired',{status,closedAt:now-100*DAY});
  const child=f.quest('child',{kind:'delegate',parentQuestId:q.id,status:'interrupted',closedAt:undefined});
  await f.file(join(q.workspacePath,'keep.txt'));await f.file(child.sessionPath);
  f.store.saveSetting('storage',{retentionDays:30});
  const blocked=async(pattern:RegExp)=>{
    const result=await f.storage.cleanExpired(now);assert.deepEqual(result.deleted,[]);assert.equal(result.failed.length,1);assert.match(result.failed[0].error,pattern);
    assert.ok(f.store.get(q.id));assert.ok(f.store.get(child.id));assert.equal(await exists(join(q.workspacePath,'keep.txt')),true);assert.equal(await exists(child.sessionPath),true);
  };
  f.store.save({...child,activeRunId:'stopping'});await blocked(/active work/);f.store.save(child);
  f.service.live.set(child.id,{} as never);await blocked(/active work/);f.service.live.delete(child.id);
  f.store.request({id:'pending',questId:child.id,runId:'r',question:'Approve?',status:'pending',createdAt:1});
  await blocked(/pending questions/);f.store.request({...f.store.requests(child.id)[0],status:'dismissed'});
  f.store.saveDelivery({id:'instruction',questId:child.id,commandId:'c',kind:'prompt',text:'work',createdAt:1});
  await blocked(/pending questions or instructions/);f.store.saveDelivery({...f.store.deliveries(child.id)[0],cancelledAt:2});
  const preparing=t.mock.method(f.service,'familyPreparing',()=>true);await blocked(/active work/);preparing.mock.restore();
  const unowned=join(f.data,'worktrees',q.id,'unowned.txt');await f.file(unowned);
  await blocked(/ownership record/);await rm(join(f.data,'worktrees',q.id),{recursive:true});
  assert.deepEqual(await f.storage.cleanExpired(now),{deleted:[q.id],failed:[]});
  assert.equal(f.store.get(child.id),undefined);assert.equal(await exists(child.sessionPath),false);assert.equal(await exists(q.workspacePath),false);
});

test('closed families with pending requests, deliveries, workers or preparation cannot be deleted',async t=>{
  const f=await fixture(t);const q=f.quest('closed',{status:'failed',closedAt:1,archivedAt:undefined});
  const child=f.quest('guard-child',{kind:'delegate',parentQuestId:q.id,status:'interrupted',archivedAt:undefined});
  await f.file(join(q.workspacePath,'keep.txt'));
  f.store.request({id:'question',questId:child.id,runId:'r',question:'Approve?',status:'pending',createdAt:1});
  assert.match((await f.storage.delete([q.id])).failed[0].error,/pending questions/);
  f.store.request({...f.store.requests(child.id)[0],status:'dismissed'});
  f.store.saveDelivery({id:'instruction',questId:child.id,commandId:'c',kind:'prompt',text:'work',createdAt:1});
  assert.match((await f.storage.delete([q.id])).failed[0].error,/pending questions or instructions/);
  f.store.saveDelivery({...f.store.deliveries(child.id)[0],cancelledAt:2});
  f.service.live.set(child.id,{} as never);
  assert.match((await f.storage.delete([q.id])).failed[0].error,/active work/);
  f.service.live.delete(child.id);
  t.mock.method(f.service,'familyPreparing',()=>true);
  assert.match((await f.storage.delete([q.id])).failed[0].error,/active work/);
  assert.equal(await exists(join(q.workspacePath,'keep.txt')),true);
});

test('deletion rechecks preparation after asynchronous filesystem planning',async t=>{
  const f=await fixture(t);const q=f.quest('planning',{closedAt:1,archivedAt:undefined});
  await f.file(join(q.workspacePath,'keep.txt'));
  let checks=0;
  t.mock.method(f.service,'familyPreparing',()=>++checks>1);
  assert.match((await f.storage.delete([q.id])).failed[0].error,/active work/);
  assert.equal(await exists(join(q.workspacePath,'keep.txt')),true);
});

test('a family change during asynchronous planning aborts before filesystem deletion',async t=>{
  const f=await fixture(t);const q=f.quest('family-race',{closedAt:1,archivedAt:undefined});
  await f.file(join(q.workspacePath,'keep.txt'));let injected=false;
  t.mock.method(f.service,'familyPreparing',()=>{
    if(!injected){injected=true;queueMicrotask(()=>f.quest('late-child',{kind:'delegate',parentQuestId:q.id,status:'running',activeRunId:'late',archivedAt:undefined}));}
    return false;
  });
  assert.match((await f.storage.delete([q.id])).failed[0].error,/changed during cleanup/);
  assert.equal(await exists(join(q.workspacePath,'keep.txt')),true);assert.ok(f.store.get(q.id));
});

test('reopen winning the queue prevents explicit deletion; deletion winning prevents reopen',async t=>{
  const f=await fixture(t);f.quest('reopen-first',{closedAt:1,closeReason:'closed',archivedAt:undefined,status:'failed'});
  const reopen=f.service.action('reopen-first','reopen',{commandId:'reopen-first',expectedRunCount:1,expectedClosedAt:1});
  const removal=f.storage.delete(['reopen-first']);await reopen;
  assert.equal((await removal).failed.length,1);assert.ok(f.store.get('reopen-first'));
  f.quest('delete-first',{closedAt:1,closeReason:'closed',archivedAt:undefined,status:'failed'});
  const deleting=f.storage.delete(['delete-first']);
  const reopening=f.service.action('delete-first','reopen',{commandId:'too-late',expectedRunCount:1,expectedClosedAt:1});
  await assert.rejects(reopening,/not found|deleted/i);assert.deepEqual((await deleting).deleted,['delete-first']);
});
