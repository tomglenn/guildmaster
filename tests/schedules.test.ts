import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import { SchedulesService } from '../src/service/schedules.ts';
import type { ScheduleOccurrence } from '../src/domain/schedules.ts';

async function fixture(t:TestContext) {
 const root=await mkdtemp(join(tmpdir(),'guildmaster-schedules-')),dataDir=join(root,'data');
 let now=Date.parse('2026-10-16T07:00Z');
 let store=new Store(dataDir),quests=new QuestService({store,dataDir,defaultWorkspace:root});quests.schedule=()=>{};
 let schedules=new SchedulesService(quests,()=>now);
 t.after(async()=>{await schedules.close();await quests.close();store.close();await rm(root,{recursive:true,force:true});});
 const config={name:'Morning Brief',objective:'Read the selected sources and summarize concrete findings. Do not act on them.',recurrence:{days:[1,2,3,4,5],time:'08:30',timezone:'Europe/London'},missed:'latest',projectId:null,workspacePolicy:'shared',tools:['read'],model:'fixture/model',commandId:'create'};
 return {root,dataDir,config,store:()=>store,quests:()=>quests,schedules:()=>schedules,time:(value:string)=>{now=Date.parse(value);},restart:async()=>{await schedules.close();await quests.close();store.close();store=new Store(dataDir);quests=new QuestService({store,dataDir,defaultWorkspace:root});quests.schedule=()=>{};schedules=new SchedulesService(quests,()=>now);}};
}

test('schedule creates one ordinary quest with atomic occurrence link and distinct provenance',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 await f.schedules().tick();assert.equal(f.store().list().length,0);
 f.time('2026-10-16T07:30Z');await Promise.all([f.schedules().tick(),f.schedules().tick()]);
 const q=f.store().list()[0];assert.equal(f.store().list().length,1);assert.equal(q.kind,'quest');assert.equal(q.parentQuestId,undefined);assert.equal(q.schedule?.id,s.id);
 assert.equal(f.store().messages(q.id)[0].source,'schedule');
 assert.equal(f.store().occurrences(s.id)[0].questId,q.id);assert.equal(f.store().occurrences(s.id)[0].state,'launched');
 assert.match(q.instructions,/Do not create additional quests/);
 assert.equal(f.schedules().get(s.id).nextAt,Date.parse('2026-10-19T07:30Z'));
 q.status='running';f.store().save(q);
 await assert.rejects(f.quests().createFollowup(q.id,{title:'Unauthorized',objective:'More work',userRequest:q.objective,workspacePolicy:'shared',commandId:'cascade'},q.activeRunId!),/latest direct user/);
 await f.schedules().tick();assert.equal(f.store().list().length,1);
});

test('catch-up runs only the latest missed occurrence; skip policy records a skip',async t=>{
 const f=await fixture(t),a=(await f.schedules().save(f.config)).schedule;
 const b=(await f.schedules().save({...f.config,name:'Skip',missed:'skip',commandId:'skip'})).schedule;
 f.time('2026-10-21T10:00Z');await f.schedules().tick();
 assert.equal(f.store().list().length,1);assert.equal(f.store().occurrences(a.id)[0].scheduledAt,Date.parse('2026-10-21T07:30Z'));
 assert.match(f.store().occurrences(a.id)[0].reason!,/Earlier missed/);
 assert.equal(f.store().occurrences(b.id)[0].state,'skipped');
 assert.equal(f.schedules().get(a.id).nextAt,Date.parse('2026-10-22T07:30Z'));
});

test('active and interrupted occurrences block overlap, completed reports do not',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 f.time('2026-10-16T07:30Z');await f.schedules().tick();const q=f.store().list()[0];
 await assert.rejects(f.schedules().action(s.id,'run',{revision:s.revision,commandId:'overlap'}),/already active/);
 f.time('2026-10-19T07:30Z');await f.schedules().tick();assert.equal(f.store().occurrences(s.id)[0].state,'skipped');
 q.status='interrupted';f.store().save(q);f.time('2026-10-20T07:30Z');await f.schedules().tick();assert.equal(f.store().list().length,1);
 q.status='awaiting_review';q.activeRunId=undefined;f.store().save(q);
 for(const delivery of f.store().pendingDeliveries(q.id))f.store().saveDelivery({...delivery,deliveredAt:1});
 f.time('2026-10-21T07:30Z');await f.schedules().tick();assert.equal(f.store().list().length,2);
});

