import React, { useEffect, useId, useState } from 'react';

/** Decorative vector scenery with no network assets or interaction layer. */
export function HauntedManor() {
  return <svg viewBox="0 0 320 210" fill="none" aria-hidden="true" focusable="false">
    <circle className="haunt-moon-halo" cx="213" cy="66" r="55" fill="#e9bf8a" opacity=".06"/>
    <circle cx="213" cy="66" r="37" fill="#e9cfaa"/>
    <circle cx="225" cy="55" r="8" fill="#bba58d" opacity=".35"/><circle cx="202" cy="80" r="5" fill="#bba58d" opacity=".3"/>
    <g fill="#c8a3e8" opacity=".65"><path d="m57 35 2-5 2 5-2 5zM119 18l2-4 2 4-2 4zM276 100l2-4 2 4-2 4z"/></g>
    <g className="haunt-bats" fill="#171222"><path d="M233 30q-9-15-17-5 8-1 8 8l8 1 4 6 4-6q8-6 14-1-4-14-14-4l-2-5-3 5zM73 71q-8-12-16-3 9-2 10 6l6-2 5 5 3-7q5-4 11-1-4-11-12-2l-3-4z"/></g>
    <path d="M0 188q68-30 147-7t173-8v37H0z" fill="#211a2d"/>
    <g stroke="#403047" strokeWidth="4" strokeLinecap="round"><path d="m39 190 9-85-16-34m15 48 23-31m-25 49-21-16m26-16 3-34M285 191l-9-65 15-26m-13 40-18-19m19 31 20-10"/></g>
    <path d="M89 183v-62h25V79l21-31 22 31v26h41V91l19-24 19 24v92z" fill="#100e1a" stroke="#6b4858" strokeWidth="1.5"/>
    <path d="m80 123 24-29 20 29m-18-44 29-42 30 42m27 13 25-35 27 35m-91 17 23-30 27 30" fill="#201625" stroke="#91604f" strokeWidth="2"/>
    <path d="M168 184v-29q10-16 20 0v29" fill="#e8a257"/>
    <g className="haunt-windows" fill="#ffc576"><path d="M128 90h12v19h-12zM127 132h13v18h-13zM208 105h12v17h-12zM208 143h12v18h-12zM98 142h10v17H98zM168 119h14v15h-14z"/></g>
    <path d="M134 90v19m-6-10h12m74 6v17m-6-9h12m-38 42v29" stroke="#4b2c2b" strokeWidth="2"/>
    <path d="m175 185-22 25h74l-42-25" fill="#a47359" opacity=".3"/>
    <g className="haunt-ghost"><path d="M63 152q0-19 12-19t12 19v17l-6-5-6 5-6-5-6 5z" fill="#e1d7ec"/><ellipse cx="71" cy="149" rx="2" ry="3" fill="#33283e"/><ellipse cx="80" cy="149" rx="2" ry="3" fill="#33283e"/></g>
    <g transform="translate(241 170)"><path d="m10 1 3-7" stroke="#93a36b" strokeWidth="3"/><ellipse cx="11" cy="12" rx="19" ry="15" fill="#da702e"/><ellipse cx="11" cy="12" rx="10" ry="15" stroke="#a34522"/><path className="haunt-pumpkin-face" d="m-1 10 7-6 1 7zm15 1 2-7 7 6zM1 16l7 2 4-3 4 3 6-2-5 7H7z" fill="#ffe0a1"/></g>
    <path d="M12 197h79m144 2h72" stroke="#69503f" strokeWidth="2"/>
  </svg>;
}

const celebrationEvent = 'guildmaster:halloween-quest-closed';

// Called only after the service acknowledges an accept/close command.
export function celebrateHalloweenQuest() {
  if (document.documentElement.dataset.theme === 'halloween' && document.documentElement.dataset.reducedMotion !== 'true') {
    window.dispatchEvent(new Event(celebrationEvent));
  }
}

export function ComposerFire() {
  const id = useId();
  return <span className="composer-fire" aria-hidden="true"><svg viewBox="0 0 36 76" fill="none" focusable="false">
    <defs>
      <linearGradient id={`${id}-flame`} x1="18" y1="0" x2="18" y2="76" gradientUnits="userSpaceOnUse"><stop stopColor="#ff8b32"/><stop offset=".48" stopColor="#ffb94f"/><stop offset="1" stopColor="#ed9c49"/></linearGradient>
      <radialGradient id={`${id}-heart`} cx=".5" cy=".85" r=".7"><stop stopColor="#fff8d0"/><stop offset=".55" stopColor="#ffe9a0"/><stop offset="1" stopColor="#ffd16a" stopOpacity="0"/></radialGradient>
    </defs>
    <path className="fire-outer" d="M6 76Q0 76 0 69V51C0 35 12 30 16 19c3-7 4-12 2-19 14 13 8 27 13 36 3 6 5 10 5 15v18q0 7-6 7Z" fill={`url(#${id}-flame)`}/>
    <path className="fire-core" d="M6 76Q0 76 0 69V54c1-10 11-18 18-30-1 12 11 20 16 29l2 16q0 7-6 7Z" fill={`url(#${id}-heart)`}/>
  </svg></span>;
}

