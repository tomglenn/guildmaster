import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionLogin, ConnectionView } from '../connections/types';
import type { ImportCandidate } from '../connections/import-pi';
import ConfirmDialog from './ConfirmDialog';
import Icon from './Icon';

async function request<T>(path='',body?:unknown,method=body?'POST':'GET'):Promise<T> {
  const response=await fetch('/api/settings/connections'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value=await response.json();if(!response.ok)throw new Error(value.error || 'The connection request failed.');return value;
}
export default function ConnectionsSettings() {
  const [view,setView]=useState<ConnectionView|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false),[setup,setSetup]=useState(false);
  const [login,setLogin]=useState<ConnectionLogin|null>(null),[disconnect,setDisconnect]=useState(false);
  const [preview,setPreview]=useState<{candidates:ImportCandidate[];warnings:string[]}|null>(null),[candidateId,setCandidateId]=useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  const signInWindow=useRef<Window|null>(null);
  const closeSignInWindow=()=>{const popup=signInWindow.current;signInWindow.current=null;try{popup?.close();}catch{/* Provider browser policy can prevent closing its tab. */}};
  const refresh=useCallback(async()=>{const next=await request<ConnectionView>();setView(next);if(next.login){setLogin(next.login);setSetup(true);}return next;},[]);
  useEffect(()=>{void refresh().catch(err=>setError(err.message));},[refresh]);
  useEffect(()=>{if(setup)dialog.current?.showModal();},[setup]);
  useEffect(()=>{
    if(!login||!['waiting','working'].includes(login.status))return;
    let active=true;
    const timer=setInterval(()=>{void request<ConnectionLogin>(`/login/${login.id}`).then(async next=>{
      if(!active)return;
      if(next.status==='complete'){
        await refresh();if(!active)return;signInWindow.current=null;setSetup(false);setNotice('Slack connected. Available on your next message or resumed quest.');
      }
      if(next.status==='cancelled'){closeSignInWindow();setSetup(false);setLogin(null);setError('');return;}
      setLogin(next);
      if(next.status==='error')setError(next.error || 'Slack could not be connected.');
    }).catch(err=>{if(active)setError(err.message);});},1000);
    return ()=>{active=false;clearInterval(timer);};
  },[login?.id,login?.status,refresh]);
  const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(err){setError(err instanceof Error?err.message:'The connection request failed.');}finally{setBusy(false);}};
  const activeLogin=login && ['waiting','working'].includes(login.status);
  const close=()=>{
    if(busy)return;
    void perform(async()=>{
      if(activeLogin)await request(`/login/${login!.id}`,undefined,'DELETE');
      closeSignInWindow();setSetup(false);setLogin(null);setError('');
    });
  };
  const begin=async(popup?:Window|null)=>{
    try {
      const next=await request<ConnectionLogin>('/login',{});setLogin(next);
      if(popup&&!popup.closed&&next.url?.startsWith('https://slack.com/oauth/'))popup.location.replace(next.url);
    }catch(error){closeSignInWindow();throw error;}
  };
  const startBrowserSignIn=(before?:()=>Promise<void>)=>{
    // Open synchronously during the click, before awaiting the service, to avoid popup blocking.
    const popup=window.open('about:blank','_blank');
    if(popup){popup.opener=null;popup.document.title='Connect Slack';}
    signInWindow.current=popup;
    void perform(async()=>{try{await before?.();await begin(popup);}catch(error){closeSignInWindow();throw error;}});
  };
  const open=()=>{setError('');setPreview(null);setCandidateId('');setLogin(null);setSetup(true);};
  const row=view?.connection;
  const selected=preview?.candidates.find(c=>c.id===candidateId);
  const consentNote=<p className="connection-consent-note">This connection currently uses the Claude Slack app. Slack will show “Claude” on its consent screen.</p>;
  return <div className="connections-settings">
    {error&&!setup&&<div className="inline-error" role="alert">{error}</div>}
    <section className="settings-section"><div className="settings-section-title"><div><h2>Connected services</h2><p>Bring context from your other tools into conversations and quests.</p></div>{!row?.enabled&&<button className="button small" disabled={busy||!view} onClick={open}><Icon name="plus" size={15}/>Add connection</button>}</div>
      {!view?<div className="loading-state">{error?<button className="button" onClick={()=>void perform(async()=>{await refresh();})}>Retry</button>:<><span className="spinner"/>Loading connections…</>}</div>:!row?.enabled?<div className="providers-empty"><Icon name="connections" size={28}/><h3>No services connected</h3><p>Add a connection to bring context into your work.</p></div>:<div className="connection-service-card">
        <div className="connection-service-heading"><span className="provider-symbol"><Icon name="chat" size={22}/></span><div><h3>Slack</h3><span className={row?.enabled&&row.status==='connected'?'connection-status connected':'connection-status'}><span className={`connection-dot ${row?.status==='sign_in_required'?'connecting':!row?.enabled?'offline':''}`}/>{row?.enabled?(row.status==='sign_in_required'?'Sign-in required':`Connected to ${row.teamName || 'Slack'}`):'Not connected'}</span></div><div className="connection-service-actions">{row?.enabled?<><button className="button small" disabled={busy} onClick={()=>{open();startBrowserSignIn();}}>Reconnect</button><button className="button small" disabled={busy} onClick={()=>setDisconnect(true)}>Disconnect</button></>:<button className="button small" onClick={open} disabled={busy}>Connect Slack</button>}</div></div>
        <p>Read threads and search messages available to your account. Guildmaster and quest agents can use this connection.</p>
        <small>{row?.enabled&&row.userName?`Signed in as ${row.userName}. `:''}Read-only access. No posting or changes to Slack.</small>
        {view.usesClaudeApp&&consentNote}
        {notice&&<div className="connection-service-feedback" role="status"><Icon name="check" size={14}/>{notice}</div>}
      </div>}
    </section>
    <section className="settings-section import-settings"><div><h2>Already using Pi?</h2><p>Import supported connection settings, then sign in with Guildmaster. Your existing connections stay independent.</p></div><button className="button" disabled={busy||!!row?.enabled} title={row?.enabled?'Disconnect Slack before importing replacement settings.':undefined} onClick={()=>void perform(async()=>{const result=await request<{candidates:ImportCandidate[];warnings:string[]}>('/import-pi');setPreview(result);setCandidateId('');setLogin(null);setSetup(true);})}>Import connection settings</button></section>
    {setup&&<dialog className="provider-dialog slack-dialog" ref={dialog} aria-labelledby="slack-connect-title" onCancel={event=>{event.preventDefault();close();}}><div className="provider-dialog-heading"><h2 id="slack-connect-title">{preview?'Import connection settings':row?.enabled?'Reconnect Slack':'Add connection'}</h2><button className="icon-button" disabled={busy} aria-label="Close Slack connection" onClick={close}><Icon name="close" size={18}/></button></div>
      {error&&<div className="inline-error" role="alert">{error}</div>}
      {preview&&<div className="slack-import-preview"><p>Only supported settings and tool restrictions are imported. Sign in separately to keep credentials independent.</p>{preview.warnings.map(w=><p key={w} className="inline-error">{w}</p>)}{!preview.candidates.length?<p>No supported Slack settings were found.</p>:preview.candidates.map(c=><label className="connection-import-choice" key={c.id}><input type="radio" name="slack-import" checked={candidateId===c.id} onChange={()=>setCandidateId(c.id)}/><span><strong>{c.name}</strong><small>{c.source}</small></span></label>)}</div>}
      {!preview&&!login&&<div className="connection-choice"><span className="provider-symbol"><Icon name="chat" size={20}/></span><div><strong>Slack</strong><p>Read threads and search messages.</p></div><button className="button primary small" disabled={busy} onClick={()=>startBrowserSignIn()}>{busy?'Preparing…':row?.enabled?'Reconnect':'Connect Slack'}</button></div>}
      {(preview?selected?.usesClaudeApp:view?.usesClaudeApp)&&consentNote}
      {!activeLogin&&(!!preview||!!login)&&<form onSubmit={event=>{event.preventDefault();startBrowserSignIn(async()=>{
        if(preview){await request('/import-pi',{candidateId});await refresh();setPreview(null);setCandidateId('');}
      });}}>
        <p className="connection-setup-description">{preview?'Import the selected settings, then sign in to Slack.':'Choose your Slack account and workspace in the browser. Your workspace may require administrator approval.'}</p>
        <button className="button primary" disabled={busy||!!preview&&!candidateId}>{busy?'Preparing sign-in…':preview?'Import and sign in':'Try sign-in again'}</button>
      </form>}
      {login&&['waiting','working'].includes(login.status)&&<div className="oauth-progress"><p role="status">{login.status==='waiting'?'Complete sign-in in the Slack window.':login.status==='working'?'Connecting Slack…':login.status==='cancelled'?'Sign-in cancelled.':login.status==='error'?'Sign-in did not complete. Check the error above.':''}</p>{login.status==='waiting'&&login.url?.startsWith('https://slack.com/oauth/')&&<a className="text-button" href={login.url} target="_blank" rel="noreferrer">Open Slack sign-in ↗</a>}{activeLogin&&<button className="text-button" onClick={close}>Cancel sign-in</button>}</div>}
    </dialog>}
    {disconnect&&<ConfirmDialog title="Disconnect Slack?" description="Guildmaster and quest agents will lose Slack access. Your conversations and quests stay saved." confirmLabel="Disconnect" cancelLabel="Keep connected" onClose={()=>setDisconnect(false)} onConfirm={()=>{setDisconnect(false);void perform(async()=>{try{await request('/slack',undefined,'DELETE');setNotice('Slack disconnected.');}finally{await refresh();}});}}/>}
  </div>;
}
