import React, { useEffect, useLayoutEffect, useRef } from 'react';
import Icon from './Icon';
import { visibleActivity } from './transcript-data';
const date = (value: string | number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function ActivityFeed({ events: allEvents }: { events: { id: string | number; type: string; detail: unknown; createdAt: string | number }[] }) {
  const events = visibleActivity(allEvents);
  const pane = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  // The service returns chronological events. Follow the newest at the bottom,
  // but leave the reader's position alone while they inspect earlier activity.
  useLayoutEffect(() => {
    const scroll = pane.current?.closest('.quest-scroll');
    if (scroll && followLatest.current) scroll.scrollTop = scroll.scrollHeight;
  }, [events.at(-1)?.id]);
  useEffect(() => {
    const scroll = pane.current?.closest('.quest-scroll');
    if (!scroll) return;
    const track = () => { followLatest.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64; };
    scroll.addEventListener('scroll', track, { passive: true });
    return () => scroll.removeEventListener('scroll', track);
  }, []);
  return <div className="activity-pane" ref={pane}>{events.length ? <ol className="activity-timeline" aria-label="Quest activity">{events.map(event => <li className="activity-item" key={event.id}>
    <span className="activity-bullet" aria-hidden="true"/>
    <div><div className="activity-event-heading"><strong>{event.type.replace(/[._-]/g, ' ')}</strong><time dateTime={new Date(event.createdAt).toISOString()}>{date(event.createdAt)}</time></div>
      {event.detail != null && event.detail !== '' && <p>{typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail, null, 2)}</p>}
    </div>
  </li>)}</ol> : <div className="tab-empty"><Icon name="activity" size={28}/><h3>The story starts here</h3><p>Quest activity will appear as the service records it.</p></div>}</div>;

}
