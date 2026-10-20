import React from 'react';

export default function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h.01M12 15h.01M17 15h.01"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/></>,
    providers: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/></>,
    connections: <><path d="M9 8V2m6 6V2M7 8h10v4a5 5 0 0 1-10 0V8Zm5 9v5"/></>,
    brain: <><path d="M12 5a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 3 9a4 4 0 0 0 .5 7.5A3.5 3.5 0 0 0 10 20l2-1V5Zm0 0a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 21 9a4 4 0 0 1-.5 7.5A3.5 3.5 0 0 1 14 20l-2-1"/><path d="M8 8a3 3 0 0 1-2 3m2 2a3 3 0 0 1 0 5m8-10a3 3 0 0 0 2 3m-2 2a3 3 0 0 0 0 5"/></>,
    down: <path d="m6 9 6 6 6-6"/>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.2 1.2 0 0 1 .6-2.3H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z"/><circle cx="7.5" cy="11" r=".7"/><circle cx="10" cy="7" r=".7"/><circle cx="15" cy="7.5" r=".7"/></>,
    panel: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></>,
    compass: <><circle cx="12" cy="12" r="6.5" strokeWidth=".7"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l3 3m10 10 3 3M4 20l3-3M17 7l3-3" strokeWidth=".8"/><path d="m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2z" strokeWidth=".9"/><path d="m12 3 2 7-2 2zM12 12l-2 2 2 7z" fill="currentColor" stroke="none"/></>,
    team: <><rect x="8" y="3" width="8" height="5" rx="1"/><rect x="2" y="16" width="7" height="5" rx="1"/><rect x="15" y="16" width="7" height="5" rx="1"/><path d="M12 8v4M5.5 16v-4h13v4"/></>,
    edit: <><path d="m15 4 5 5M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    filter: <><path d="M4 6h16M7 12h10M10 18h4"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M12 19V5m-6 6 6-6 6 6"/>, right: <path d="m9 5 7 7-7 7"/>, back: <path d="m15 5-7 7 7 7"/>,
    check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    archive: <><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M9 12h6"/></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3z"/>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7c0 7-12 3-12 9"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    gear: <><path d="m9.5 3-.5 2a7 7 0 0 0-1.5.9l-2-.6L3 9.7l1.5 1.4a8 8 0 0 0 0 1.8L3 14.3l2.5 4.4 2-.6A7 7 0 0 0 9 19l.5 2h5l.5-2a7 7 0 0 0 1.5-.9l2 .6 2.5-4.4-1.5-1.4a8 8 0 0 0 0-1.8L21 9.7l-2.5-4.4-2 .6A7 7 0 0 0 15 5l-.5-2z"/><circle cx="12" cy="12" r="3"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/></>,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5"/>,
    chat: <path d="M21 11a8 8 0 0 1-8 8H7l-5 3V7a5 5 0 0 1 5-5h6a8 8 0 0 1 8 9Z"/>,
    retry: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/></>,
    terminal: <><path d="m4 5 6 6-6 6M12 19h8"/></>,
    document: <><path d="M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h6"/></>,
    alert: <><path d="m12 3 10 18H2zM12 9v5"/><path d="M12 17h.01"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.document}</svg>;
}
