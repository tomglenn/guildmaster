import React from 'react';

export type WorkspaceMaterial = 'manuscript' | 'noticeboard' | 'ledger' | 'planner';

// One shared layout; materials are presentation only and never affect routing.
export default function Workspace({ material, children, ...props }: React.HTMLAttributes<HTMLElement> & { material: WorkspaceMaterial }) {
  return <main {...props} className={`main${material === 'noticeboard' ? ' main-board' : ''}`} data-workspace={material}
    onScrollCapture={event => {
      const scroller = event.target as HTMLElement;
      if (scroller.classList.contains('page-scroll')) scroller.dataset.scrolled = String(scroller.scrollTop > 0);
    }}>
    <div className="guildhall-sheet" aria-hidden="true">{['tl', 'top', 'tr', 'left', 'centre', 'right', 'bl', 'bottom', 'br'].map(part => <span className={`sheet-${part}`} key={part}/>)}</div>
    {children}
  </main>;
}
