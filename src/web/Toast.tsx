import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import Icon from './Icon';

const DURATION = 4500;
export default function Toast({children, actions, paused=false, persistent=false, onDismiss}: {
  children: ReactNode; actions?: ReactNode; paused?: boolean; persistent?: boolean; onDismiss:()=>void;
}) {
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [hidden,setHidden]=useState(document.hidden);
  const remaining=useRef(DURATION);
  const ring=useRef<SVGCircleElement>(null);
  const dismiss=useRef(onDismiss);dismiss.current=onDismiss;
  useEffect(()=>{
    const changed=()=>setHidden(document.hidden);
    document.addEventListener('visibilitychange',changed);
    return ()=>document.removeEventListener('visibilitychange',changed);
  },[]);
  useEffect(()=>{
    if(hovered || focused || hidden || paused || persistent)return;
    const started=performance.now();
    const left=()=>Math.max(0,remaining.current-(performance.now()-started));
    let frame=0;
    const draw=()=>{ring.current?.setAttribute('stroke-dashoffset',String(100*(1-left()/DURATION)));frame=requestAnimationFrame(draw);};
    draw();
    const timer=window.setTimeout(()=>dismiss.current(),remaining.current);
    return ()=>{clearTimeout(timer);cancelAnimationFrame(frame);remaining.current=left();};
  },[hovered,focused,hidden,paused,persistent]);
  return <aside className="closure-toast" aria-label="Notification" onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocus={()=>setFocused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
    <div className="toast-content" role="status">{children}</div>
    <button className="toast-dismiss" type="button" aria-label="Dismiss notification" title="Dismiss" onClick={onDismiss}>
      {!persistent&&<svg className="toast-countdown" viewBox="0 0 28 28" aria-hidden="true"><circle className="toast-countdown-track" cx="14" cy="14" r="11"/><circle ref={ring} className="toast-countdown-progress" cx="14" cy="14" r="11" pathLength="100" strokeDasharray="100" strokeDashoffset="0"/></svg>}
      <Icon name="close" size={12}/>
    </button>
    {actions&&<div className="closure-toast-actions">{actions}</div>}
  </aside>;
}
