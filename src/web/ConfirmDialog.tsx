import React, { useEffect, useRef } from 'react';

export default function ConfirmDialog({ title, description, confirmLabel, onConfirm, onClose, cancelLabel = 'Keep quest' }: {
  cancelLabel?: string; title: string; description: string; confirmLabel: string; onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" onCancel={onClose}>
    <h2 id="confirmation-title">{title}</h2>
    <p id="confirmation-description">{description}</p>
    <div className="project-editor-actions">
      <button className="button" autoFocus onClick={onClose}>{cancelLabel}</button>
      <button className="button" onClick={() => { dialog.current?.close(); onConfirm(); }}>{confirmLabel}</button>
    </div>
  </dialog>;
}