test('pause, resume, edit, and delete preserve existing quests and reject stale edits',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 f.time('2026-10-16T07:30Z');await f.schedules().tick();const q=f.store().list()[0];
 const paused=(await f.schedules().action(s.id,'pause',{revision:s.revision,commandId:'pause'})).schedule!;
 assert.equal(f.quests().get(q.id).status,'queued');
 f.time('2026-10-20T10:00Z');await f.schedules().tick();assert.equal(f.store().list().length,1);
 await assert.rejects(f.schedules().save({...f.config,revision:s.revision,commandId:'stale'},s.id),/changed elsewhere/);
 const edited=(await f.schedules().save({...f.config,name:'New brief',revision:paused.revision,commandId:'edit'},s.id)).schedule;
 assert.equal(edited.enabled,false);assert.equal(f.store().get(q.id)!.schedule!.name,'Morning Brief');
 const resumed=(await f.schedules().action(s.id,'resume',{revision:edited.revision,commandId:'resume'})).schedule!;
 assert.equal(resumed.nextAt,Date.parse('2026-10-21T07:30Z'));
 await f.schedules().action(s.id,'delete',{revision:resumed.revision,commandId:'delete'});
 assert.equal(f.store().schedule(s.id),undefined);assert.ok(f.store().get(q.id));assert.equal(f.schedules().history(s.id).total,1);
 assert.equal(f.quests().detail(q.id).scheduleAvailable,false);
});

test('run now is idempotent, works while paused, and keeps the regular timetable',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 const paused=(await f.schedules().action(s.id,'pause',{revision:s.revision,commandId:'pause'})).schedule!;
 const input={revision:paused.revision,commandId:'manual'};
 const a=await f.schedules().action(s.id,'run',input),b=await f.schedules().action(s.id,'run',input);
 assert.equal(a.occurrence!.id,b.occurrence!.id);await f.schedules().tick();
 assert.equal(f.store().list().length,1);assert.equal(f.schedules().get(s.id).nextAt,s.nextAt);assert.equal(f.schedules().get(s.id).enabled,false);
});

test('restart reconciles preparation and preserves committed occurrence identity',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 const occurrence:ScheduleOccurrence={id:'recovery',scheduleId:s.id,config:s,scheduledAt:s.nextAt,createdAt:s.nextAt,trigger:'scheduled',state:'preparing'};
 f.store().saveOccurrence(occurrence);
 await f.restart();await f.schedules().tick();assert.equal(f.store().list().length,1);const q=f.store().list()[0];
 await f.restart();await f.schedules().tick();assert.equal(f.store().list().length,1);assert.equal(f.store().occurrences(s.id)[0].questId,q.id);
 assert.equal(f.store().get(q.id)!.status,'interrupted');
});

test('deleting or editing during preparation prevents commit without resurrecting configuration',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 const original=f.quests().create.bind(f.quests());let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
 f.quests().create=async(...args)=>{enter();await hold;return original(...args);};
 f.time('2026-10-16T07:30Z');const tick=f.schedules().tick();await entered;
 await f.schedules().action(s.id,'delete',{revision:s.revision,commandId:'delete'});release();await tick;
 assert.equal(f.store().list().length,0);assert.equal(f.store().schedule(s.id),undefined);assert.equal(f.store().occurrences(s.id)[0].state,'skipped');
});

test('creation and occurrence commit roll back together on a storage failure',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 const original=f.store().saveOccurrence.bind(f.store());let failed=false;
 t.mock.method(f.store(),'saveOccurrence',(o:ScheduleOccurrence)=>{if(o.state==='launched'&&!failed){failed=true;throw new Error('Injected commit failure');}original(o);});
 f.time('2026-10-16T07:30Z');await f.schedules().tick();
 assert.equal(f.store().list().length,0);assert.equal(f.store().occurrences(s.id)[0].state,'failed');
});

test('invalid configurations and archived projects fail before launch; failures remain in history',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.schedules().save({...f.config,recurrence:{...f.config.recurrence,days:[]}}),/day/);
 const repo=join(f.root,'repo');await mkdir(repo);execFileSync('git',['init','-q'],{cwd:repo});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','Initial'],{cwd:repo});
 const project=(await f.quests().saveProject({name:'Example',repositories:[{name:'Source',path:repo}],commandId:'project'})).project;
 const s=(await f.schedules().save({...f.config,projectId:project.id,workspacePolicy:'isolated'})).schedule;
 await f.quests().projectAction(project.id,'archive',{commandId:'archive'});f.time('2026-10-16T07:30Z');await f.schedules().tick();
 assert.equal(f.store().occurrences(s.id)[0].state,'failed');assert.match(f.store().occurrences(s.id)[0].reason!,/archived/);assert.equal(f.store().list().length,0);
});

test('schedule drafts persist configuration without enabling or starting work',async t=>{
 const f=await fixture(t),draft=await f.schedules().draft(f.config);
 assert.match(draft.url,/scheduleDraft=/);assert.equal(f.store().schedules().length,0);assert.equal(f.store().list().length,0);assert.equal(f.store().scheduleDraft(draft.draftId)!.name,'Morning Brief');
});