// A dense first wave, followed by a few deliberately late arrivals. Fixed variation
// keeps renders stable while avoiding rows of identical, synchronized bats.
const swarm = Array.from({ length: 38 }, (_, i) => {
  const depth = (i * 13 % 17) / 16;
  return {
    delay: i < 33 ? (i * 137) % 1350 : 2200 + (i - 33) * 470,
    duration: Math.round(2700 + (1 - depth) * 1000),
    style: {
      top: `${10 + (i * 37 % 79)}%`,
      width: `${Math.round(25 + depth * 67)}px`,
      zIndex: Math.round(depth * 10),
      '--bat-opacity': .6 + depth * .4,
      '--bat-drift': `${-12 + (i * 7 % 25)}vh`,
      '--bat-rise': `${-9 + (i * 11 % 19)}vh`,
      '--bat-bank': `${-13 + (i * 5 % 27)}deg`,
      '--wing-speed': `${240 + (i * 29 % 160)}ms`,
      '--wing-phase': `${-i * 83}ms`,
    } as React.CSSProperties,
  };
});
const swarmLifetime = Math.max(...swarm.map(bat => bat.delay + bat.duration)) + 150;

function BatSwarm() {
  return <div className="haunt-flight">{swarm.map((bat, i) => <span className="haunt-flying-bat" key={i} style={{ ...bat.style, animationDelay: `${bat.delay}ms`, animationDuration: `${bat.duration}ms` }}>
    <svg viewBox="0 0 80 48" fill="currentColor" focusable="false">
      <path className="bat-wing bat-wing-left" d="M38 23C28 7 15 1 1 3c6 7 6 14 4 20 8-5 14-2 16 6 8-4 13 0 17 6Z"/>
      <path className="bat-wing bat-wing-right" d="M42 23C52 7 65 1 79 3c-6 7-6 14-4 20-8-5-14-2-16 6-8-4-13 0-17 6Z"/>
      <path d="m34 18 1-10 5 5 5-5 1 10c7 11 1 21-6 25-7-4-13-14-6-25Z"/>
      <path d="M36 21h2m4 0h2" stroke="#ffd293" strokeWidth="1.6"/>
    </svg>
  </span>)}</div>;
}

export function HalloweenAtmosphere() {
  const [flight, setFlight] = useState(0);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timeout); setFlight(0); };
    const celebrate = () => {
      clearTimeout(timeout);
      setFlight(previous => previous + 1);
      timeout = setTimeout(clear, swarmLifetime);
    };
    window.addEventListener(celebrationEvent, celebrate);
    window.addEventListener('guildmaster:appearance-changed', clear);
    return () => { clearTimeout(timeout); window.removeEventListener(celebrationEvent, celebrate); window.removeEventListener('guildmaster:appearance-changed', clear); };
  }, []);
  return <div className="halloween-atmosphere" aria-hidden="true">
    <svg className="haunt-web" viewBox="0 0 160 160" fill="none"><g stroke="currentColor" strokeWidth=".8"><path d="M160 0 0 0m160 0L0 48M160 0 22 96M160 0 66 136M160 0 115 160M160 0v160"/>{[35, 70, 110, 150].map(r => <path key={r} d={`M${160-r} 0q8 ${r*.13} ${r*.05} ${r*.3}q${r*.23} 0 ${r*.11} ${r*.29}q${r*.27}-.03 ${r*.25} ${r*.25}q${r*.28}-.12 ${r*.29} ${r*.11}q${r*.17}-.04 ${r*.3} ${r*.05}`}/>)}</g><g className="haunt-spider" stroke="currentColor"><path d="M123 40v55m-4 4-7-6m7 9-9 2m16-5 7-6m-7 9 9 2"/><ellipse cx="122" cy="101" rx="4" ry="6" fill="currentColor"/></g></svg>
    {flight > 0 && <BatSwarm key={flight}/>}
    <div className="haunt-embers">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ left: `${8 + i * 11}%`, animationDelay: `${i * -2.7}s`, animationDuration: `${18 + i % 4 * 3}s` }}/>)}</div>
  </div>;
}
