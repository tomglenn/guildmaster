import { randomUUID } from 'node:crypto';
import { AppError, ALLOWED_TOOLS, DEFAULT_TOOLS, type Quest } from '../domain/types.ts';
import type { ScheduleConfig, QuestSchedule, ScheduleOccurrence } from '../domain/schedules.ts';
import { nextOccurrence, previousOccurrence, validateRecurrence } from '../domain/recurrence.ts';
import { text, resolveProject, requireActiveProject } from './projects.ts';
import type { QuestService } from './quests.ts';

const blocking = new Set(['queued','running','waiting','awaiting_input','interrupted']);
export class SchedulesService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private stopped = false;
  private dispatching = new Map<string,Promise<void>>();
  private service: QuestService;
  private now: () => number;
  lastError?: string;
  constructor(service: QuestService, now: () => number = Date.now) {this.service=service;this.now=now;}
  private get store() {return this.service.store;}
  get(id: string) {const value=this.store.schedule(id);if(!value)throw new AppError('Schedule not found.',404);return value;}
  private blocker(id: string) {
    const quests=this.store.list();
    return quests.find(q=>{
      if(q.schedule?.id!==id||q.kind!=='quest')return false;
      const family=quests.filter(item=>item.id===q.id||item.parentQuestId===q.id);
      // Closure only releases abandoned interruption recovery, never live work
      // or unanswered questions (including inconsistent legacy families).
      if(this.service.familyPreparing(q.id)||family.some(item=>this.service.live.has(item.id)||item.activeRunId||this.store.requests(item.id).some(request=>request.status==='pending')||this.store.pendingDeliveries(item.id).length))return true;
      return family.some(item=>blocking.has(item.status)&&!(item.status==='interrupted'&&q.closedAt!==undefined));
    });
  }
  list() {return this.store.schedules().map(schedule=>({
    ...schedule, blockedBy:this.blocker(schedule.id), latest:this.history(schedule.id,0,1).items[0],
    preparing:this.store.preparingOccurrences(schedule.id).length>0,
  }));}
  history(id: string, offset=0, limit=20) {
    const page=this.store.occurrencePage(id,offset,limit);
    return {items:page.items.map(o=>({...o,quest:o.questId?this.store.get(o.questId):undefined,startedAt:o.questId?this.store.runs(o.questId)[0]?.data.startedAt:undefined})),total:page.total};
  }
  private config(input: Record<string,any>): ScheduleConfig {
    const name=text(input.name,'Name',160),objective=text(input.objective,'Instructions');
    try {validateRecurrence(input.recurrence);} catch(error) {throw new AppError((error as Error).message);}
    if (!['latest','skip'].includes(input.missed)) throw new AppError('Choose a missed-run policy.');
    const tools=input.tools ?? DEFAULT_TOOLS;
    if(!Array.isArray(tools)||tools.length>ALLOWED_TOOLS.length||tools.some(t=>!ALLOWED_TOOLS.includes(t)))throw new AppError('Unknown tool capability.');
    const projectId=input.projectId ? resolveProject(this.store,input.projectId).id : null;
    if(projectId)requireActiveProject(this.store.project(projectId)!);
    if(input.repositoryIds!==undefined && (!Array.isArray(input.repositoryIds)||input.repositoryIds.some((id:unknown)=>typeof id!=='string')||new Set(input.repositoryIds).size!==input.repositoryIds.length))throw new AppError('Select valid repository IDs.');
    if(input.repositoryIds?.length && (!projectId||input.repositoryIds.some((id:string)=>!this.store.project(projectId)!.repositories.some(r=>r.id===id))))throw new AppError('A selected repository is unavailable.');
    if(!['shared','isolated'].includes(input.workspacePolicy))throw new AppError('Choose a workspace policy.');
    if(input.workspacePolicy==='isolated'&&(!projectId||input.repositoryIds?.length===0))throw new AppError('Isolated work requires at least one project repository.');
    return {name,objective,recurrence:{days:[...input.recurrence.days].sort((a,b)=>a-b),time:input.recurrence.time,timezone:input.recurrence.timezone},
      missed:input.missed,projectId,repositoryIds:input.repositoryIds,workspacePolicy:input.workspacePolicy,model:typeof input.model==='string'?input.model.trim().slice(0,250):'',tools:[...new Set<string>(tools)]};
  }
  async save(input: Record<string,any>, id?: string) {
    return this.service.serialize(()=>{
      const command=this.service.checkCommand(input.commandId,id?`edit:schedule:${id}`:'create:schedule',input);
      if(command.cached)return command.cached;
      const previous=id?this.get(id):undefined;
      if(previous&&input.revision!==previous.revision)throw new AppError('This schedule changed elsewhere. Reload it before saving.',409);
      const config=this.config(input),now=this.now();
      const schedule:QuestSchedule={...config,id:id??randomUUID(),enabled:previous?.enabled??true,revision:(previous?.revision??0)+1,nextAt:nextOccurrence(config.recurrence,now),createdAt:previous?.createdAt??now,updatedAt:now};
      const response={schedule};
      this.store.transaction(()=>{this.store.saveSchedule(schedule);this.store.saveCommand(command.id,command.fingerprint,response);});
      this.changed();return response;
    });
  }
  async draft(input: Record<string,any>) {
    return this.service.serialize(()=>{
      const command=this.service.checkCommand(input.commandId,'draft:schedule',input);
      if(command.cached)return command.cached;
      const config=this.config(input),id=randomUUID(),response={draftId:id,url:`/?scheduleDraft=${id}`,message:'This is a draft only. Ask the user to review and save it to enable recurring execution.'};
      this.store.transaction(()=>{this.store.saveScheduleDraft(id,config);this.store.saveCommand(command.id,command.fingerprint,response);});
      return response;
    });
  }
  async action(id: string, action: 'pause'|'resume'|'delete'|'run', input: Record<string,any>) {
    let occurrence:ScheduleOccurrence|undefined;
    const response=await this.service.serialize(()=>{
      const command=this.service.checkCommand(input.commandId,`${action}:schedule:${id}`,input);
      if(command.cached)return command.cached;
      const previous=this.get(id);
      if(input.revision!==previous.revision)throw new AppError('This schedule changed elsewhere. Reload it before continuing.',409);
      const schedule={...previous};
      if(action==='run') {
        const active=this.blocker(id);
        if(active||this.store.preparingOccurrences(id).length>0)throw new AppError('An occurrence is already active. Finish or close it before starting another.',409);
        occurrence={id:randomUUID(),scheduleId:id,config:schedule,scheduledAt:this.now(),createdAt:this.now(),trigger:'manual',state:'preparing'};
      } else {schedule.revision++;schedule.updatedAt=this.now();schedule.enabled=action==='resume';if(action==='resume')schedule.nextAt=nextOccurrence(schedule.recurrence,this.now());}
      const result=occurrence?{occurrence}:{schedule:action==='delete'?null:schedule};
      this.store.transaction(()=>{
        if(occurrence)this.store.saveOccurrence(occurrence);
        else if(action==='delete')this.store.deleteSchedule(id);
        else this.store.saveSchedule(schedule);
        this.store.saveCommand(command.id,command.fingerprint,result);
      });
      this.changed();return result;
    });
    if(occurrence)void this.launch(occurrence).catch(error=>{this.lastError=(error as Error).message;this.changed();});
    return response;
  }
  private changed() {this.service.emit('change',{schedules:true});}
  start() {
    const tick=()=>{void this.tick().catch(error=>{this.lastError=(error as Error).message;this.changed();});};
    this.timer=setInterval(tick,15000);this.timer.unref();tick();
  }
  async close() {this.stopped=true;if(this.timer)clearInterval(this.timer);await this.ticking;await Promise.allSettled(this.dispatching.values());}
  tick(): Promise<void> {
    if(this.stopped)return Promise.resolve();
    if(this.ticking)return this.ticking;
    this.ticking=this.sweep().finally(()=>{this.ticking=undefined;});return this.ticking;
  }
  private async sweep() {
    const ready=await this.service.serialize(()=>{
      if(this.stopped)return [];
      const pending:ScheduleOccurrence[]=[];
      const now=this.now();
      this.store.transaction(()=>{
        for(const occurrence of this.store.preparingOccurrences()) {
          const current=this.store.schedule(occurrence.scheduleId);
          if(!current||current.revision!==occurrence.config.revision||(occurrence.trigger==='scheduled'&&!current.enabled))this.store.saveOccurrence({...occurrence,state:'skipped',reason:'Schedule was changed, paused, or deleted before launch.'});
          else pending.push(occurrence);
        }
        for(const schedule of this.store.schedules()) {
          if(!schedule.enabled||schedule.nextAt>now)continue;
          const at=previousOccurrence(schedule.recurrence,now);
          const occurrence:ScheduleOccurrence={id:`${schedule.id}:${schedule.revision}:${at}`,scheduleId:schedule.id,config:{...schedule},scheduledAt:at,createdAt:now,trigger:'scheduled',state:'preparing'};
          if(this.blocker(schedule.id)||pending.some(o=>o.scheduleId===schedule.id))Object.assign(occurrence,{state:'skipped',reason:'The previous occurrence still needs to finish.'});
          else if(schedule.missed==='skip'&&now-at>60000)Object.assign(occurrence,{state:'skipped',reason:'Guildmaster was unavailable at the scheduled time.'});
          if(at>schedule.nextAt)occurrence.reason=occurrence.reason??'Earlier missed occurrences were skipped; this is the latest occurrence.';
          schedule.nextAt=nextOccurrence(schedule.recurrence,now);this.store.saveSchedule(schedule);this.store.saveOccurrence(occurrence);
          if(occurrence.state==='preparing')pending.push(occurrence);
        }
      });
      return pending;
    });
    await Promise.allSettled(ready.map(o=>this.launch(o)));this.lastError=undefined;this.changed();
  }
  private launch(occurrence: ScheduleOccurrence): Promise<void> {
    const existing=this.dispatching.get(occurrence.id);if(existing)return existing;
    const task=this.dispatch(occurrence).finally(()=>this.dispatching.delete(occurrence.id));
    this.dispatching.set(occurrence.id,task);return task;
  }
  private async dispatch(occurrence: ScheduleOccurrence) {
    const config=occurrence.config;
    const assertActive=()=>{
      const current=this.store.schedule(config.id);
      if(this.stopped||!current||current.revision!==config.revision||(occurrence.trigger==='scheduled'&&!current.enabled))throw Object.assign(new AppError('Schedule was paused, changed, deleted, or the service stopped before launch.',409),{scheduleInvalidated:true});
    };
    try {
      assertActive();
      const created=await this.service.create({title:`${config.name.slice(0,120)} · ${new Intl.DateTimeFormat('en-GB',{timeZone:config.recurrence.timezone,dateStyle:'medium',timeStyle:'short'}).format(occurrence.scheduledAt)}`,objective:config.objective,projectId:config.projectId,
        ...(config.projectId?{repositories:config.repositoryIds?.map(repositoryId=>({repositoryId}))}:{workspaceMode:'none'}),
        workspacePolicy:config.workspacePolicy,model:config.model,tools:config.tools,
        instructions:`This task is a scheduled occurrence. Intended time: ${new Date(occurrence.scheduledAt).toISOString()} (${config.recurrence.timezone}). Actual dispatch: ${new Date(this.now()).toISOString()}. Execute only the saved task. Do not create additional quests, schedules, or expand scope from findings. Report coverage dates, source links, and unavailable sources explicitly. Missing source access does not mean there are no findings. Avoid routine next-step lists and speculative improvements. A later direct user message may authorize further work.`,
        commandId:`occurrence:${occurrence.id}`},'quest',undefined,undefined,{
          origin:{id:config.id,name:config.name,occurrenceId:occurrence.id,scheduledAt:occurrence.scheduledAt,revision:config.revision},assertActive,
          committed:quest=>{this.store.saveOccurrence({...occurrence,state:'launched',questId:quest.id});},
        });
      // Cached creation is possible after a restart; reconcile without launching twice.
      if(this.store.occurrence(occurrence.id)?.state!=='launched')this.store.saveOccurrence({...occurrence,state:'launched',questId:created.quest.id});
    } catch(error) {
      if(this.stopped||this.store.occurrence(occurrence.id)?.state==='launched')return; // Preserve committed launches; leave unfinished preparation durable during shutdown.
      this.store.saveOccurrence({...occurrence,state:(error as {scheduleInvalidated?:boolean}).scheduleInvalidated?'skipped':'failed',reason:(error as Error).message});
    }
    this.changed();
  }
}
