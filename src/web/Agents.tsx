import Breadcrumbs from './Breadcrumbs';
import ActivityFeed from './ActivityFeed';
import QuestInfo from './QuestInfo';
import LatestResultShortcut from './LatestResultShortcut';
import Icon from './Icon';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from './Markdown';
import Transcript from './Transcript';

export type AgentSummary = { queueReason?: string;
  model?: string;
  id: string; title: string; objective: string; status: string; updatedAt: string | number;
  activeRunId?: string; workspacePath?: string; workspaceMode: string; result?: string; error?: string;
  workspaces?: { repositoryId: string; name: string; workspacePath: string; mode: string }[];
};
type AgentMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string | number };
type AgentEvent = { id: string | number; type: string; detail: unknown; createdAt: string | number };
type AgentRequest = { id: string; questId: string; question: string; status: 'pending' | 'answered'; answer?: string; answerMessageId?: string; createdAt: string | number };
type LiveMessage = { runId: string; messageId: string; text: string };
type ToolCall = { id: string; runId: string; tool: string; detail: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: number; endedAt?: number; output?: string };
type AgentDetail = { events?: AgentEvent[]; quest: AgentSummary; messages: AgentMessage[]; requests: AgentRequest[]; live?: LiveMessage | null; toolCalls?: ToolCall[] };
type ViewTab = 'conversation';
type ViewMemory = { tab: ViewTab; scroll: Partial<Record<ViewTab, number>> };
type AgentRoute = { questId: string; agentId: string; fromOverview?: boolean };
const memories = new Map<string, { overview: number; agents: Map<string, ViewMemory> }>();
const date = (value: string | number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const statusNames: Record<string, string> = { queued: 'Queued', running: 'In progress', waiting: 'Waiting for agents', awaiting_input: 'Waiting for quest lead', awaiting_review: 'Ready for review', completed: 'Completed', accepted: 'Accepted', failed: 'Needs attention', interrupted: 'Interrupted', cancelled: 'Cancelled' };
const route = (): AgentRoute | undefined => window.history.state?.guildmasterAgent;
function Chevron({ back = false }: { back?: boolean }) { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={back ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}/></svg>; }

export default function Agents({ onBoard, questId, parentTitle, agents, pendingAgentIds, onResume, canResume, liveByQuest, refreshVersion, onInspectChange, connectionError }: {
  onBoard: () => void;
  questId: string; parentTitle: string; agents: AgentSummary[]; pendingAgentIds: string[];
  onResume: (id: string) => Promise<void>; canResume: boolean;
  liveByQuest: Record<string, LiveMessage | null>; refreshVersion: number;
  onInspectChange?: (inspecting: boolean) => void; connectionError?: string;
}) {
  const memory = useRef(memories.get(questId) ?? { overview: 0, agents: new Map<string, ViewMemory>() }).current;
  memories.set(questId, memory);
  const initial = route();
  const [selection, setSelection] = useState<string | null>(() => initial?.questId === questId ? initial.agentId : null);
  const defaultTab = (_id: string): ViewTab => 'conversation';
  const [tab, setTab] = useState<ViewTab>(() => selection ? defaultTab(selection) : 'conversation');
  const [infoOpen, setInfoOpen] = useState(false);
  useEffect(() => { setInfoOpen(false); }, [selection]);
  const [resultJump, setResultJump] = useState<{ id: string; sequence: number }>();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState('');
  const [resuming, setResuming] = useState(false);
  const [actionError, setActionError] = useState('');
  const selectedId = agents.some(agent => agent.id === selection) ? selection : null;
  const requestNumber = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followLatest = useRef(false);
  const restorePosition = useRef(true);
  const shown = detail?.quest.id === selectedId ? detail : null;
  const current = shown?.quest ?? agents.find(agent => agent.id === selectedId);
  const pendingRequest = shown?.requests.find(request => request.status === 'pending');
  const pending = !!pendingRequest || !!selectedId && pendingAgentIds.includes(selectedId);
  const live = selectedId && Object.hasOwn(liveByQuest, selectedId) ? liveByQuest[selectedId] : shown?.live ?? null;
  const rememberScroll = useCallback(() => {
    if (!scroll.current || restorePosition.current) return;
    if (!selectedId) memory.overview = scroll.current.scrollTop;
    else {
      const state = memory.agents.get(selectedId) ?? { tab, scroll: {} };
      state.tab = tab; state.scroll[tab] = scroll.current.scrollTop; memory.agents.set(selectedId, state);
    }
  }, [memory, selectedId, tab]);
  const refresh = useCallback(async () => {
    if (!selectedId) return;
    const request = ++requestNumber.current;
    try {
      const response = await fetch(`/api/quests/${encodeURIComponent(questId)}/agents/${encodeURIComponent(selectedId)}`);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not load this agent.');
      if (request === requestNumber.current) { setDetail(value); setError(''); }
    } catch (cause) { if (request === requestNumber.current) setError((cause as Error).message); }
  }, [questId, selectedId]);
  useLayoutEffect(() => { onInspectChange?.(!!selectedId); return () => onInspectChange?.(false); }, [selectedId, onInspectChange]);
  useLayoutEffect(() => () => rememberScroll(), [rememberScroll]);
  const showSelection = (id: string | null) => {
    setResultJump(undefined);
    rememberScroll(); restorePosition.current = true; followLatest.current = false;
    setSelection(id); if (id) setTab(defaultTab(id));
  };
  useEffect(() => {
    const pop = () => { const state = route(); showSelection(state?.questId === questId ? state.agentId : null); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  });
  const inspect = (id: string) => {
    window.history.pushState({ ...window.history.state, guildmasterAgent: { questId, agentId: id, fromOverview: true } }, '');
    showSelection(id);
  };
  const back = () => {
    rememberScroll();
    if (route()?.questId === questId && route()?.fromOverview && window.history.length > 1) window.history.back();
    else { const state = { ...window.history.state }; delete state.guildmasterAgent; window.history.replaceState(state, ''); showSelection(null); }
  };
  useEffect(() => {
    setDetail(null); setError(''); setActionError('');
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { clearInterval(timer); requestNumber.current++; };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh, refreshVersion]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (restorePosition.current && (!selectedId || shown || error)) {
      const saved = selectedId ? memory.agents.get(selectedId)?.scroll[tab] : memory.overview;
      element.scrollTop = saved ?? (tab === 'conversation' || tab === 'activity' ? element.scrollHeight : 0);
      restorePosition.current = false;
      followLatest.current = !!selectedId && ['conversation', 'activity'].includes(tab) && element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    } else if (followLatest.current) element.scrollTop = element.scrollHeight;
  }, [shown, live, selectedId, tab, error, memory]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const track = () => {
      if (restorePosition.current) return;
      followLatest.current = !!selectedId && ['conversation', 'activity'].includes(tab) && element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      rememberScroll();
    };
    const observer = new ResizeObserver(() => { if (followLatest.current && !restorePosition.current) element.scrollTop = element.scrollHeight; });
    const inspect = () => { followLatest.current = false; };
    element.addEventListener('conversation-inspect', inspect);
    element.addEventListener('scroll', track, { passive: true }); observer.observe(element); if (content.current) observer.observe(content.current);
    return () => { observer.disconnect(); element.removeEventListener('scroll', track); element.removeEventListener('conversation-inspect', inspect); };
  }, [selectedId, tab, rememberScroll]);
  if (!current) return <div className="agents-overview page-scroll" ref={scroll}><div className="agents-pane" ref={content}>
    {!agents.length ? <div className="tab-empty"><h3>No delegated work yet</h3><p>Assignments will appear here when the quest lead delegates work.</p></div> : <div className="agent-overview-list" aria-label="Agent assignments">{agents.map(agent => <button key={agent.id} className="agent-overview-row" onClick={() => inspect(agent.id)}><span className="agent-overview-label"><strong>{agent.title}</strong><span>{agent.model}</span><span>{agent.workspaces?.length ? agent.workspaces.map(workspace => workspace.name).join(' · ') : agent.workspaceMode === 'none' ? 'Scratch workspace' : agent.workspacePath?.split('/').filter(Boolean).pop() || 'Quest workspace'}</span></span><span className={`badge status-${pendingAgentIds.includes(agent.id) ? 'awaiting_input' : agent.status}`}><span className="status-dot"/>{pendingAgentIds.includes(agent.id) ? 'Waiting for quest lead' : agent.queueReason || statusNames[agent.status] || agent.status}</span><Chevron/></button>)}</div>}
  </div></div>;
  return <div className="agent-detail-view">
    <div className="quest-header"><Breadcrumbs current="Agent" items={[{ label: 'Quest board', onClick: onBoard }, { label: parentTitle, onClick: back }]}/><div className="quest-title-row"><div><h1>{current.title}</h1><div className="quest-subline"><span className={`badge status-${pending ? 'awaiting_input' : current.status}`}><span className="status-dot"/>{pending ? 'Waiting for quest lead' : statusNames[current.status] || current.status}</span></div></div></div></div>
    <div className="quest-tabbar"><div className="detail-tabs"><button className="selected" aria-pressed="true"><Icon name="chat" size={15}/>Conversation</button></div><div className="quest-tabbar-actions"><button className="icon-button" aria-label="Agent info" title="Agent info" aria-expanded={infoOpen} aria-controls="agent-info" onClick={() => setInfoOpen(true)}><Icon name="panel" size={18}/></button></div></div>
    <div className="quest-conversation-wrap">
    <div className="quest-scroll page-scroll" ref={scroll}><div className="agents-pane" ref={content}>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {actionError && <div className="inline-error" role="alert">{actionError}</div>}
      {current.error && !pending && <div className="inline-error" role="status">{current.error}</div>}
      {canResume && ['interrupted', 'failed'].includes(current.status) && shown && !pending && <div className="agent-recovery"><span>The saved assignment can continue.</span><button className="button small" disabled={resuming || !!connectionError} onClick={async () => { setResuming(true); setActionError(''); try { await onResume(current.id); await refresh(); } catch (cause) { setActionError((cause as Error).message); } finally { setResuming(false); } }}>{resuming ? 'Resuming…' : 'Resume agent'}</button></div>}
      {!shown ? !error && <div className="loading-state"><span className="spinner"/> Loading agent…</div> : <Transcript questId={shown.quest.id} showToolCalls jumpTo={resultJump} key={shown.quest.id} messages={shown.messages} requests={shown.requests} questionsForLead toolCalls={shown.toolCalls || []} events={shown.events} live={live} status={shown.quest.status} queueReason={shown.quest.queueReason} activeRunId={shown.quest.activeRunId} assistantLabel="Agent"/>}
    </div></div>
      <LatestResultShortcut key={selectedId} onJump={id => { followLatest.current = false; setResultJump(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 })); }}/>
    </div>
    {infoOpen && <QuestInfo label="Agent info" onClose={() => setInfoOpen(false)} activity={<ActivityFeed events={shown?.events || []}/>} details={<div className="details-pane">
      <section className="inspector-section"><h3>Assignment</h3><Markdown text={current.objective}/></section>
      <section className="inspector-section"><h3>Workspaces</h3>{current.workspaces?.length ? current.workspaces.map(workspace => <div className="inspector-workspace" key={workspace.repositoryId}><div><strong>{workspace.name}</strong><span>{workspace.mode === 'worktree' ? 'Isolated worktree' : 'Existing checkout'}</span></div><code>{workspace.workspacePath}</code></div>) : <div className="inspector-workspace"><div><span>{current.workspaceMode === 'none' ? 'Scratch workspace' : 'Workspace'}</span></div>{current.workspacePath && <code>{current.workspacePath}</code>}</div>}</section>
    </div>}/>}
  </div>;
}
