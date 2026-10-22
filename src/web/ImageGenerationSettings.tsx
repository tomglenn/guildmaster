import React, { useEffect, useState } from 'react';

export type ImageSettings = {
  enabled: boolean; mock: boolean; model: string; configured: boolean;
  defaultQuality: 'auto' | 'low' | 'medium' | 'high';
  defaultSize: 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
};
export type ImageSettingsUpdate = Omit<ImageSettings, 'configured'> & { apiKey?: string };

async function request(body?: ImageSettingsUpdate): Promise<ImageSettings> {
  const response = await fetch('/api/settings/images', body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await response.json().catch(() => ({}));
  // Never reflect a failed credential submission back into the UI.
  if (!response.ok) throw new Error(`Image settings could not be ${body ? 'saved' : 'loaded'} (${response.status}).`);
  return {
    enabled: data.enabled === true, mock: data.mock !== false, model: data.model || 'gpt-image-1.5', configured: data.configured === true,
    defaultQuality: data.defaultQuality ?? 'auto', defaultSize: data.defaultSize ?? 'auto',
  };
}

export function ImageGenerationSettingsForm({ settings, busy, onSave }: {
  settings: ImageSettings; busy: boolean; onSave: (body: ImageSettingsUpdate) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [mock, setMock] = useState(settings.mock);
  const [model, setModel] = useState(settings.model);
  const [defaultQuality, setDefaultQuality] = useState(settings.defaultQuality);
  const [defaultSize, setDefaultSize] = useState(settings.defaultSize);
  const [apiKey, setApiKey] = useState('');
  const [paidConsent, setPaidConsent] = useState(false);
  const enteringLive = enabled && !mock && (!settings.enabled || settings.mock);
  const needsKey = enabled && !mock && !settings.configured && !apiKey.trim();
  return <form className="image-generation-form" onSubmit={event => {
    event.preventDefault();
    if (busy || needsKey || (enteringLive && !paidConsent)) return;
    const body: ImageSettingsUpdate = { enabled, mock, model, defaultQuality, defaultSize };
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    setApiKey('');
    void onSave(body);
  }}>
    <label className="image-settings-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)}/><span>Enable image generation</span></label>
    <label className="field">Mode<select value={mock ? 'mock' : 'live'} disabled={busy} onChange={event => { setMock(event.target.value === 'mock'); setPaidConsent(false); }}><option value="mock">Mock · test placeholders (no paid API calls)</option><option value="live">Live · paid OpenAI image API</option></select></label>
    <label className="field">Image model<select value={model} disabled={busy} onChange={event => setModel(event.target.value)}><option value="gpt-image-1.5">gpt-image-1.5 (default)</option><option value="gpt-image-1">gpt-image-1</option><option value="gpt-image-1-mini">gpt-image-1-mini</option></select></label>
    <label className="field">Default quality<select value={defaultQuality} disabled={busy} onChange={event => setDefaultQuality(event.target.value as ImageSettings['defaultQuality'])}><option value="auto">Auto (default)</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
    <label className="field">Default size<select value={defaultSize} disabled={busy} onChange={event => setDefaultSize(event.target.value as ImageSettings['defaultSize'])}><option value="auto">Auto (default)</option><option value="1024x1024">1024 × 1024 · square</option><option value="1536x1024">1536 × 1024 · landscape</option><option value="1024x1536">1024 × 1536 · portrait</option></select><small>Your request can override these defaults.</small></label>
    <label className="field">OpenAI image API key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} placeholder={settings.configured ? 'Key saved · enter a replacement only' : 'Paste your OpenAI API key'} onChange={event => setApiKey(event.target.value)}/></label>
    {enteringLive && <label className="image-settings-check"><input type="checkbox" checked={paidConsent} disabled={busy} onChange={event => setPaidConsent(event.target.checked)}/><span>I authorize paid OpenAI image requests.</span></label>}
    <div className="settings-save-actions"><button className="button" disabled={busy || !!needsKey || (enteringLive && !paidConsent)}>{busy ? 'Saving…' : 'Save image settings'}</button></div>
  </form>;
}

export default function ImageGenerationSettings() {
  const [settings, setSettings] = useState<ImageSettings | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError('');
    try { setSettings(await request()); }
    catch { setError('Image settings could not be loaded.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  return <section className="settings-section image-generation-settings">
    <div className="settings-section-title"><div><h2>Image generation</h2><p>Optional image generation using a separate OpenAI API key.</p></div></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <div className="settings-saved" role="status">{notice}</div>}
    {!settings ? <div className="loading-state">{error ? <button className="button" disabled={busy} onClick={() => void load()}>Retry loading image settings</button> : 'Loading image settings…'}</div> : <ImageGenerationSettingsForm key={JSON.stringify(settings)} settings={settings} busy={busy} onSave={async body => {
      setBusy(true); setError(''); setNotice('');
      try { setSettings(await request(body)); setNotice('Image settings saved.'); }
      catch { setError('Image settings could not be saved. Check the service configuration and try again.'); }
      finally { setBusy(false); }
    }}/>}
  </section>;
}
