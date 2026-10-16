import React, { useEffect, useRef, useState } from 'react';
import type { Project, Quest } from '../domain/types';
import type { QuestSchedule, ScheduleConfig, ScheduleOccurrence } from '../domain/schedules';
import { nextOccurrence, recurrenceSummary } from '../domain/recurrence';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import Breadcrumbs from './Breadcrumbs';
import BoardControls from './BoardControls';
import useStoredTab from './useStoredTab';

type Occurrence = ScheduleOccurrence & {quest?: Quest; startedAt?: number};
type ScheduleView = QuestSchedule & {blockedBy?: Quest;preparing?: boolean;latest?: Occurrence};
type Request = <T>(path:string,body?:unknown)=>Promise<T>;
const dates=(value:number,zone?:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short',...(zone?{timeZone:zone}:{})});
const labels:Record<string,string>={queued:'Queued',running:'In progress',waiting:'Working with agents',awaiting_input:'Needs your input',awaiting_review:'Ready for review',accepted:'Accepted',interrupted:'Needs attention',failed:'Failed',cancelled:'Cancelled',completed:'Completed'};
const blank=():ScheduleConfig=>({name:'',objective:'',recurrence:{days:[1,2,3,4,5],time:'08:30',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},missed:'latest',projectId:null,workspacePolicy:'shared',tools:['read','grep','find','ls','bash'],model:''});
const morning='Prepare my Morning Brief.\n\nSlack channels: [add channel links or names]\nGitHub scope: [add repositories or organization and my username]\nCoverage period: [for example, the last 24 hours; include older unresolved items that still need my attention]\n\nSummarize important developments and PRs or issues I own or am assigned that need attention. Prioritize a small number of concrete items and explain why each matters. Include source links and state the coverage dates. Clearly identify unavailable sources. If nothing needs attention, say so. Do not create further quests or take action on findings.';

export default function Schedules({selectedId,onSelect,onQuest,projects,models,request}: {
  selectedId?:string;onSelect:(id?:string)=>void;onQuest:(id:string)=>void;projects:Project[];models:{id:string;name:string}[];request:Request;
}) {
  const [items,setItems]=useState<ScheduleView[]>([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[schedulerError,setSchedulerError]=useState('');
  const [search,setSearch]=useState(''),[projectFilter,setProjectFilter]=useState('all');
  const [editor,setEditor]=useState<{config:ScheduleConfig;revision?:number;id?:string}>();
  const [history,setHistory]=useState<Occurrence[]>([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0);
  const [busy,setBusy]=useState(false),[confirmDelete,setConfirmDelete]=useState<ScheduleView>();
  const [discard,setDiscard]=useState<{proceed:()=>void}>();
  const dirty=useRef(false),editing=useRef(false),loadVersion=useRef(0),requestVersion=useRef(0);
  editing.current=!!editor;
  const selected=items.find(item=>item.id===selectedId);
  const [tab,setTab]=useStoredTab(`guildmaster:schedule-tab:${selectedId??'list'}`,['overview','history'],'overview');
  useEffect(()=>{
    const handler=(event:Event)=>{
      if(!editing.current||!dirty.current)return;
      event.preventDefault();setDiscard({proceed:(event as CustomEvent<{proceed:()=>void}>).detail.proceed});
    };
    const unload=(event:BeforeUnloadEvent)=>{if(dirty.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('guildmaster:before-navigate',handler);window.addEventListener('beforeunload',unload);
    return()=>{window.removeEventListener('guildmaster:before-navigate',handler);window.removeEventListener('beforeunload',unload);};
  },[]);
  useEffect(()=>{
    const version=++loadVersion.current;let alive=true;
    setError('');setLoadError('');setLoaded(false);setEditor(undefined);setOffset(0);setHistory([]);setTotal(0);dirty.current=false;
    const load=async()=>{
      const requestId=++requestVersion.current;
      try {
        const result=await request<{schedules:ScheduleView[];schedulerError?:string}>('/api/schedules');
        if(!alive||version!==loadVersion.current||requestId!==requestVersion.current)return;
        setLoadError('');setItems(result.schedules);setSchedulerError(result.schedulerError??'');setLoaded(true);
      }catch(e){if(alive){setLoaded(true);setLoadError((e as {status?:number}).status===404?'Restart the local service after active quests finish to enable schedules.':(e as Error).message);}}
    };
    void load();const timer=setInterval(()=>void load(),3000);
    if(selectedId==='new')setEditor({config:blank()});
    else if(selectedId?.startsWith('draft:'))void request<{draft:ScheduleConfig}>(`/api/schedule-drafts/${encodeURIComponent(selectedId.slice(6))}`).then(({draft})=>{if(alive)setEditor({config:draft});}).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;clearInterval(timer);};
  },[selectedId,request]);
  useEffect(()=>{
    if(!selectedId||selectedId==='new'||selectedId.startsWith('draft:'))return;
    let alive=true;
    const load=()=>request<{items:Occurrence[];total:number}>(`/api/schedules/${encodeURIComponent(selectedId)}/history?offset=${offset}`).then(data=>{if(alive){setHistory(data.items);setTotal(data.total);}}).catch(e=>{if(alive)setError(e.message);});
    void load();const timer=setInterval(()=>void load(),3000);return()=>{alive=false;clearInterval(timer);};
  },[selectedId,offset,request]);
  const refresh=async()=>{const version=++requestVersion.current;const result=await request<{schedules:ScheduleView[]}>('/api/schedules');if(version===requestVersion.current)setItems(result.schedules);};
  async function action(schedule:ScheduleView,action:'pause'|'resume'|'run'|'delete') {
    setBusy(true);setError('');
    try{await request(`/api/schedules/${encodeURIComponent(schedule.id)}/${action}`,{revision:schedule.revision,commandId:crypto.randomUUID()});await refresh();if(action==='delete'&&selectedId===schedule.id)onSelect();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);setConfirmDelete(undefined);}
  }
  const closeEditor=()=>{
    const proceed=()=>{dirty.current=false;setEditor(undefined);if(!editor?.id)onSelect();};
    if(dirty.current)setDiscard({proceed});else proceed();
  };
  const controls=(schedule:ScheduleView, group:'all'|'primary'|'secondary'='all')=><>
    {group!=='secondary'&&<>
    <button className="button small" disabled={busy||!!schedule.blockedBy||schedule.preparing} onClick={()=>void action(schedule,'run')}>Run now</button>
    <button className="button small" disabled={busy} onClick={()=>{setEditor({config:structuredClone({name:schedule.name,objective:schedule.objective,recurrence:schedule.recurrence,missed:schedule.missed,projectId:schedule.projectId,repositoryIds:schedule.repositoryIds,workspacePolicy:schedule.workspacePolicy,model:schedule.model,tools:schedule.tools}),revision:schedule.revision,id:schedule.id});dirty.current=false;}}>Edit</button>
    </>}{group!=='primary'&&<>
    <button className="button small" disabled={busy} onClick={()=>void action(schedule,schedule.enabled?'pause':'resume')}>{schedule.enabled?'Pause':'Resume'}</button>
    <button className="button small quest-delete" disabled={busy} onClick={()=>setConfirmDelete(schedule)}>Delete</button>
    </>}
  </>;
  const visible=items.filter(s=>(projectFilter==='all'||(projectFilter==='unassigned'?!s.projectId:s.projectId===projectFilter))&&`${s.name} ${s.objective}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="schedules-page page-scroll">
    {discard&&<ConfirmDialog title="Discard unsaved changes?" description="Your schedule changes have not been saved." confirmLabel="Discard changes" cancelLabel="Keep editing" onClose={()=>setDiscard(undefined)} onConfirm={()=>{const proceed=discard.proceed;dirty.current=false;setDiscard(undefined);proceed();}}/>}
    {confirmDelete&&<ConfirmDialog title={`Delete “${confirmDelete.name}”?`} description={`Future runs will stop. Existing quests and their results will be kept.${confirmDelete.blockedBy?' Its existing quest will continue.':''}`} confirmLabel="Delete schedule" cancelLabel="Keep schedule" onClose={()=>setConfirmDelete(undefined)} onConfirm={()=>void action(confirmDelete,'delete')}/>}
    <div className="page-header-sticky schedule-sticky"><div className="schedule-heading page-heading">
      <div>{selectedId&&<Breadcrumbs current={editor?(editor.id?'Edit schedule':'Create schedule'):selected?.name??'Schedule'} items={[{label:'Schedules',onClick:()=>onSelect()}]}/>}<div className="schedule-title-line"><h1>{editor?(editor.id?'Edit schedule':'Create schedule'):selectedId?selected?.name??'Schedule':'Schedules'}</h1>{selected&&!editor&&<span className={`schedule-state ${selected.enabled?'enabled':''}`}>{selected.enabled?'Enabled':'Paused'}</span>}</div>{selected&&!editor&&<span className="schedule-header-timing" tabIndex={0} aria-describedby="schedule-timing-help">
        {recurrenceSummary(selected.recurrence).split(' · ').slice(0,2).join(' at ')}{selected.enabled&&` · Next ${new Date(selected.nextAt).toLocaleDateString(undefined,{timeZone:selected.recurrence.timezone,weekday:'long',day:'numeric',month:'long'})}`}
        <span className="schedule-timing-tooltip" id="schedule-timing-help" role="tooltip">{selected.recurrence.timezone}{selected.enabled?` · Next run: ${dates(selected.nextAt,selected.recurrence.timezone)}`:''}</span>
      </span>}</div>
      {!editor&&(selected?<div className="schedule-actions">{controls(selected,'primary')}<ScheduleMenu name={selected.name} header>{controls(selected,'secondary')}</ScheduleMenu></div>:!selectedId&&<div className="schedule-actions"><BoardControls search={search} onSearch={setSearch} projectFilter={projectFilter} onProjectFilter={setProjectFilter} projects={projects} searchLabel="Search schedules" searchPlaceholder="Find a schedule…" filterLabel="Filter schedules by project"/><button className="button small" onClick={()=>onSelect('new')}><Icon name="plus" size={16}/>Create schedule</button></div>)}
    </div>{selected&&!editor&&<div className="detail-tabs schedule-detail-tabs"><button className={tab==='overview'?'selected':''} aria-pressed={tab==='overview'} onClick={()=>setTab('overview')}><Icon name="document" size={15}/>Overview</button><button className={tab==='history'?'selected':''} aria-pressed={tab==='history'} onClick={()=>setTab('history')}><Icon name="clock" size={15}/>Run history<span>{total}</span></button></div>}</div>
    {(error||loadError)&&<div className="inline-error" role="alert">{error||loadError}</div>}{schedulerError&&<div className="inline-error" role="alert">Scheduling needs attention: {schedulerError}</div>}
    {editor?<ScheduleEditor key={`${editor.id??selectedId}:${editor.revision??0}`} initial={editor.config} allowStarter={!editor.id&&!selectedId?.startsWith('draft:')} projects={projects} models={models} busy={busy} onDirty={value=>{dirty.current=value;}} onCancel={closeEditor} onSave={async config=>{
      setBusy(true);setError('');try{const result=await request<{schedule:QuestSchedule}>(editor.id?`/api/schedules/${encodeURIComponent(editor.id)}`:'/api/schedules',{...config,revision:editor.revision,commandId:crypto.randomUUID()});dirty.current=false;setEditor(undefined);await refresh();onSelect(result.schedule.id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
    }}/>:!loaded?<div className="loading-state"><span className="spinner"/>Loading schedules…</div>:selected?<>
      {(selected.blockedBy||selected.preparing)&&<div className="schedule-run-notice" role="status">{selected.blockedBy?<><span>{selected.blockedBy.status==='interrupted'?'An interrupted occurrence needs attention.':'A previous occurrence is still active.'}</span><button className="text-button" onClick={()=>onQuest(selected.blockedBy!.id)}>Open quest</button></>:<><span className="spinner"/>Preparing a quest…</>}</div>}
      {tab==='overview'?<div className="schedule-overview">
        <section><h2>Instructions</h2><div className="schedule-instruction-panel"><div className="schedule-instructions">{selected.objective}</div></div></section>
        <section className="schedule-configuration"><h2>Configuration</h2><dl>
          <div><dt>Project</dt><dd>{selected.projectId?projects.find(p=>p.id===selected.projectId)?.name??'Unavailable project':'No project workspace'}</dd></div>
          <div><dt>Missed runs</dt><dd>{selected.missed==='latest'?'Run once when next available':'Skip missed runs'}</dd></div>
          <div><dt>Model</dt><dd>{models.find(m=>m.id===selected.model)?.name??(selected.model||'Default model')}</dd></div>
        </dl></section>
      </div>:<section className="schedule-history" aria-label="Run history">
        {history.length?history.map(o=><ScheduleHistoryEntry key={o.id} occurrence={o} onQuest={onQuest}/>):<div className="board-empty"><div className="empty-emblem"><Icon name="clock" size={30}/></div><h2>No runs yet</h2><p>Each occurrence will appear here with a link to its quest.</p></div>}
        {total>20&&<div className="schedule-pagination"><button className="button small" disabled={offset===0} onClick={()=>setOffset(v=>Math.max(0,v-20))}>Newer</button><span>{offset+1}–{Math.min(offset+20,total)} of {total}</span><button className="button small" disabled={offset+20>=total} onClick={()=>setOffset(v=>v+20)}>Older</button></div>}
      </section>}
    </>:selectedId?<div className="board-empty"><div className="empty-emblem"><Icon name="calendar" size={30}/></div><p>{selectedId.startsWith('draft:')?'Loading schedule draft…':'This schedule is no longer available. Its existing quests are kept.'}</p><button className="button" onClick={()=>onSelect()}>All schedules</button></div>:<>
      {visible.length?<div className="quest-grid schedule-list">{visible.map(s=><article className="quest-card schedule-card" key={s.id}>
        <button className="quest-card-open schedule-card-open" onClick={()=>onSelect(s.id)}>
          <div className="quest-card-top"><span className="quest-monogram"><Icon name="calendar" size={22}/></span><span className={`schedule-state ${s.enabled?'enabled':''}`}>{s.enabled?'Enabled':'Paused'}</span></div>
          <h2>{s.name}</h2><p>{s.objective}</p>
          <div className="quest-card-footer"><span className="schedule-card-recurrence"><Icon name="clock" size={14}/><span>{recurrenceSummary(s.recurrence)}</span></span><span className="quest-open-icon"><Icon name="right" size={15}/></span></div>
        </button><ScheduleMenu name={s.name}>{controls(s)}</ScheduleMenu></article>)}</div>:<div className="board-empty"><div className="empty-emblem"><Icon name="calendar" size={30}/></div><h2>{items.length?'No schedules match':'No schedules yet'}</h2><p>{items.length?'Try another filter or a different search.':'Set up recurring work, such as a morning briefing or weekly review.'}</p>{!items.length&&<button className="button primary" onClick={()=>onSelect('new')}>Create schedule</button>}</div>}
    <div className="board-footnote"><Icon name="clock" size={15}/><span>Schedules run while Guildmaster is running and your computer is awake.</span></div>
    </>}
  </div>;
}

function ScheduleMenu({name,header=false,children}: {name:string;header?:boolean;children:React.ReactNode}) {
  return <details className={`schedule-menu${header?' schedule-header-menu':''}`} onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onClick={e=>{if((e.target as HTMLElement).closest('button'))e.currentTarget.open=false;}}><summary aria-label={`Actions for ${name}`}><Icon name="more"/></summary><div>{children}</div></details>;
}

function ScheduleHistoryEntry({occurrence:o,onQuest}: {occurrence:Occurrence;onQuest:(id:string)=>void}) {
  const status=o.quest?.status??(o.state==='failed'?'failed':o.state==='preparing'?'queued':'cancelled');
  const label=o.quest?labels[o.quest.status]??o.quest.status:o.state==='launched'?'Quest deleted':o.state==='preparing'?'Preparing…':o.state==='failed'?'Launch failed':'Skipped';
  const content=<><div className="schedule-history-description"><strong>{o.quest?.title??dates(o.scheduledAt,o.config.recurrence.timezone)}</strong>
    <span>{o.quest?`${dates(o.scheduledAt,o.config.recurrence.timezone)} · `:''}{o.trigger==='manual'?'Manual run':'Scheduled run'}{o.startedAt?` · Started ${dates(o.startedAt,o.config.recurrence.timezone)}`:''}</span>{o.reason&&<p>{o.reason}</p>}
    </div><span className={`badge status-${status}`}><span className="status-dot"/>{label}</span>{o.quest&&<span className="quest-open-icon"><Icon name="right" size={15}/></span>}</>;
  return o.quest?<button className="schedule-history-row schedule-history-open" onClick={()=>onQuest(o.quest!.id)} aria-label={`Open ${o.quest.title}`}>{content}</button>:<div className="schedule-history-row">{content}</div>;
}

function ScheduleEditor({initial,allowStarter,projects,models,busy,onSave,onCancel,onDirty}: {
  initial:ScheduleConfig;allowStarter:boolean;projects:Project[];models:{id:string;name:string}[];
  busy:boolean;onSave:(value:ScheduleConfig)=>Promise<void>;onCancel:()=>void;onDirty:(dirty:boolean)=>void;
}) {
  const [value,setValue]=useState<ScheduleConfig>(()=>structuredClone(initial));
  const [frequency,setFrequency]=useState(()=>initial.recurrence.days.length===7?'daily':[...initial.recurrence.days].sort().join(',')==='1,2,3,4,5'?'weekdays':'custom');
  const [editingTimezone,setEditingTimezone]=useState(false);
  const update=(patch:Partial<ScheduleConfig>)=>{const next={...value,...patch};setValue(next);onDirty(JSON.stringify(next)!==JSON.stringify(initial));};
  const timezoneList=typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):[];
  let preview:number|undefined,previewError='';
  try{preview=nextOccurrence(value.recurrence,Date.now());}catch(e){previewError=(e as Error).message;}
  const selectedProject=projects.find(p=>p.id===value.projectId);
  const setRule=(patch:Partial<ScheduleConfig['recurrence']>)=>update({recurrence:{...value.recurrence,...patch}});
  return <form className="schedule-editor" onSubmit={e=>{e.preventDefault();if(!busy&&!previewError)void onSave(value);}}>
    <label className="field">Name<input aria-label="Name" required maxLength={160} value={value.name} onChange={e=>update({name:e.target.value})}/></label>
    <label className="field">Instructions<textarea aria-label="Instructions" required rows={6} maxLength={20000} value={value.objective} onChange={e=>update({objective:e.target.value})} placeholder="What should Guildmaster do each time? Include the sources to check and the result you want."/></label>
    {allowStarter&&!value.objective.trim()&&<p className="schedule-starter">Need a starting point? <button type="button" className="text-button" onClick={()=>update({name:value.name.trim()?value.name:'Morning Brief',objective:morning})}>Try a morning brief</button></p>}
    <div className="schedule-form-row schedule-timing-row">
      <label className="field">Repeat<select aria-label="Repeat" value={frequency} onChange={e=>{
        const next=e.target.value;setFrequency(next);
        if(next!=='custom')setRule({days:next==='daily'?[0,1,2,3,4,5,6]:[1,2,3,4,5]});
      }}><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="custom">Custom days</option></select></label>
      <label className="field">Time<input aria-label="Time" type="time" required value={value.recurrence.time} onChange={e=>setRule({time:e.target.value})}/></label>
    </div>
    {frequency==='custom'&&<fieldset className="schedule-days"><legend>Repeat on</legend>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index)=><label key={day}><input type="checkbox" checked={value.recurrence.days.includes(index)} onChange={e=>setRule({days:e.target.checked?[...value.recurrence.days,index].sort():value.recurrence.days.filter(d=>d!==index)})}/>{day.slice(0,3)}</label>)}</fieldset>}
    <div className="schedule-timezone">
      {editingTimezone?<><label className="field">Timezone<input aria-label="Timezone" autoFocus list="schedule-timezones" required value={value.recurrence.timezone} onChange={e=>setRule({timezone:e.target.value})}/><datalist id="schedule-timezones">{timezoneList.map(zone=><option value={zone} key={zone}/>)}</datalist></label><button type="button" className="text-button" disabled={!!previewError} onClick={()=>setEditingTimezone(false)}>Done</button></>:<><span>{value.recurrence.timezone}</span><button type="button" className="text-button" aria-label="Change timezone" onClick={()=>setEditingTimezone(true)}>Change</button></>}
    </div>
    <details className="schedule-advanced"><summary>Advanced</summary>
      <label className="field">If a run is missed<select aria-label="If a run is missed" value={value.missed} onChange={e=>update({missed:e.target.value as 'latest'|'skip'})}><option value="latest">Run once when next available</option><option value="skip">Skip missed runs</option></select><small>{value.missed==='latest'?'Run only the latest missed occurrence when Guildmaster becomes available.':'Skip occurrences that are more than one minute late.'}</small></label>
      <label className="field">Project<select aria-label="Project" value={value.projectId??''} onChange={e=>update({projectId:e.target.value||null,repositoryIds:undefined,workspacePolicy:e.target.value?'isolated':'shared'})}><option value="">No project workspace</option>{projects.filter(p=>!p.archivedAt||p.id===value.projectId).map(p=><option key={p.id} value={p.id}>{p.name}{p.archivedAt?' (archived)':''}</option>)}</select></label>
      {selectedProject&&<><fieldset className="schedule-repositories"><legend>Repositories</legend>{selectedProject.repositories.map(repo=><label key={repo.id}><input type="checkbox" checked={value.repositoryIds===undefined||value.repositoryIds.includes(repo.id)} onChange={e=>{const ids=value.repositoryIds??selectedProject.repositories.map(r=>r.id);const repositoryIds=e.target.checked?[...ids,repo.id]:ids.filter(id=>id!==repo.id);update({repositoryIds,...(!repositoryIds.length?{workspacePolicy:'shared' as const}:{})});}}/>{repo.name}</label>)}</fieldset><label className="field">Workspace<select aria-label="Workspace" value={value.workspacePolicy} onChange={e=>update({workspacePolicy:e.target.value as 'shared'|'isolated'})}><option value="isolated">Private checkout of committed source</option><option value="shared">Existing working files</option></select></label></>}
      <label className="field">Model<select aria-label="Model" value={value.model} onChange={e=>update({model:e.target.value})}><option value="">Use current default when saving</option>{value.model&&!models.some(m=>m.id===value.model)&&<option value={value.model}>{value.model} (unavailable)</option>}{models.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
      <fieldset><legend>Capabilities</legend>{['read','grep','find','ls','bash','edit','write'].map(tool=><label key={tool}><input type="checkbox" checked={value.tools.includes(tool)} onChange={e=>update({tools:e.target.checked?[...value.tools,tool]:value.tools.filter(t=>t!==tool)})}/>{tool==='bash'?'Run shell commands (including GitHub CLI)':tool}</label>)}</fieldset>
      <p>Shell commands can change files and external services. Task instructions define what this schedule may do.</p>
    </details>
    <div className="schedule-next-run" aria-live="polite">{previewError?<p role="alert">{previewError}</p>:<p>Next run: {dates(preview!,value.recurrence.timezone)}</p>}</div>
    <div className="schedule-editor-actions"><button type="submit" className="button primary" disabled={busy||!!previewError}>{busy?'Saving…':'Save schedule'}</button><button type="button" className="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
