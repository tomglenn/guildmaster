import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { latestMessageTarget, observeLatestMessage } from './latest-message';

export default function LatestResultShortcut({ onJump, label = 'Latest message' }: { label?: string; onJump: (messageId: string) => void }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<'above' | 'below' | null>(null);
  useEffect(() => {
    const scroll = anchor.current?.parentElement?.querySelector('.quest-scroll, .gm-scroll');
    if (!scroll) { setDirection(null); return; }
    return observeLatestMessage(scroll as HTMLElement, setDirection);
  }, []);
  const jump = () => {
    const scroll = anchor.current?.parentElement?.querySelector('.quest-scroll, .gm-scroll');
    const id = scroll && latestMessageTarget(scroll)?.dataset.messageId;
    if (id) {
      // Explicit navigation takes priority over a pending follow-bottom resize.
      scroll?.dispatchEvent(new Event('conversation-inspect'));
      onJump(id);
    }
  };
  return <div className="latest-result-shortcut" ref={anchor}>{direction && <button className={`button small ${direction}`} onClick={jump}>{label}<Icon name="arrow" size={14}/><span className="sr-only">{direction === 'above' ? 'above' : 'below'}</span></button>}</div>;
}
