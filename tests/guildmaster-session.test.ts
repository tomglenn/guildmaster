import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/service/server.ts';
import type { Quest } from '../src/domain/types.ts';

async function fixture(t: any) {
  const dataDir = await mkdtemp(join(tmpdir(), 'guildmaster-conversation-'));
  const options = { dataDir, port:4173, models:[{id:'fake/test',name:'Fixture'}],workerPath:fileURLToPath(new URL('./fixtures/worker.ts',import.meta.url)) };
  let app = createApp(options);app.service.modelDefaults.initialize('fake/test');
  t.after(async () => { await app.close(); await rm(dataDir,{recursive:true,force:true}); });
  const request = (path: string, body?: unknown, headers: Record<string,string> = {}) => new Promise<{status:number;data:any;headers:Record<string,string>}>(resolve => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
    req.url=path;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173','content-type':'application/json',...headers};
    const res=new EventEmitter() as any;res.statusCode=200;res.headersSent=false;const values:Record<string,string>={};
    res.setHeader=(key:string,value:string)=>{values[key.toLowerCase()]=value;};
    res.writeHead=(status:number,headers:Record<string,string>={})=>{res.statusCode=status;res.headersSent=true;Object.assign(values,headers);};
    res.end=(text:string)=>resolve({status:res.statusCode,data:JSON.parse(text),headers:values});app.server.emit('request',req,res);
  });
  const seed = (id='old-gm'):Quest => ({id,kind:'guildmaster',title:'Guildmaster',objective:'Old private conversation',status:'awaiting_review',workspaceMode:'none',workspacePath:dataDir,model:'fake/test',tools:[],instructions:'',createdAt:1,updatedAt:1,sessionPath:join(dataDir,id+'.jsonl'),runCount:1});
  return {request,seed,app:()=>app,restart:async()=>{await app.close();app=createApp(options);}};
}

test('fresh Guildmaster conversation preserves read-only history and leaves quests/projects unchanged',async t=>{
  const f=await fixture(t),old=f.seed();f.app().store.save(old);f.app().store.message(old.id,'user','Old private conversation');
  const quest={...f.seed('ongoing-work'),kind:'quest' as const};f.app().store.save(quest);
  const project={id:'demo',name:'Demo',aliases:[],instructions:'Keep tests passing.',repositories:[{id:'r',name:'Web',path:old.workspacePath}],createdAt:1,updatedAt:1};f.app().store.saveProject(project);
  const before=f.app().service.get(quest.id);
  const bootstrap=await f.request('/api/bootstrap');const cookie=bootstrap.headers['set-cookie'].split(';')[0];
  assert.equal((await f.request('/api/guildmaster/new',{questId:old.id,commandId:'fresh'})).status,401);
  f.app().service.gmTokens.set('fixture-token',old.id);
  assert.equal((await f.request('/api/guildmaster/history',undefined,{authorization:'Bearer fixture-token'})).status,403);
  assert.equal((await f.request('/api/guildmaster/new',{questId:old.id,commandId:'agent-reset'},{authorization:'Bearer fixture-token'})).status,403);
  const input={questId:old.id,commandId:'fresh'};
  assert.equal((await f.request('/api/guildmaster/new',input,{cookie})).status,200);
  assert.equal((await f.request('/api/guildmaster/new',input,{cookie})).status,200,'reset retries are idempotent');
  assert.equal((await f.request('/api/bootstrap')).data.guildmaster,null);
  assert.deepEqual(f.app().service.get(quest.id),before);assert.deepEqual(f.app().store.project(project.id),project);
  const history=await f.request('/api/guildmaster/history',undefined,{cookie});assert.equal(history.data.conversations[0].id,old.id);
  assert.equal((await f.request('/api/quests/'+old.id,undefined,{cookie})).data.messages[0].text,'Old private conversation');
  const fresh=await f.request('/api/guildmaster',{message:'Fresh request',model:'fake/test',workspaceMode:'none',commandId:'fresh-message'},{cookie});
  assert.equal(fresh.status,200);const id=fresh.data.quest.id;assert.notEqual(id,old.id);assert.notEqual(fresh.data.quest.sessionPath,old.sessionPath);
  for(let i=0;i<100&&f.app().service.get(id).status!=='awaiting_review';i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(f.app().service.get(id).status,'awaiting_review');
  assert.doesNotMatch(await readFile(f.app().service.get(id).sessionPath,'utf8'),/Old private conversation/);
  assert.equal((await f.request('/api/guildmaster/new',{questId:old.id,commandId:'stale-reset'},{cookie})).status,409);
  await f.restart();assert.equal((await f.request('/api/bootstrap')).data.guildmaster.id,id);
  assert.ok(f.app().store.get(old.id)?.archivedAt);assert.equal(f.app().store.messages(old.id).length,1);
});

test('fresh conversation rejects running, queued, and unanswered turns',async t=>{
  const f=await fixture(t);
  for(const status of ['running','queued','waiting','awaiting_input'] as const){const q={...f.seed(),status};f.app().store.save(q);await assert.rejects(f.app().service.newGuildmaster({questId:q.id,commandId:status}),/Finish or cancel/);assert.equal(f.app().store.get(q.id)?.archivedAt,undefined);}
  const q=f.seed();f.app().store.save(q);f.app().store.request({id:'pending',questId:q.id,runId:'run',question:'Which project?',status:'pending',createdAt:1});
  await assert.rejects(f.app().service.newGuildmaster({questId:q.id,commandId:'pending'}),/Finish or cancel/);
});

test('context measurements persist without activity noise and reject stale or malformed updates',async t=>{
  const f=await fixture(t),q={...f.seed(),status:'running' as const,activeRunId:'run'};f.app().store.save(q);
  const event={type:'context',tokens:8000,contextWindow:32000,percent:25,model:'fake/test'};
  f.app().service.workerEvent(q.id,'run',event);assert.equal(f.app().service.get(q.id).contextUsage?.percent,25);assert.equal(f.app().store.events(q.id).length,0);
  f.app().service.workerEvent(q.id,'stale',{...event,tokens:0,percent:0});assert.equal(f.app().service.get(q.id).contextUsage?.percent,25);
  assert.throws(()=>f.app().service.workerEvent(q.id,'run',{...event,tokens:-1}),/Invalid context usage/);
  f.app().service.workerEvent(q.id,'run',{...event,tokens:null,percent:null});assert.equal(f.app().service.get(q.id).contextUsage?.percent,null);
  await f.restart();assert.equal(f.app().service.get(q.id).contextUsage?.contextWindow,32000);
});
