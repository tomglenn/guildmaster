import ModelPicker from './ModelPicker';
import React, { useEffect, useState } from 'react';
import type { ModelDefaults, ModelInfo, ModelSelection, ModelPreference } from '../domain/model-defaults';

type View={defaults:ModelDefaults;models:ModelInfo[]};
async function request(body?: unknown):Promise<View> {
  const response=await fetch('/api/settings/models',body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error || 'Could not save model settings.');return data;
}
export default function ModelSettings({onChanged}:{onChanged:()=>Promise<void>}) {
  const [view,setView]=useState<View>();const [draft,setDraft]=useState<ModelDefaults>();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
  useEffect(()=>{let alive=true;void request().then(v=>{if(alive){setView(v);setDraft(v.defaults);}}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false;};},[]);
  const update=(role:'guildmaster'|'quest'|'delegate'|ModelPreference,selection:ModelSelection|undefined)=>{
    setDraft(old=>old ? (['guildmaster','quest','delegate'].includes(role) ? {...old,[role]:selection} : {...old,specialists:{...old.specialists,[role]:selection}}) : old);setSaved(false);
  };
  const row=(role:'guildmaster'|'quest'|'delegate'|ModelPreference,title:string,description:string,specialist=false)=>{
    const selection=specialist?draft!.specialists[role as ModelPreference]:draft![role as 'guildmaster'|'quest'|'delegate'];
    const model=view!.models.find(m=>m.id===selection?.model);
    return <div className="model-default-row" key={role}><div><strong>{title}</strong><p>{description}</p></div>
      <div className="field model-choice"><span className="model-mobile-label">Model</span><ModelPicker models={view!.models} value={selection?.model ?? ''} label={title} variant="settings" disabled={busy} emptyOption={specialist?'Use Subagents default':undefined} note="Choose a model, then save your changes below." onChange={model=>update(role,model?{model,reasoning:selection?.reasoning ?? null}:undefined)}/></div>
      <label className="field"><span className="model-mobile-label">Thinking</span><select aria-label={`${title} thinking`} disabled={!selection} value={selection?.reasoning ?? ''} onChange={e=>selection&&update(role,{...selection,reasoning:e.target.value||null})}>
        <option value="">{selection?'Provider default':'Use Subagents default'}</option>
        {selection?.reasoning&&!model?.reasoningLevels?.includes(selection.reasoning)&&<option value={selection.reasoning}>{selection.reasoning} (unsupported)</option>}
        {model?.reasoningLevels?.map(level=><option key={level} value={level}>{level[0].toUpperCase()+level.slice(1)}</option>)}
      </select></label></div>;
  };
  return <section className="settings-section model-settings"><div className="settings-section-title"><div><h2>Models</h2><p>Choose who handles your conversations and delegated work.</p></div></div>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {!draft||!view?(!error&&<p>Loading model settings…</p>):<form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');setSaved(false);try{const result=await request({...draft,commandId:crypto.randomUUID()});setDraft(result.defaults);setView({...view,defaults:result.defaults});await onChanged();setSaved(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
      <fieldset disabled={busy} className="model-default-fields">
      <div className="model-column-headings" aria-hidden="true"><span>Agent</span><span>Model</span><span>Thinking</span></div>
      {row('guildmaster','Guildmaster','Your conversations and new chats.')}
      {row('quest','Quest leads','Plans and manages each new quest.')}
      {row('delegate','Subagents','Work delegated by a quest lead.')}
      <details className="model-specialists"><summary>Work-specific models <span>Optional</span></summary><p>Use the Subagents default, or choose a different model for these assignments.</p>
        {row('coding','Coding','Implementation, debugging, and tests.',true)}
        {row('writing','Writing & output','Documents, reports, and deliverables.',true)}
        {row('review','Adversarial review','Independent challenges to work. Ordinary reviews can stay with the lead.',true)}
      </details></fieldset>
      <div className="settings-save-actions"><button className="button" disabled={busy||JSON.stringify(draft)===JSON.stringify(view.defaults)}>{busy?'Saving…':'Save model defaults'}</button>{saved&&<span className="settings-saved" role="status">Saved</span>}</div>
    </form>}
  </section>;
}
