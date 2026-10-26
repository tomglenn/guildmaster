import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../src/service/store.ts';
import {QuestService} from '../src/service/quests.ts';
import {SchedulesService} from '../src/service/schedules.ts';
import {createApp} from '../src/service/server.ts';
import type {ModelDefaults,ModelInfo} from '../src/domain/model-defaults.ts';

const models:ModelInfo[]=['gm','lead','delegate','coding','writing','review','other'].map(id=>({id:`fixture/${id}`,name:id,provider:'fixture',input:['text','image'],reasoningLevels:['off','high']}));
const choice=(name:string)=>({model:`fixture/${name}`,reasoning:null});
async function setup(t:TestContext){
 const dataDir=await mkdtemp(join(tmpdir(),'gm-defaults-'));const store=new Store(dataDir);
 const service=new QuestService({store,dataDir,workerPath:resolve('tests/fixtures/worker.ts')});service.schedule=()=>{};
 service.modelDefaults.catalog=models;service.modelDefaults.initialize('fixture/gm');
 const defaults:ModelDefaults={revision:1,guildmaster:choice('gm'),quest:choice('lead'),delegate:choice('delegate'),specialists:{coding:{...choice('coding'),reasoning:'high'},writing:choice('writing'),review:choice('review')}};
 await service.saveModelDefaults({...defaults,commandId:'defaults'});
 t.after(async()=>{await service.close();store.close();await rm(dataDir,{recursive:true,force:true});});
 return {store,service,dataDir};
}
function idle(service:QuestService,id:string){const q=service.get(id);q.status='awaiting_review';q.activeRunId=undefined;service.store.save(q);return q;}

test('Guildmaster remembers its manual choice across New conversation and restart; assignments use independent defaults',async t=>{
 const {service,store,dataDir}=await setup(t);
 const gm=(await service.guildmaster({message:'Plan the work',workspaceMode:'none',commandId:'gm'})).quest;
 assert.equal(gm.model,'fixture/gm');idle(service,gm.id);
 const change={model:'fixture/other',revision:service.modelDefaults.get()!.revision,commandId:'choose'};
 await service.saveModelDefaults(change,true);
 assert.equal(service.get(gm.id).model,'fixture/other');
 await service.newGuildmaster({questId:gm.id,commandId:'new'});
 assert.equal(service.modelDefaults.get()!.guildmaster.model,'fixture/other');
 const next=(await service.guildmaster({message:'New context',workspaceMode:'none',commandId:'gm2'})).quest;
 assert.equal(next.model,'fixture/other');assert.notEqual(next.sessionPath,gm.sessionPath);
 const lead=(await service.create({objective:'Mixed task with arbitrary scope',workspaceMode:'none',commandId:'lead'})).quest;
 assert.equal(lead.model,'fixture/lead');lead.status='running';store.save(lead);
 for(const preference of [undefined,'coding','writing','review'] as const){
  const q=(await service.createDelegate(lead.id,{objective:'Follow the project skill',modelPreference:preference,commandId:`agent-${preference}`},lead.activeRunId)).agent;
  assert.equal(q.model,`fixture/${preference??'delegate'}`);
  assert.deepEqual(store.getRun(q.activeRunId!)!.data.execution,q.execution);
 }
 await service.close();
 const reopened=new QuestService({store,dataDir,workerPath:resolve('tests/fixtures/worker.ts')});reopened.schedule=()=>{};
 assert.equal(reopened.modelDefaults.get()!.guildmaster.model,'fixture/other');
 await reopened.close();
});

test('selection saves reject stale/busy writes; configured presets cannot replace saved assignments',async t=>{
 const {service,store}=await setup(t);
 const gm=(await service.guildmaster({message:'Wait',workspaceMode:'none',commandId:'gm'})).quest;
 await assert.rejects(service.saveModelDefaults({model:'fixture/other',revision:2,commandId:'busy'},true),/finish/);
 idle(service,gm.id);
 await service.saveModelDefaults({model:'fixture/other',revision:2,commandId:'saved'},true);
 await assert.rejects(service.saveModelDefaults({model:'fixture/gm',revision:2,commandId:'stale'},true),/changed elsewhere/);
 const migration=await service.saveModelDefaults({model:'fixture/gm',revision:2,migrate:true,commandId:'migration'},true);
 assert.equal(migration.defaults.guildmaster.model,'fixture/other');
 const lead=(await service.create({objective:'Implement it',workspaceMode:'none',commandId:'lead'})).quest;
 lead.status='running';store.save(lead);
 await assert.rejects(service.createDelegate(lead.id,{objective:'Escalate',model:'fixture/other',commandId:'bad'} as any,lead.activeRunId),/configured/);
 const delegate=(await service.createDelegate(lead.id,{objective:'Review it',modelPreference:'review',commandId:'review'},lead.activeRunId)).agent;
 const original=store.getRun(delegate.activeRunId!)!.data.execution;
 assert.throws(()=>store.run(delegate.activeRunId!,delegate.id,{execution:choice('other')}),/cannot change/);
 const defaults=service.modelDefaults.get()!;await service.saveModelDefaults({...defaults,delegate:choice('other'),commandId:'new-default'});
 assert.equal(service.get(delegate.id).model,'fixture/review');assert.deepEqual(store.getRun(delegate.activeRunId!)!.data.execution,original);
 const fresh=(await service.createDelegate(lead.id,{objective:'New general work',commandId:'new-agent'},lead.activeRunId)).agent;
 assert.equal(fresh.model,'fixture/other');
});

