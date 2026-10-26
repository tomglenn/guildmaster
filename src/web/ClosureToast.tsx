import React from 'react';
import Toast from './Toast';
import type { LifecycleQuest } from './quest-lifecycle';
export type ClosureNotice = { quest: LifecycleQuest & { title: string }; message: string; error?: string };
export default function ClosureToast({ notice, busy, onView, onUndo, onDismiss }: { notice: ClosureNotice; busy: boolean; onView: () => void; onUndo: () => void; onDismiss: () => void }) {
  return <Toast key={`${notice.quest.id}:${notice.quest.closedAt}`} paused={busy} persistent={!!notice.error} onDismiss={onDismiss} actions={<>
    <button type="button" className="toast-action" onClick={onView}>View quest</button>
    <button type="button" className="toast-action toast-undo" disabled={busy} aria-label="Undo close; return quest to inbox" onClick={onUndo}>Undo</button>
  </>}>
    <strong>{notice.message}</strong><p className="toast-description" title={notice.quest.title}>{notice.quest.title}</p>
    {notice.error&&<p className="toast-error" role="alert">{notice.error}</p>}
  </Toast>;
}
