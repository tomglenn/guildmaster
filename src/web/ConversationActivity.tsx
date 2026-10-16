import React, { useState, type ReactNode } from 'react';
import Icon from './Icon';
import { compactToolCalls, toolPresentation, type Delegation, type ToolCall } from './transcript-data';

// Remember arrivals across tab switches. Existing history is registered by Transcript.
export const seenConversationEntries = new Set<string>();
function beginInspection(element: HTMLElement) {
  element.dispatchEvent(new Event('conversation-inspect', { bubbles: true }));
}
export function NewEntry({ id, arriving, delayMs = 0, children }: { id: string; arriving: boolean; delayMs?: number; children: ReactNode }) {
  const [animate] = useState(() => arriving && !seenConversationEntries.has(id));
  return <div className={animate ? 'conversation-entry entry-arrival' : 'conversation-entry'} style={animate ? { animationDelay: `${delayMs}ms` } : undefined}>{children}</div>;
}

function StateMark({ status }: { status: string }) {
  if (status === 'running') return <span className="spinner" role="img" aria-label="In progress"/>;
  const completed = ['completed', 'accepted', 'awaiting_review'].includes(status);
  return <span className={`action-state ${completed ? 'completed' : ['failed', 'interrupted', 'cancelled', 'awaiting_input'].includes(status) ? 'attention' : ''}`} role="img" aria-label={completed ? 'Completed' : status === 'failed' ? 'Command failed' : status === 'awaiting_input' ? 'Waiting for quest lead' : status === 'interrupted' ? 'Interrupted' : status === 'cancelled' ? 'Cancelled' : status === 'previous' ? 'Earlier assignment' : 'Queued'}><Icon name={completed ? 'check' : ['failed', 'interrupted', 'awaiting_input'].includes(status) ? 'alert' : status === 'cancelled' ? 'close' : 'clock'} size={14}/></span>;
}

export function DelegationRow({ agent, onOpen }: { agent: Delegation; onOpen?: (id: string) => void }) {
  return <button className="delegation-row" disabled={!onOpen} onClick={() => onOpen?.(agent.agentId ?? agent.id)}><Icon name={agent.questLink ? "grid" : "team"} size={15}/><span className="delegation-label">{agent.questLink ? 'Created quest' : agent.followup ? 'Delegated again' : 'Delegated'}</span><span className="delegation-title">{agent.title}</span><StateMark status={agent.questLink ? 'completed' : agent.status}/></button>;
}

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const { label, icon } = toolPresentation(call.tool);
  return <div className="conversation-tool">
    <button className="conversation-tool-row" aria-expanded={open} aria-controls={`tool-output-${call.id}`} onClick={event => { beginInspection(event.currentTarget); setOpen(value => !value); }}>
      <Icon name={icon} size={15}/><span className="tool-action-label">{label}</span><code>{call.detail || call.tool}</code><StateMark status={call.status}/>
    </button>
    {open && <div className="conversation-tool-output" id={`tool-output-${call.id}`}><div className="tool-output-meta">{call.tool} · {call.status === 'failed' ? 'Command failed' : call.status}</div>{call.detail && <pre>{call.detail}</pre>}<pre>{call.output || (call.status === 'running' ? 'Running…' : 'No output recorded.')}</pre></div>}
  </div>;
}

export function ToolActivity({ calls, arriving }: { calls: ToolCall[]; arriving: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const visible = compactToolCalls(calls, expanded);
  return <div className="conversation-tools" aria-label="Agent actions">
    {(calls.length > 3 || expanded) && <button className="tool-history-button" aria-expanded={expanded} onClick={event => { beginInspection(event.currentTarget); setExpanded(value => !value); }}>{expanded ? 'Show recent actions' : visible.hidden ? `Show ${visible.hidden} earlier ${visible.hidden === 1 ? 'action' : 'actions'}` : 'Show all actions'}{!expanded && calls.slice(0, -3).some(call => call.status === 'failed') && <span className="tool-history-warning"> · includes failed commands</span>}</button>}
    {visible.calls.map((call, index) => <NewEntry delayMs={Math.min(index * 45, 135)} key={call.id} id={`tool:${call.id}`} arriving={arriving}><ToolRow call={call}/></NewEntry>)}
  </div>;
}
