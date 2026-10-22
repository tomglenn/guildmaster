import React, { useEffect, useRef, useState } from 'react';
import type { LifecycleQuest } from './quest-lifecycle';
export type ClosureNotice = { quest: LifecycleQuest & { title: string }; message: string; error?: string };
export default function ClosureToast({ notice, busy, onView, onUndo, onDismiss }: { notice: ClosureNotice; busy: boolean; onView: () => void; onUndo: () => void; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(10000);
  useEffect(() => { remaining.current = 10000; }, [notice.quest.closedAt]);
  useEffect(() => {
    if (paused || busy || notice.error) return;
    const started = Date.now();
    const timer = window.setTimeout(onDismiss, remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [paused, busy, notice, onDismiss]);
  return <aside className="closure-toast" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }} aria-label="Quest closure confirmation">
    <div role="status" aria-live="polite"><strong>{notice.message}</strong><p>{notice.quest.title}</p></div>
    {notice.error && <p role="alert">{notice.error}</p>}
    <div className="closure-toast-actions"><button className="button small" onClick={onView}>View</button><button className="button small" disabled={busy} aria-label="Undo close; return quest to inbox" onClick={onUndo}>Undo</button><button className="button small" aria-label="Dismiss confirmation" onClick={onDismiss}>Dismiss</button></div>
  </aside>;
}
