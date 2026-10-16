import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

export default function LatestResultShortcut({ messageId, onJump, label = 'Latest message' }: { messageId: string; label?: string; onJump: () => void }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<'above' | 'below' | null>(null);
  useEffect(() => {
    const scroll = anchor.current?.parentElement?.querySelector('.quest-scroll, .gm-scroll');
    if (!scroll) { setDirection(null); return; }
    let target: HTMLElement | undefined;
    const update = () => {
      const next = Array.from(scroll.querySelectorAll<HTMLElement>('[data-message-id]')).find(element => element.dataset.messageId === messageId);
      // Streaming and saved messages can share an ID but use different DOM nodes.
      if (target !== next) {
        if (target) observer.unobserve(target);
        target = next;
        if (target) observer.observe(target);
      }
      if (!target) { setDirection(null); return; }
      const viewport = scroll.getBoundingClientRect(), message = target.getBoundingClientRect();
      setDirection(message.bottom <= viewport.top ? 'above' : message.top >= viewport.bottom ? 'below' : null);
    };
    const observer = new ResizeObserver(update);
    const mutations = new MutationObserver(update);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    mutations.observe(scroll, { childList: true, subtree: true, characterData: true });
    scroll.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); mutations.disconnect(); scroll.removeEventListener('scroll', update); };
  }, [messageId]);
  return <div className="latest-result-shortcut" ref={anchor}>{direction && <button className={`button small ${direction}`} onClick={onJump}>{label}<Icon name="arrow" size={14}/><span className="sr-only">{direction === 'above' ? 'above' : 'below'}</span></button>}</div>;
}
