import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import Icon from './Icon';
type View={retentionDays:number|null;archivedQuests:number;lastCleanupAt?:number;lastDeleted?:number;lastError?:string};
async function request(days?:number|null):Promise<View> {
  const response=await fetch('/api/settings/storage',days===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({retentionDays:days})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Could not save storage settings.');return data;
}
export default function StorageSettings({onChanged}:{onChanged:()=>Promise<void>}) {
  const [view,setView]=useState<View>();const [choice,setChoice]=useState('off');const [days,setDays]=useState('90');
  const [error,setError]=useState('');const [saved,setSaved]=useState(false);const [busy,setBusy]=useState(false);const [confirm,setConfirm]=useState(false);
  const load=(value:View)=>{setView(value);setChoice(value.retentionDays===null?'off':[30,60,90].includes(value.retentionDays)?String(value.retentionDays):'custom');if(value.retentionDays!==null)setDays(String(value.retentionDays));};
  useEffect(()=>{let active=true;void request().then(value=>{if(active)load(value);}).catch(cause=>{if(active)setError(cause.message);});return()=>{active=false;};},[]);
  useEffect(()=>{if(view?.retentionDays==null)return;let active=true;const timer=setInterval(()=>{void request().then(value=>{if(active)setView(value);}).catch(()=>{});},5000);return()=>{active=false;clearInterval(timer);};},[view?.retentionDays]);
  const retention=choice==='off'?null:Number(choice==='custom'?days:choice);
  const valid=retention===null||Number.isInteger(retention)&&retention>=1&&retention<=3650;
  async function save() {setConfirm(false);setBusy(true);setError('');setSaved(false);try{load(await request(retention));await onChanged();setSaved(true);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  return <section className="settings-section storage-settings">
    <div className="settings-section-title"><div><h2>Archived quests</h2><p>Keep archived work until you delete it, or remove it automatically after a set time.</p></div></div>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {!view?<p>Loading storage settings…</p>:<>
      <p className="storage-count">{view.archivedQuests} archived {view.archivedQuests===1?'quest':'quests'}</p>
      <form onSubmit={event=>{event.preventDefault();if(retention!==null)setConfirm(true);else void save();}}>
        <label className="field">Automatically delete archived quests<select disabled={busy} value={choice} onChange={event=>{setChoice(event.target.value);setSaved(false);}}><option value="off">Off — keep until I delete them</option><option value="30">After 30 days</option><option value="60">After 60 days</option><option value="90">After 90 days</option><option value="custom">Custom period</option></select></label>
        {choice==='custom'&&<label className="field">Days since archiving<input type="number" min="1" max="3650" step="1" required disabled={busy} value={days} onChange={event=>{setDays(event.target.value);setSaved(false);}}/></label>}
        <p className="storage-explanation">Deletion removes quest and agent conversations, activity, and Guildmaster-owned workspaces. Source repositories and published work are kept. Deletion cannot be undone.</p>
        <p className="storage-explanation">Age is counted from when you archive a quest. Cleanup runs when Guildmaster starts and every hour while it is running. Restoring a quest excludes it from cleanup.</p>
        <div className="settings-save-actions"><button className="button" disabled={busy||!valid||retention===view.retentionDays}>{busy?'Saving…':'Save storage settings'}</button>{saved&&<span className="settings-saved" role="status"><Icon name="check" size={14}/>Saved</span>}</div>
      </form>
      {view.retentionDays!==null&&view.lastError&&<div className="inline-error" role="status">{view.lastError}</div>}
      {view.lastCleanupAt&&<p className="storage-last-cleanup">Last cleanup: {new Date(view.lastCleanupAt).toLocaleString()}{view.lastDeleted?` · ${view.lastDeleted} deleted`:''}</p>}
    </>}
    {confirm&&<ConfirmDialog intent="danger" title="Enable permanent deletion?" description={`Archived quests will be permanently deleted ${retention} days after archiving. Quests already older than this will start being deleted in the background now. This includes agent conversations and Guildmaster-owned workspaces. Source repositories and published work are kept. This cannot be undone.`} confirmLabel="Enable automatic deletion" cancelLabel="Keep current setting" onClose={()=>setConfirm(false)} onConfirm={()=>void save()}/>}
  </section>;
}
