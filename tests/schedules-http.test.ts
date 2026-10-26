import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/service/server.ts';
import { guildmasterTools } from '../src/engine/tools.ts';
import type { WorkerSpec } from '../src/engine/protocol.ts';

test('schedule HTTP management is user-only, drafts are Guildmaster-only, and deletion retains quests',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-schedules-http-'));
 const app=createApp({dataDir,port:4173,models:[{id:'fixture/model',name:'Fixture'}],defaultWorkspace:dataDir});app.service.schedule=()=>{};app.service.modelDefaults.initialize('fixture/model');
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>new Promise<{status:number;data:any;headers:Record<string,string>}>(resolve=>{
   const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]) as any;
   req.url=path;req.method=body===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4173','content-type':'application/json',...headers};
   const res=new EventEmitter() as any,values:Record<string,string>={};res.statusCode=200;res.headersSent=false;
   res.setHeader=(key:string,value:string)=>{values[key.toLowerCase()]=value;};
   res.writeHead=(status:number,headers:Record<string,string>={})=>{res.statusCode=status;res.headersSent=true;for(const [key,value]of Object.entries(headers))res.setHeader(key,value);};
   res.end=(body:string)=>resolve({status:res.statusCode,data:JSON.parse(body),headers:values});app.server.emit('request',req,res);
 });
 const cookie=(await request('/api/bootstrap')).headers['set-cookie'].split(';')[0],human={cookie};
 const gm=(await app.service.create({objective:'Coordinate',workspaceMode:'none',tools:['read'],model:'fixture/model',commandId:'gm'},'guildmaster')).quest;
 const lead=(await app.service.create({objective:'Read sources',workspaceMode:'none',tools:['read'],commandId:'lead'})).quest;lead.status='running';app.store.save(lead);
 gm.status='running';app.store.save(gm);app.service.gmRunTokens.set('gm-token',gm.activeRunId!);
 app.service.gmTokens.set('gm-token',gm.id);app.service.workerTokens.set('lead-token',{questId:lead.id,runId:lead.activeRunId!});
 const gmAuth={authorization:'Bearer gm-token'},leadAuth={authorization:'Bearer lead-token'};
 const input={name:'Brief',objective:'Summarize selected sources only.',recurrence:{days:[1,2,3,4,5],time:'08:30',timezone:'Europe/London'},missed:'latest',projectId:null,workspacePolicy:'shared',tools:['read'],commandId:'config'};
 assert.equal((await request('/api/schedules',input)).status,401);
 for(const auth of [gmAuth,leadAuth]){
   assert.equal((await request('/api/schedules',undefined,auth)).status,403);
   assert.equal((await request('/api/schedules',input,auth)).status,403);
 }
 assert.equal((await request('/api/schedule-drafts',input,human)).status,403);
 assert.equal((await request('/api/schedule-drafts',input,leadAuth)).status,403);
 const draft=await request('/api/schedule-drafts',{...input,commandId:'draft-config'},gmAuth);assert.equal(draft.status,201);assert.equal(app.store.schedules().length,0);
 assert.equal((await request('/api/schedule-drafts/'+draft.data.draftId,undefined,human)).data.draft.name,'Brief');
 assert.equal((await request('/api/schedule-drafts/'+draft.data.draftId,undefined,gmAuth)).status,403);
 const created=await request('/api/schedules',input,human);assert.equal(created.status,200);const schedule=created.data.schedule;
 assert.equal(schedule.model,'fixture/model','Default model is captured when saved.');
 assert.equal((await request('/api/schedules',input,human)).data.schedule.id,schedule.id);
 const paused=await request(`/api/schedules/${schedule.id}/pause`,{revision:schedule.revision,commandId:'pause'},human);assert.equal(paused.status,200);
 assert.equal((await request(`/api/schedules/${schedule.id}`,{...input,revision:schedule.revision,commandId:'stale-edit'},human)).status,409);
 const revision=paused.data.schedule.revision;
 const manual=await request(`/api/schedules/${schedule.id}/run`,{revision,commandId:'run'},human);assert.equal(manual.status,200);
 await app.schedules.tick();const q=app.store.list().find(q=>q.schedule?.id===schedule.id)!;assert.ok(q);
 assert.equal((await request(`/api/schedules/${schedule.id}/history?offset=-1`,undefined,human)).status,400);
 assert.equal((await request(`/api/schedules/${schedule.id}/history`,undefined,human)).data.items[0].quest.id,q.id);
 assert.equal((await request(`/api/schedules/${schedule.id}/delete`,{revision,commandId:'delete'},human)).status,200);
 assert.ok(app.store.get(q.id));assert.equal(app.store.schedule(schedule.id),undefined);
 assert.equal((await request(`/api/quests/${q.id}`,undefined,human)).data.scheduleAvailable,false);
});

test('prepare_schedule sends only a draft with bounded capabilities and a review URL',async t=>{
 const urls:{url:string;body:any}[]=[];
 t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
   const body=init.body?JSON.parse(String(init.body)):undefined;urls.push({url:String(url),body});
   return new Response(JSON.stringify(init.method==='GET'?{capabilities:{schedules:true}}:{draftId:'draft',url:'/?scheduleDraft=draft'}));
 });
 const spec:WorkerSpec={questId:'gm',runId:'run',role:'guildmaster',cwd:'.',prompt:'Schedule a brief',sessionPath:'fixture',serviceUrl:'http://127.0.0.1:4173',serviceToken:'fixture',tools:['read'],model:'fixture/model'};
 const tool=guildmasterTools(spec).find(t=>t.name==='prepare_schedule')!;
 await tool.execute('call',{name:'Brief',objective:'Read selected sources',recurrence:{days:[1],time:'08:30',timezone:'UTC'},missed:'latest',projectId:null,workspacePolicy:'shared'},undefined,undefined,{} as any);
 assert.deepEqual(urls.map(u=>u.url),['http://127.0.0.1:4173/api/health','http://127.0.0.1:4173/api/schedule-drafts']);
 assert.deepEqual(urls[1].body.tools,['read']);assert.equal(urls[1].body.commandId,'run:call');assert.match(tool.description,/never an enabled schedule/);
});
