import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Transcript from './Transcript';
import type { TranscriptMessage, TranscriptRequest } from './transcript-data';

type Conversation = { id: string; title: string; createdAt: number; archivedAt: number };
export default function GuildmasterHistory({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<Conversation[]>();
  const [selected, setSelected] = useState<Conversation>();
  const [messages, setMessages] = useState<TranscriptMessage[]>();
  const [requests, setRequests] = useState<TranscriptRequest[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setError(''); setMessages(undefined);
    const path = selected ? `/api/quests/${encodeURIComponent(selected.id)}` : '/api/guildmaster/history';
    void fetch(path).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load conversation history.');
      if (active) { if (selected) { setMessages(data.messages); setRequests((data.requests || []).filter((request: { questId: string }) => request.questId === selected.id)); } else setList(data.conversations); }
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [selected?.id, attempt]);
  return <dialog className={`gm-history-dialog ${selected ? 'reading' : ''}`} ref={dialog} aria-labelledby="gm-history-title" onCancel={onClose}>
    <div className="gm-history-heading"><div>{selected && <button className="text-button" onClick={() => setSelected(undefined)}><Icon name="back" size={14}/>History</button>}<h2 id="gm-history-title">{selected ? selected.title : 'Conversation history'}</h2>{selected && <p>Saved conversation · Read-only</p>}</div><button className="icon-button" aria-label="Close conversation history" onClick={onClose}><Icon name="close" size={18}/></button></div>
    <div className="gm-history-scroll page-scroll">
      {error ? <div className="inline-error" role="alert">{error}<button className="button small" onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : selected ? messages ? <div className="conversation"><Transcript messages={messages} requests={requests} status="completed" assistantLabel="Guildmaster"/></div> : <div className="loading-state"><span className="spinner"/>Loading conversation…</div> : !list ? <div className="loading-state"><span className="spinner"/>Loading history…</div> : list.length ? <div className="gm-history-list">{list.map(item => <button key={item.id} onClick={() => setSelected(item)}><span>{item.title}</span><time>{new Date(item.createdAt).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</time><Icon name="right" size={14}/></button>)}</div> : <div className="tab-empty"><Icon name="chat" size={28}/><h3>No previous conversations</h3><p>Starting a new conversation keeps the old thread here.</p></div>}
    </div>
  </dialog>;
}
