import React from 'react';

function GuildCrest() {
  return <svg className="guild-crest" viewBox="0 0 84 100" fill="none" aria-hidden="true">
    <path d="M12 15Q42 4 72 15v39c0 20-14 33-30 40C26 87 12 74 12 54z" fill="#552b29" stroke="#d7b472" strokeWidth="2"/>
    <path d="M18 20q24-9 48 0v34c0 16-10 27-24 34-14-7-24-18-24-34z" stroke="#d7b472" strokeOpacity=".5"/>
    <path d="m42 0 3 5-3 5-3-5zM5 29l4 5-4 5-4-5zm74 0 4 5-4 5-4-5z" fill="#d7b472"/>
    <text x="42" y="62" textAnchor="middle" fill="#f3dc9c" fontFamily="Georgia, serif" fontSize="41">G</text>
    <path d="M28 72h28M34 77h16" stroke="#d7b472"/>
  </svg>;
}

export function GuildhallBrand() {
  return <span className="guildhall-brand" aria-hidden="true"><GuildCrest/><span>Guildmaster</span><small>The adventurers’ guild</small></span>;
}

export default function GuildhallWelcome() {
  return <div className="guildhall-welcome">
    <div className="guild-welcome-crest"><GuildCrest/></div>
    <span className="guild-welcome-kicker">A seat at the guild’s table</span>
    <h2>Great deeds<br/>begin here.</h2>
    <p>Bring your ambition. Gather your company.<br/>Let’s make something worth the telling.</p>
    <span className="guild-welcome-flourish" aria-hidden="true">✦</span>
  </div>;
}