test('unresolved delegate work blocks the next occurrence even if the lead has finished its turn',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 f.time('2026-10-16T07:30Z');await f.schedules().tick();const q=f.store().list()[0];
 q.status='running';f.store().save(q);const delegate=(await f.quests().createDelegate(q.id,{title:'Source review',objective:'Read the assigned source.',commandId:'delegate'})).agent;
 q.status='awaiting_review';q.activeRunId=undefined;f.store().save(q);delegate.status='awaiting_input';f.store().save(delegate);
 f.time('2026-10-19T07:30Z');await f.schedules().tick();
 assert.equal(f.store().list().filter(q=>q.kind==='quest').length,1);assert.equal(f.store().occurrences(s.id)[0].state,'skipped');
});

test('isolated occurrences use private checkouts and retain their scheduled message source',async t=>{
 const f=await fixture(t),repo=join(f.root,'repo');await mkdir(repo);
 execFileSync('git',['init','-q'],{cwd:repo});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','Initial'],{cwd:repo});
 const project=(await f.quests().saveProject({name:'Example',repositories:[{name:'Source',path:repo}],commandId:'project'})).project;
 const s=(await f.schedules().save({...f.config,projectId:project.id,workspacePolicy:'isolated'})).schedule;
 f.time('2026-10-16T07:30Z');await f.schedules().tick();const q=f.store().list()[0];
 assert.equal(q.workspacePolicy,'isolated');assert.notEqual(q.workspacePath,repo);assert.equal(q.schedule!.id,s.id);
 assert.equal(f.store().messages(q.id)[0].source,'schedule');assert.equal(f.store().occurrences(s.id)[0].questId,q.id);
});

test('safely closed interrupted occurrence releases overlap without changing recurrence',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 f.time('2026-10-16T07:30Z');await f.schedules().tick();const q=f.store().list()[0];
 q.status='interrupted';q.activeRunId=undefined;q.closedAt=1;q.closeReason='closed';f.store().save(q);
 for(const delivery of f.store().pendingDeliveries(q.id))f.store().saveDelivery({...delivery,cancelledAt:1});
 f.store().save({...q,id:'closed-child',kind:'delegate',parentQuestId:q.id,schedule:undefined});
 assert.equal(f.schedules().list()[0].blockedBy,undefined);
 assert.equal(f.schedules().get(s.id).enabled,true);
 f.time('2026-10-19T07:30Z');await f.schedules().tick();
 assert.equal(f.store().list().filter(item=>item.kind==='quest').length,2);
 assert.equal(f.schedules().history(s.id).items.find(item=>item.questId===q.id)?.quest?.closedAt,1);
});

test('closed or cancelled occurrence never conceals child questions or active work from overlap checks',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 f.time('2026-10-16T07:30Z');await f.schedules().tick();const q=f.store().list()[0];
 q.status='cancelled';q.activeRunId=undefined;q.closedAt=1;f.store().save(q);
 for(const delivery of f.store().pendingDeliveries(q.id))f.store().saveDelivery({...delivery,cancelledAt:1});
 const child={...q,id:'question-child',kind:'delegate' as const,parentQuestId:q.id,status:'failed' as const,schedule:undefined};f.store().save(child);
 f.store().request({id:'pending',questId:child.id,runId:'r',question:'Continue?',status:'pending',createdAt:1});
 assert.equal(f.schedules().list()[0].blockedBy?.id,q.id);
 await assert.rejects(f.schedules().action(s.id,'run',{revision:s.revision,commandId:'question-overlap'}),/already active/);
 f.store().request({...f.store().requests(child.id)[0],status:'dismissed'});
 child.status='running' as never;f.store().save(child);
 assert.equal(f.schedules().list()[0].blockedBy?.id,q.id);
 child.status='failed';f.store().save(child);
 f.store().request({id:'own-pending',questId:q.id,runId:'r',question:'Own question?',status:'pending',createdAt:1});
 assert.equal(f.schedules().list()[0].blockedBy?.id,q.id);
});

test('stale preparation does not block the first due occurrence of an edited configuration',async t=>{
 const f=await fixture(t),s=(await f.schedules().save(f.config)).schedule;
 f.store().saveOccurrence({id:'stale-preparation',scheduleId:s.id,config:s,scheduledAt:s.nextAt,createdAt:s.createdAt,trigger:'scheduled',state:'preparing'});
 const edited=(await f.schedules().save({...f.config,name:'Updated brief',revision:s.revision,commandId:'edit'},s.id)).schedule;
 f.time('2026-10-19T10:00Z');await f.schedules().tick();
 assert.equal(f.store().occurrence('stale-preparation')!.state,'skipped');assert.equal(f.store().list().length,1);
 assert.equal(f.store().list()[0].schedule!.revision,edited.revision);assert.equal(f.store().list()[0].schedule!.name,'Updated brief');
});
