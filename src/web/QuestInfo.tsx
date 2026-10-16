import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

export default function QuestInfo({ activity, details, onClose, label = 'Quest info' }: {
  label?: string; activity: React.ReactNode; details: React.ReactNode; onClose: () => void;
}) {
  const [tab, setTab] = useState('activity');
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const inertElements: { element: HTMLElement; previous: boolean }[] = [];
    {
      close.current?.focus();
      // Keep the overlay as the only interactive part of the page.
      let branch: HTMLElement | null = panel.current;
      while (branch?.parentElement && branch !== document.body) {
        for (const sibling of branch.parentElement.children) {
          if (sibling !== branch && sibling instanceof HTMLElement && !sibling.classList.contains('quest-info-scrim')) {
            inertElements.push({ element: sibling, previous: sibling.inert });
            sibling.inert = true;
          }
        }
        branch = branch.parentElement;
      }
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key === 'Tab') {
        const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,textarea,summary,[tabindex="0"]');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); for (const { element, previous } of inertElements) element.inert = previous; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <>
    <div className="quest-info-scrim" onClick={onClose} aria-hidden="true"/>
    <aside id={label === 'Agent info' ? 'agent-info' : 'quest-info'} className="quest-info" ref={panel} role="dialog" aria-modal="true" aria-labelledby="quest-info-title">
      <div className="quest-info-heading"><h2 id="quest-info-title">{label}</h2><button ref={close} className="icon-button" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose}><Icon name="close" size={18}/></button></div>
      <div className="detail-tabs" aria-label={`${label} views`}>
        <button className={tab === 'activity' ? 'selected' : ''} aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}><Icon name="activity" size={15}/>Activity</button>
        <button className={tab === 'details' ? 'selected' : ''} aria-pressed={tab === 'details'} onClick={() => setTab('details')}><Icon name="settings" size={15}/>Details</button>
      </div>
      <div className="quest-info-scroll quest-scroll page-scroll" hidden={tab !== 'activity'}>{activity}</div>
      <div className="quest-info-scroll quest-scroll page-scroll" hidden={tab !== 'details'}>{details}</div>
    </aside>
  </>;
}
