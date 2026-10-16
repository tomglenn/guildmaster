import React, { useEffect, useRef, useState } from 'react';

/** Keep an in-flight signal continuous without flashing labels for brief operations. */
export default function WorkingIndicator({ label }: { label: string | null }) {
  const [displayed, setDisplayed] = useState(label);
  const shown = useRef(label);
  const changedAt = useRef(Date.now());
  useEffect(() => {
    if (label === shown.current) return;
    const apply = () => {
      shown.current = label; changedAt.current = Date.now(); setDisplayed(label);
    };
    if (!label || !shown.current) { apply(); return; }
    // A new label must remain relevant for 350ms; existing labels get 800ms to be read.
    const delay = Math.max(350, 800 - (Date.now() - changedAt.current));
    const timer = window.setTimeout(apply, delay);
    return () => clearTimeout(timer);
  }, [label]);
  // Terminal states and visible agent handoffs disappear immediately, even before effects.
  if (!label) return null;
  return <div className="working-message" role="status"><span className="spinner"/><span>{displayed || label}</span></div>;
}
