import ModelSettings from './ModelSettings';
import StorageSettings from './StorageSettings';
import ConnectionsSettings from './ConnectionsSettings';
import useStoredTab from './useStoredTab';
import AppearanceSettings from './AppearanceSettings';
import ImageGenerationSettings from './ImageGenerationSettings';
import Icon from './Icon';
import React, { useCallback, useEffect, useRef, useState } from 'react';

type Provider = { id: string; name: string; configured: boolean; authMethods?: (string | { type?: string; id?: string; label?: string })[] };
type Configuration = { providers: Provider[]; models: { id: string; name: string; provider?: string }[]; defaultModel: string; providerError?: string; canImportPi: boolean };
type Login = { id: string; providerId: string; status: 'working' | 'waiting' | 'complete' | 'error' | 'cancelled'; prompt?: { type: 'text' | 'secret' | 'select' | 'manual_code'; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] }; url?: string; instructions?: string; userCode?: string; verificationUri?: string; error?: string };

async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/settings${path}`, body === undefined && method !== 'DELETE' ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status}).` }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const safeUrl = (value?: string) => value && /^https?:\/\//i.test(value) ? value : undefined;

export default function ProviderSettings({ onChanged, onStarted }: { onChanged: (model?: string) => Promise<void>; onStarted:()=>void }) {
  const [tab, setTab] = useStoredTab('guildmaster:settings-tab', ['providers', 'models', 'connections', 'images', 'appearance', 'storage'], 'providers');
  const [connecting, setConnecting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (connecting) dialog.current?.showModal(); }, [connecting]);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [login, setLogin] = useState<Login | null>(null);
  const [answer, setAnswer] = useState('');
  const [removeId, setRemoveId] = useState('');
  const completed = useRef('');
  const activeLoginId = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await request<Configuration>('');
    setConfig(next);
    if(next.models.length){const {defaults}=await request<{defaults:{guildmaster:{model:string}}}>('/models');if(!defaults.guildmaster.model)setTab('models');}
    setSelected(previous => previous || next.providers.find(p => !p.configured)?.id || next.providers[0]?.id || '');
    return next;
  }, []);
  useEffect(() => { void refresh().catch(err => setError(err.message)); }, [refresh]);
  useEffect(() => {
    if (!login || !['working', 'waiting'].includes(login.status)) return;
    let active = true;
    const timer = setInterval(() => {
      void request<Login>(`/login/${encodeURIComponent(login.id)}`).then(async next => {
        if (!active) return;
        setLogin(next);
        if (next.status === 'complete' && completed.current !== next.id) {
          completed.current = next.id; activeLoginId.current = null;
          const result = await refresh(); await onChanged(result.defaultModel); setNotice('Provider connected. Your available models are ready.'); setConnecting(false); setLogin(null);
        }
      }).catch(err => { if (active) { setError(err.message); setLogin(old => old ? { ...old, status: 'error', error: err.message } : null); } });
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [login?.id, login?.status, refresh, onChanged]);
  useEffect(() => { setAnswer(''); }, [login?.prompt?.message, login?.prompt?.type]);
  useEffect(() => () => { if (activeLoginId.current) void request(`/login/${encodeURIComponent(activeLoginId.current)}`, undefined, 'DELETE').catch(() => {}); }, []);

  async function perform(name: string, action: () => Promise<void>) { if (busy) return; setBusy(name); setError(''); setNotice(''); try { await action(); } catch (err) { setError((err as Error).message); } finally { setBusy(''); } }
  const provider = config?.providers.find(p => p.id === selected);
  const authMethods = provider?.authMethods?.map(method => typeof method === 'string' ? method : method.type || method.id || '') || [];
  const hasOAuth = authMethods.some(method => method.toLowerCase().includes('oauth'));
  const hasKey = !provider?.authMethods || authMethods.some(method => /api|key/i.test(method));
  const loginActive = !!login && ['working', 'waiting'].includes(login.status);
  const loginUrl = safeUrl(login?.url) || safeUrl(login?.verificationUri);

  const closeConnection = () => {
    if (busy) return;
    void perform('close', async () => {
      if (activeLoginId.current) await request(`/login/${encodeURIComponent(activeLoginId.current)}`, undefined, 'DELETE');
      activeLoginId.current = null; setConnecting(false); setLogin(null); setApiKey(''); setAnswer('');
    });
  };
  const openConnection = () => {
    setSelected(config?.providers.find(provider => !provider.configured)?.id || config?.providers[0]?.id || '');
    setApiKey(''); setLogin(null); setError(''); setNotice(''); setConnecting(true);
  };
  return <div className="settings-page providers-settings page-scroll">
    <div className="page-header-sticky">
    <div className="page-heading"><div><h1>Settings</h1></div></div>
    <div className="detail-tabs settings-tabs" aria-label="Settings views">
      <button className={tab === 'providers' ? 'selected' : ''} aria-pressed={tab === 'providers'} onClick={() => setTab('providers')}><Icon name="providers" size={15}/>Providers</button>
      <button className={tab === 'models' ? 'selected' : ''} aria-pressed={tab === 'models'} onClick={() => setTab('models')}><Icon name="brain" size={15}/>Models</button>
      <button className={tab === 'connections' ? 'selected' : ''} aria-pressed={tab === 'connections'} onClick={() => setTab('connections')}><Icon name="connections" size={15}/>Connections</button>
      <button className={tab === 'images' ? 'selected' : ''} aria-pressed={tab === 'images'} onClick={() => setTab('images')}><Icon name="image" size={15}/>Images</button>
      <button className={tab === 'appearance' ? 'selected' : ''} aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}><Icon name="palette" size={15}/>Appearance</button>
      <button className={tab === 'storage' ? 'selected' : ''} aria-pressed={tab === 'storage'} onClick={() => setTab('storage')}><Icon name="archive" size={15}/>Storage</button>
    </div>
    </div>
    {tab === 'models' && <ModelSettings onChanged={() => onChanged()} onConnect={()=>{setTab('providers');openConnection();}} onStarted={onStarted}/>}
    {tab === 'storage' && <StorageSettings onChanged={() => onChanged()}/>}
    {tab === 'connections' && <ConnectionsSettings/>}
    {tab === 'images' && <ImageGenerationSettings/>}
    <div hidden={tab !== 'appearance'}><AppearanceSettings/></div>
    <div hidden={tab !== 'providers'}>
    {error && !connecting && <div className="inline-error" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">✓ {notice}</div>}
    {!config ? <div className="loading-state">{error ? <button className="button" onClick={() => void perform('refresh', async () => { await refresh(); })}>Retry loading settings</button> : <><span className="spinner"/> Loading provider settings…</>}</div> : <>
    {config.providerError && <div className="inline-error">{config.providerError}</div>}
    <section className="settings-section"><div className="settings-section-title"><div><h2>Connected providers</h2><p>Your accounts and API connections for running agents.</p></div><button className="button small" disabled={!!busy || !config.providers.length} onClick={openConnection}><Icon name="plus" size={15}/>Add provider</button></div>
      <div className="provider-list">{config.providers.filter(p => p.configured).map(p => <div className="provider-row" key={p.id}><span className="provider-symbol"><Icon name="spark" size={20}/></span><div><strong>{p.name}</strong><small>{config.models.filter(model => model.provider === p.id).length} models available</small></div>{removeId === p.id ? <div className="remove-confirm"><span>Remove connection?</span><button className="button small" disabled={!!busy} onClick={() => setRemoveId('')}>Keep</button><button className="button small" disabled={!!busy} onClick={() => void perform(`remove-${p.id}`, async () => { await request(`/provider/${encodeURIComponent(p.id)}`, undefined, 'DELETE'); setRemoveId(''); const next = await refresh(); await onChanged(next.defaultModel); setNotice(`${p.name} disconnected.`); })}>Remove</button></div> : <button className="button small" disabled={!!busy} onClick={() => setRemoveId(p.id)}>Disconnect</button>}</div>)}</div>
      {!config.providers.some(provider => provider.configured) && <div className="providers-empty"><Icon name="spark" size={28}/><h3>No providers connected</h3><p>Add an account or API key to start working with Guildmaster.</p></div>}
      {connecting && <dialog className="provider-dialog" ref={dialog} aria-labelledby="connect-provider-title" onCancel={event => { event.preventDefault(); closeConnection(); }}>
        <div className="provider-dialog-heading"><h2 id="connect-provider-title">Add provider</h2><button className="icon-button" aria-label="Close provider connection" disabled={!!busy} onClick={closeConnection}><Icon name="close" size={18}/></button></div>
        {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="provider-connect"><label className="field">Provider<select autoFocus disabled={!!busy || loginActive} value={selected} onChange={e => { setSelected(e.target.value); setApiKey(''); setLogin(null); setError(''); }}><option value="" disabled>Select a provider</option>{config.providers.map(p => <option key={p.id} value={p.id}>{p.name}{p.configured ? ' · connected' : ''}</option>)}</select></label>
        {hasOAuth && !loginActive && <div className="oauth-option"><button className="button primary" disabled={!!busy || !selected} onClick={() => void perform('login', async () => { const state = await request<Login>('/login', { providerId: selected, authType: 'oauth' }); activeLoginId.current = state.id; setLogin(state); if (state.status === 'complete') { activeLoginId.current = null; const next = await refresh(); await onChanged(next.defaultModel); setNotice('Provider connected.'); setConnecting(false); setLogin(null); } })}>{busy === 'login' ? 'Starting sign-in…' : `Sign in with ${provider?.name || 'provider'}`}<span aria-hidden="true">↗</span></button><p>Use your provider’s browser sign-in. Follow any steps below to finish connecting.</p></div>}
        {login && <div className={`oauth-progress ${login.status === 'error' ? 'has-error' : ''}`}><div className="oauth-heading"><strong>{login.status === 'complete' ? 'Provider connected' : login.status === 'error' ? 'Connection could not finish' : login.status === 'cancelled' ? 'Sign-in cancelled' : 'Finish connecting your provider'}</strong>{loginActive && <span className="spinner"/>}</div>{login.instructions && <p>{login.instructions}</p>}{login.userCode && <div className="device-code"><span>Enter this code at your provider</span><code>{login.userCode}</code></div>}{loginUrl && loginActive && <a className="button" href={loginUrl} target="_blank" rel="noreferrer">Open provider sign-in ↗</a>}{login.prompt && loginActive && <form className="oauth-prompt" onSubmit={e => { e.preventDefault(); void perform('answer', async () => { const state = await request<Login>(`/login/${encodeURIComponent(login.id)}`, { value: answer }); setAnswer(''); setLogin(state); if (state.status === 'complete') { activeLoginId.current = null; const next = await refresh(); await onChanged(next.defaultModel); setNotice('Provider connected.'); setConnecting(false); setLogin(null); } }); }}><label className="field">{login.prompt.message}{login.prompt.type === 'select' ? <select value={answer} required onChange={e => setAnswer(e.target.value)}><option value="" disabled>Choose an option</option>{login.prompt.options?.map(option => <option value={option.id} key={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <input type={login.prompt.type === 'secret' ? 'password' : 'text'} placeholder={login.prompt.placeholder} value={answer} onChange={e => setAnswer(e.target.value)} required autoComplete="off" spellCheck={false}/>}</label><button className="button primary small" disabled={!!busy || !answer.trim()}>{busy === 'answer' ? 'Sending…' : 'Continue'}</button></form>}{login.error && <p className="oauth-error">{login.error}</p>}{loginActive && <button className="text-button" disabled={!!busy} onClick={() => void perform('cancel-login', async () => { await request(`/login/${encodeURIComponent(login.id)}`, undefined, 'DELETE'); activeLoginId.current = null; setLogin({ ...login, status: 'cancelled' }); setAnswer(''); })}>Cancel sign-in</button>}</div>}
        {!hasKey && !hasOAuth && <p>This provider does not expose a connection method in this version.</p>}{hasKey && !loginActive && <form className="api-key-form" onSubmit={e => { e.preventDefault(); void perform('key', async () => { await request('/provider', { providerId: selected, apiKey }); setApiKey(''); const next = await refresh(); await onChanged(next.defaultModel); setNotice(`${provider?.name || 'Provider'} connected.`); setConnecting(false); setLogin(null); }); }}><label className="field">{hasOAuth ? 'Or connect with an API key' : 'API key'}<input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Paste your provider API key" required autoComplete="off" spellCheck={false}/><small>Stored by the local service. Never saved in browser storage or shown after saving.</small></label><button className="button primary" disabled={!!busy || !selected || !apiKey.trim()}>{busy === 'key' ? 'Saving…' : 'Save API key'}</button></form>}
      </div>
      </dialog>}
    </section>

    {config.canImportPi && <section className="settings-section import-settings"><div><h2>Already using Pi?</h2><p>You can optionally import your existing provider credentials. Guildmaster keeps its own copy from then on.</p></div><button className="button" disabled={!!busy || loginActive} onClick={() => void perform('import', async () => { await request('/import-pi', {}); const next = await refresh(); await onChanged(next.defaultModel); setNotice('Existing Pi provider configuration imported.'); })}>{busy === 'import' ? 'Importing…' : 'Import Pi configuration'}</button></section>}
  </>}</div></div>;
}
