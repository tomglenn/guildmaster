import React from 'react';

/** Theme-specific welcome copy. Artwork lives on the shell, including active work views. */
export default function CyberpunkWelcome() {
  return <div className="cyber-welcome">
    <div className="cyber-kicker"><span aria-hidden="true">↗</span> Your personal agent network</div>
    <h2>YOUR NEXT<br/><span>BIG THING.</span></h2>
    <p>Dream it up. Put your agents to work.<br/>Build something they haven’t seen before.</p>
    <div className="cyber-welcome-caption" aria-hidden="true"><span/>Guildmaster / Night city edition</div>
  </div>;
}