test('schedule saves pin lead and team models across global changes and subsequent edits',async t=>{
 const {service}=await setup(t);const schedules=new SchedulesService(service);
 t.after(()=>schedules.close());
 const {schedule}=await schedules.save({name:'Review',objective:'Follow the project review skill',projectId:null,workspacePolicy:'shared',model:'fixture/lead',tools:[],recurrence:{days:[1],time:'08:30',timezone:'UTC'},missed:'skip',commandId:'schedule'});
 assert.equal(schedule.modelDefaults?.specialists.review?.model,'fixture/review');
 await service.saveModelDefaults({...service.modelDefaults.get(),quest:{...choice('other'),reasoning:'high'},delegate:choice('other'),specialists:{review:choice('other')},commandId:'changed'});
 const edited=(await schedules.save({...schedule,name:'Renamed',commandId:'rename'},schedule.id)).schedule;
 assert.equal(edited.modelDefaults?.specialists.review?.model,'fixture/review');
 await schedules.action(edited.id,'run',{revision:edited.revision,commandId:'run'});
 for(let i=0;i<100&&!service.store.list().some(q=>q.schedule?.id===edited.id);i++)await new Promise(r=>setTimeout(r,10));
 const q=service.store.list().find(q=>q.schedule?.id===edited.id)!;
 assert.equal(q.model,'fixture/lead');assert.equal(q.teamModels?.specialists.review?.model,'fixture/review');
 q.status='running';service.store.save(q);
 const child=(await service.createDelegate(q.id,{objective:'Review',modelPreference:'review',commandId:'scheduled-review'},q.activeRunId)).agent;
 assert.equal(child.model,'fixture/review');
});

test('HTTP model settings and picker share one revision; agents cannot write settings or raw models',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'gm-defaults-http-'));
 const app=createApp({dataDir,port:0,models,workerPath:resolve('tests/fixtures/worker.ts')});const {url,token}=await app.listen();
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const request=async(path:string,body?:unknown,auth=token)=>{const r=await fetch(url+path,{headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 const initial=(await request('/api/settings/models')).data;
 assert.equal(initial.defaults.guildmaster.model,'fixture/gm');
 assert.equal((await request('/api/guildmaster/model',{model:'fixture/other',revision:1,commandId:'picker'})).status,200);
 assert.equal((await request('/api/bootstrap')).data.defaultModel,'fixture/other');
 assert.equal((await request('/api/settings/models')).data.defaults.guildmaster.model,'fixture/other');
 const started=await request('/api/guildmaster',{message:'[wait] Test',workspaceMode:'none',commandId:'gm'});
 assert.equal(started.status,200);const q=started.data.quest;
 const spec=JSON.parse(await readFile(join(dataDir,'runs',q.activeRunId+'.json'),'utf8'));
 assert.equal((await request('/api/settings/models',{...initial.defaults,commandId:'agent'},spec.serviceToken)).status,403);
 assert.equal((await request('/api/quests',{objective:'Raw escalation',workspaceMode:'none',model:'fixture/review',commandId:'raw'},spec.serviceToken)).status,403);
});


test('legacy schedules retain their saved model when defaults are introduced',async t=>{
 const {service,store}=await setup(t);const schedules=new SchedulesService(service);t.after(()=>schedules.close());
 const {schedule}=await schedules.save({name:'Legacy',objective:'Saved task',projectId:null,workspacePolicy:'shared',model:'fixture/other',tools:[],recurrence:{days:[1],time:'08:30',timezone:'UTC'},missed:'skip',commandId:'legacy'});
 delete schedule.modelDefaults;store.saveSchedule(schedule);
 schedules.initializeModelDefaults();
 assert.deepEqual(schedules.get(schedule.id).modelDefaults?.quest,choice('other'));
 await service.saveModelDefaults({...service.modelDefaults.get(),specialists:{review:choice('coding')},commandId:'later'});
 schedules.initializeModelDefaults();
 assert.equal(schedules.get(schedule.id).modelDefaults?.specialists.review?.model,'fixture/review');
 await schedules.action(schedule.id,'run',{revision:schedule.revision,commandId:'run-legacy'});
 for(let i=0;i<100&&!store.list().some(q=>q.schedule?.id===schedule.id);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(store.list().find(q=>q.schedule?.id===schedule.id)?.model,'fixture/other');
});
