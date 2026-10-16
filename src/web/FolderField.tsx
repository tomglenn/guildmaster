import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type FolderListing = {
  path: string; parentPath: string | null; homePath: string; isRepository: boolean; truncated: boolean;
  directories: { name: string; path: string; isRepository: boolean }[];
};

function FolderIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3z"/></svg>;
}

function FolderPicker({ initialPath, onSelect, onClose }: { initialPath: string; onSelect: (path: string) => void; onClose: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const [request, setRequest] = useState({ path: initialPath.trim() || undefined, hidden: false });
  const [location, setLocation] = useState(initialPath);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = (path?: string) => {
    setLoading(true); setError('');
    pathInput.current?.focus({ preventScroll: true });
    setRequest(current => ({ ...current, path }));
  };

  useEffect(() => { pathInput.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const query = new URLSearchParams({ hidden: String(request.hidden) });
    if (request.path) query.set('path', request.path);
    void (async () => {
      try {
        const response = await fetch(`/api/folders?${query}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(response.status === 404
          ? 'Restart the local service to use the folder browser.'
          : data.error || 'This folder could not be opened. Choose another folder.');
        if (!controller.signal.aborted) { setListing(data); setLocation(data.path); setSearch(''); }
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [request]);

  const folders = listing?.directories.filter(folder => folder.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  return createPortal(<div className="modal-backdrop folder-picker-backdrop" onMouseDown={event => {
    event.stopPropagation(); if (event.target === event.currentTarget) onClose();
  }} onKeyDown={event => {
    // Keep keyboard events inside the folder browser.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}><div className="modal folder-picker" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
    <header className="modal-header"><div><h2 id={titleId}>Choose a folder</h2><p>Open a folder to browse inside it, then select the folder you want.</p></div><button className="icon-button" type="button" aria-label="Close folder browser" onClick={onClose}>✕</button></header>
    <div className="folder-picker-navigation">
      <div className="folder-picker-location"><input ref={pathInput} aria-label="Folder location" value={location} placeholder="Home folder" onChange={event => setLocation(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); navigate(location.trim() || undefined); }
      }}/><button className="button small" type="button" onClick={() => navigate(location.trim() || undefined)}>Go</button></div>
      <div className="folder-picker-toolbar"><div><button className="button small" type="button" onClick={() => navigate()}>Home</button><button className="button small" type="button" disabled={!listing?.parentPath || loading} onClick={() => navigate(listing?.parentPath ?? undefined)}>Up one level</button></div><label><input type="checkbox" checked={request.hidden} onChange={event => { setLoading(true); setRequest(current => ({ ...current, hidden: event.target.checked })); }}/>Show hidden</label></div>
      <input className="folder-picker-search" aria-label="Filter folders" placeholder="Find a folder here…" value={search} onChange={event => setSearch(event.target.value)}/>
    </div>
    <div className="folder-picker-list" aria-busy={loading}>
      {loading ? <div className="folder-picker-empty" role="status">Loading folders…</div> : error ? <div className="inline-error" role="alert">{error}</div> : <>
        {folders.length ? folders.map(folder => <button className="folder-picker-entry" type="button" key={folder.path} title={folder.path} aria-label={`Open ${folder.name}`} onClick={() => navigate(folder.path)}><FolderIcon/><span>{folder.name}</span>{folder.isRepository && <small>Git repository</small>}<span aria-hidden="true">›</span></button>) : <p className="folder-picker-empty">{search ? 'No matching folders.' : 'No subfolders. You can select this folder.'}</p>}
        {listing?.truncated && <p className="folder-picker-empty">Showing the first 1,000 folders. Enter a folder location to open one outside this list.</p>}
      </>}
    </div>
    <footer className="folder-picker-footer"><div><span>Selected folder</span><code>{!loading && !error ? listing?.path : 'Choose a folder'}</code></div><div><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="button" disabled={loading || !!error || !listing} onClick={() => listing && onSelect(listing.path)}>Select folder</button></div></footer>
  </div></div>, document.body);
}

export default function FolderField({ label, value, onChange, onPick, description, required, disabled }: {
  label: string; value: string; onChange: (path: string) => void; onPick?: (path: string) => void;
  description?: string; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  const browse = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); browse.current?.focus({ preventScroll: true }); };
  return <div className="field folder-field"><label htmlFor={id}>{label}</label><div className="folder-field-input"><input id={id} value={value} required={required} disabled={disabled} placeholder="Choose a folder…" onChange={event => onChange(event.target.value)}/><button className="button" ref={browse} type="button" disabled={disabled} onClick={() => setOpen(true)} aria-label={`Browse for ${label.toLowerCase()}`}><FolderIcon/>Browse…</button></div>{description && <small>{description}</small>}
    {open && <FolderPicker initialPath={value} onClose={close} onSelect={path => { (onPick ?? onChange)(path); close(); }}/>}</div>;
}
