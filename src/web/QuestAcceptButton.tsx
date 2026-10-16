import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

export default function QuestAcceptButton({ accepted, disabled, title, onAccept }: { accepted: boolean; disabled: boolean; title?: string; onAccept: () => Promise<void> }) {
  const previous = useRef(accepted);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    const changed = !previous.current && accepted;
    previous.current = accepted;
    if (!changed) { if (!accepted) setCelebrate(false); return; }
    setCelebrate(true);
    const timer = window.setTimeout(() => setCelebrate(false), 900);
    return () => clearTimeout(timer);
  }, [accepted]);
  return <button className={`button small quest-accept ${accepted ? 'is-accepted' : 'primary'} ${celebrate ? 'accept-celebrate' : ''}`} disabled={accepted || disabled} title={title} onClick={() => void onAccept()}>
    <Icon name="check" size={16}/><span>{accepted ? 'Accepted' : 'Accept'}</span>
  </button>;
}
