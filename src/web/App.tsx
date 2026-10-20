import Schedules from './Schedules';
import QuestAcceptButton from './QuestAcceptButton';
import ModelPicker from './ModelPicker';
import ContextUsage from './ContextUsage';
import ConfirmDialog from './ConfirmDialog';
import Breadcrumbs from './Breadcrumbs';
import ActivityFeed from './ActivityFeed';
import LatestResultShortcut from './LatestResultShortcut';
import QuestInfo from './QuestInfo';
import { latestResultMessage, transcriptItems, visibleLive } from './transcript-data';
import Icon from './Icon';
import SidebarQuest from './SidebarQuest';
import BoardControls from './BoardControls';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ProviderSettings from './ProviderSettings';
import Projects from './Projects';
import Agents from './Agents';
import Transcript from './Transcript';
import Composer from './Composer';
import { composerDrafts } from './useComposerDraft';
import type { ImageUpload, ImageAttachment } from '../domain/images';
import type { LiveMessage, ToolCall } from './transcript-data';
import { ALLOWED_TOOLS, type Project, type ProjectSnapshot, type QuestWorkspace } from '../domain/types';

type Status = 'queued' | 'running' | 'awaiting_input' | 'awaiting_review' | 'accepted' | 'interrupted' | 'failed' | 'cancelled' | 'waiting' | 'completed';
type WorkspaceMode = 'existing' | 'worktree' | 'none';
type Quest = { schedule?: import('../domain/schedules').ScheduleOrigin; queueReason?: string; contextUsage?: import('../domain/types').ContextUsage; id: string; title: string; objective: string; kind: 'quest' | 'guildmaster' | 'delegate'; parentQuestId?: string; status: Status; workspaceMode: WorkspaceMode; workspacePath?: string; model: string; tools: string[]; createdAt: string | number; updatedAt: string | number; sessionPath?: string; error?: string; result?: string; runCount: number; activeRunId?: string; archivedAt?: number; branch?: string; project?: ProjectSnapshot; workspaces?: QuestWorkspace[]; agentSummary?: { total: number; active: number; needsAttention: number } };
type Message = { attachments?: ImageAttachment[]; source?: 'user' | 'guildmaster' | 'quest_lead' | 'schedule' | 'system'; displayText?: string; id: string; questId: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string | number };
type QuestEvent = { id: string; questId: string; type: string; detail: unknown; createdAt: string | number };
type HumanRequest = { id: string; questId: string; question: string; status: 'pending' | 'answered'; answer?: string; answerMessageId?: string; createdAt: string | number };
type Detail = { scheduleAvailable?: boolean; followups?: Pick<Quest, 'id' | 'title' | 'status' | 'createdAt'>[]; originQuest?: {id:string;title:string}; quest: Quest; messages: Message[]; events: QuestEvent[]; requests: HumanRequest[]; agents?: Quest[]; live?: LiveMessage | null; toolCalls?: ToolCall[] };
type Bootstrap = { projectsSupported: boolean; projects: Project[]; quests: Quest[]; guildmaster: Quest | null; models: { id: string; name: string }[]; defaultWorkspace: string; defaultModel?: string; dataDir: string; version: string; [key: string]: unknown };
type View = 'guildmaster' | 'board' | string;

const labels: Record<Status, string> = { queued: 'Queued', running: 'In progress', awaiting_input: 'Needs your input', awaiting_review: 'Ready for review', accepted: 'Accepted', interrupted: 'Interrupted', failed: 'Needs attention', cancelled: 'Cancelled', waiting: 'Waiting for agents', completed: 'Completed' };
const live = (q?: Quest | null) => q?.status === 'running' || q?.status === 'queued' || q?.status === 'waiting';
const needsAttention = (q: Quest) => ['awaiting_review', 'awaiting_input', 'interrupted', 'failed'].includes(q.status) || (!['accepted', 'cancelled'].includes(q.status) && !!q.agentSummary?.needsAttention);
const workspaceNames: Record<WorkspaceMode, string> = { existing: 'Existing checkout', worktree: 'Isolated worktree', none: 'No project workspace' };
const date = (value: string | number) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const commandId = () => crypto.randomUUID();
const readPreference = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const savePreference = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Browser storage is optional; durable quest state lives in the service. */ } };
const statusIcons: Record<Status, string> = { queued: 'clock', running: 'activity', awaiting_input: 'chat', awaiting_review: 'document', accepted: 'check', interrupted: 'alert', failed: 'alert', cancelled: 'close', waiting: 'activity', completed: 'check' };
const unacknowledgedCommands = new Map<string, string>();

async function api<T>(path: string, body?: unknown): Promise<T> {
  let fingerprint: string | undefined;
  if (body && typeof body === 'object' && 'commandId' in body) {
    const { commandId: candidate, ...payload } = body;
    fingerprint = JSON.stringify([path, payload]);
    const stableId = unacknowledgedCommands.get(fingerprint) || String(candidate);
    unacknowledgedCommands.set(fingerprint, stableId);
    body = { ...payload, commandId: stableId };
  }
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: `Service returned ${response.status}.` }));
  if (!response.ok) {
    if (fingerprint && response.status < 500) unacknowledgedCommands.delete(fingerprint);
    throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { status: response.status });
  }
  if (fingerprint) unacknowledgedCommands.delete(fingerprint);
  return data as T;
}


function Badge({ status }: { status: Status }) { return <span className={`badge status-${status}`}><span className="status-dot"/>{labels[status] || status}</span>; }


function Conversation({ detail, streaming, onResume, resumeDisabled, jumpTo, onOpenAgent, onOpenQuest }: { onOpenQuest?: (id: string) => void; onOpenAgent?: (id: string) => void; jumpTo?: { id: string; sequence: number }; detail: Detail | null; streaming?: LiveMessage | null; onResume: () => void; resumeDisabled: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const previous = useRef<{ questId?: string; userMessageId?: string }>({});
  const userMessageId = detail?.messages.findLast(message => message.role === 'user' && (!message.source || message.source === 'user'))?.id;
  // A new outgoing message resumes following even after reading older history.
  // Incoming messages and streaming text follow only while already at the bottom.
  useLayoutEffect(() => {
    if (previous.current.questId !== detail?.quest.id || previous.current.userMessageId !== userMessageId) followLatest.current = true;
    previous.current = { questId: detail?.quest.id, userMessageId };
    const scroll = pane.current?.closest('.gm-scroll, .quest-scroll');
    if (scroll && followLatest.current) scroll.scrollTop = scroll.scrollHeight;
  });
  useLayoutEffect(() => {
    const content = pane.current;
    const scroll = content?.closest('.gm-scroll, .quest-scroll');
    if (!content || !scroll) return;
    const track = () => { followLatest.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64; };
    const observer = new ResizeObserver(() => {
      if (followLatest.current) scroll.scrollTop = scroll.scrollHeight;
    });
    const inspect = () => { followLatest.current = false; };
    scroll.addEventListener('conversation-inspect', inspect);
    scroll.addEventListener('scroll', track, { passive: true });
    observer.observe(content); observer.observe(scroll);
    return () => { observer.disconnect(); scroll.removeEventListener('scroll', track); scroll.removeEventListener('conversation-inspect', inspect); };
  }, [detail?.quest.id]);
  if (!detail) return <div className="loading-state"><span className="spinner"/> Loading conversation…</div>;
  const messages = detail.messages || [];
  const needsRecovery = ['interrupted', 'failed'].includes(detail.quest.status);
  const ownQuestion = detail.requests.some(request => request.questId === detail.quest.id && request.status === 'pending');
  return <div className="conversation" ref={pane}><Transcript followups={detail.followups} onOpenQuest={onOpenQuest} questId={detail.quest.id} agents={detail.quest.kind === 'quest' ? detail.agents : undefined} onOpenAgent={onOpenAgent} jumpTo={jumpTo} key={detail.quest.id} messages={messages.length ? messages : [{id: 'objective', role: 'user', text: detail.quest.objective, createdAt: detail.quest.createdAt}]} toolCalls={detail.toolCalls} events={detail.events} requests={detail.requests.filter(request => request.questId === detail.quest.id)} live={streaming} status={detail.quest.status} queueReason={detail.quest.queueReason} activeRunId={detail.quest.activeRunId} assistantLabel={detail.quest.kind === 'guildmaster' ? 'Guildmaster' : 'Quest lead'}/>{needsRecovery && !ownQuestion && <div className="error-card recovery-notice" role="status"><Icon name="alert"/><div><strong>{detail.quest.status === 'interrupted' ? 'Conversation paused' : 'This run needs attention'}</strong><p>{detail.quest.error || 'The run stopped before it finished.'}</p>{<button className="button small" disabled={resumeDisabled} onClick={onResume}><Icon name="retry" size={14}/>Resume {detail.quest.kind === 'guildmaster' ? 'Guildmaster' : 'quest'}</button>}</div></div>}</div>;
}

function QuestInspector({ current }: { current: Quest | null | undefined }) {
  const tools = current?.tools || [];
  const capabilities = [tools.some(tool => ['read', 'grep', 'find', 'ls'].includes(tool)) && 'Read files', tools.some(tool => ['edit', 'write'].includes(tool)) && 'Edit files', tools.includes('bash') && 'Shell'].filter(Boolean).join(' · ');
  return <>
    <div className="inspector-section"><h3>Objective</h3><p className="objective-text">{current?.objective}</p></div>
    <div className="inspector-section"><h3>Project</h3><p>{current?.project?.name || 'No saved project'}</p>{current?.project?.instructions && <div className="quest-project-instructions"><h4>Instructions at quest creation</h4><p>{current.project.instructions}</p></div>}</div>
    {current?.workspaces?.length ? <div className="inspector-section"><h3>Repositories & workspaces</h3>{current.workspaces.map(workspace => <div className="inspector-workspace" key={workspace.repositoryId}><div><strong>{workspace.name}</strong><span>{workspace.mode === 'worktree' ? 'Isolated worktree' : 'Existing checkout'}</span></div><code>{workspace.workspacePath}</code>{workspace.branch && <small>Branch: {workspace.branch}</small>}{workspace.sourcePath !== workspace.workspacePath && <small>Source: {workspace.sourcePath}</small>}</div>)}</div> : <div className="inspector-section"><h3>Workspace</h3><div className="inspector-label"><Icon name={current?.workspaceMode === 'worktree' ? 'branch' : 'folder'} size={16}/>{current && workspaceNames[current.workspaceMode]}</div>{current?.workspacePath && <code className="path-code">{current.workspacePath}</code>}{current?.branch && <div className="branch-label"><Icon name="branch" size={13}/><code>{current.branch}</code></div>}</div>}
    <div className="inspector-section"><h3>Agent</h3><dl><dt>Model</dt><dd className="model-value">{current?.model || 'Default'}</dd><dt>Runs</dt><dd>{current?.runCount || 0}</dd><dt>Access</dt><dd>{capabilities || 'No file or shell tools'}</dd></dl>{tools.includes('bash') && <p className="shell-note">Shell access is unrestricted and is not sandboxed.</p>}</div>
    <div className="inspector-section inspector-session"><h3>Session</h3><dl><dt>Engine</dt><dd>Pi</dd><dt>Quest ID</dt><dd><code>{current?.id}</code></dd></dl>{current?.sessionPath && <div className="inspector-session-path"><h4>Conversation file</h4><code>{current.sessionPath}</code></div>}</div>
  </>;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>(() => {const draft=new URLSearchParams(location.search).get('scheduleDraft');return draft?`schedule:draft:${draft}`:readPreference('guildmaster:view') || 'guildmaster';});
  const [detail, setDetail] = useState<Detail | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [actionError, setActionError] = useState('');
  const [tab, setTab] = useState('conversation');
  const [infoOpen, setInfoOpen] = useState(false);
  const [resultJump, setResultJump] = useState<{ id: string; sequence: number }>();
  const [inspectingAgent, setInspectingAgent] = useState(false);
  useEffect(() => { setInfoOpen(false); }, [view, inspectingAgent]);
  const [projectFilter, setProjectFilter] = useState(() => readPreference('guildmaster:project-filter') || 'all');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [gmModel, setGmModel] = useState(() => readPreference('guildmaster:model') || '');
  const [freshConfirm, setFreshConfirm] = useState(false);
  const [gmDraftVersion, setGmDraftVersion] = useState(0);
  const [gmSuggestion, setGmSuggestion] = useState<{ text: string; sequence: number }>();
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; title: string } | null>(null);
  const [selectedArchives, setSelectedArchives] = useState<string[]>([]);
  const pendingArchiveDeletes = useRef(new Map<string, Quest>());
  useEffect(() => { setSelectedArchives([]); }, [filter, search, projectFilter]);
  const [cancelQuest, setCancelQuest] = useState<{ id: string; title: string; running: boolean } | null>(null);
  const [streaming, setStreaming] = useState<Record<string, LiveMessage | null>>({});
  const streamRevision = useRef<Record<string, number>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refreshNumber = useRef(0);
  const selectedId = view === 'guildmaster' ? bootstrap?.guildmaster?.id : view === 'board' || view === 'settings' || view === 'projects' || view === 'schedules' || view.startsWith('schedule:') ? null : view;
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  const refresh = useCallback(async () => {
    const n = ++refreshNumber.current;
    try {
      const snapshot = await api<Bootstrap>('/api/bootstrap');
      const data = { ...snapshot, projectsSupported: Array.isArray(snapshot.projects), projects: snapshot.projects || [] };
      if (n !== refreshNumber.current) return;
      setBootstrap(previous => {
        if (!pendingArchiveDeletes.current.size) return data;
        // Keep the batch visible while individual deletions emit live updates.
        // Other quests can still receive their normal snapshot updates.
        const remaining = new Map(data.quests.map(quest => [quest.id, quest]));
        const quests = (previous?.quests || []).flatMap(quest => {
          const next = pendingArchiveDeletes.current.get(quest.id) || remaining.get(quest.id);
          remaining.delete(quest.id);
          return next ? [next] : [];
        });
        return { ...data, quests: [...quests, ...remaining.values()] };
      }); setConnectionError('');
      const id = selectedIdRef.current;
      if (id) { try { const revision = streamRevision.current[id] ?? 0; const next = await api<Detail>(`/api/quests/${encodeURIComponent(id)}`); if (n === refreshNumber.current && id === selectedIdRef.current) { setDetail(next); if (revision === (streamRevision.current[id] ?? 0)) setStreaming(previous => ({ ...previous, [id]: next.live ?? null })); } } catch (error) { if ((error as { status?: number }).status === 404 && id === selectedIdRef.current) { setDetail(null); setView('board'); } else throw error; } }
    } catch (err) { if (n === refreshNumber.current) setConnectionError((err as Error).message); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('tool', event => { try { window.dispatchEvent(new CustomEvent('guildmaster:tool', { detail: JSON.parse((event as MessageEvent).data) })); } catch { /* Snapshots recover missed transitions. */ } });
    events.addEventListener('change', () => { setRefreshVersion(v => v + 1); void refresh(); });
    events.addEventListener('open', () => { setStreaming({}); setRefreshVersion(v => v + 1); void refresh(); });
    events.addEventListener('live', event => { try { const data = JSON.parse((event as MessageEvent).data); if (!data.questId) return; streamRevision.current[data.questId] = (streamRevision.current[data.questId] ?? 0) + 1; if (data.live) setStreaming(old => ({ ...old, [data.questId]: data.live })); else { setRefreshVersion(v => v + 1); void refresh(); } } catch { /* Next snapshot restores durable state. */ } });
    return () => events.close();
  }, [refresh]);
  useEffect(() => { setDetail(null); setResultJump(undefined); setTab('conversation'); setInspectingAgent(false); setActionError(''); if (selectedId) void refresh(); }, [selectedId, refresh]);
  useEffect(() => { savePreference('guildmaster:view', view); if (view !== 'guildmaster') setGmSuggestion(undefined); }, [view]);
  const quests = (bootstrap?.quests || []).filter(q => q.kind === 'quest');
  const scopedQuests = quests.filter(q => projectFilter === 'all' || (projectFilter === 'unassigned' ? !q.project?.id : q.project?.id === projectFilter));
  const currentQuests = quests.filter(q => !q.archivedAt);
  const sidebarReview = currentQuests.filter(needsAttention).length;
  const current = detail?.quest || (view === 'guildmaster' ? bootstrap?.guildmaster : quests.find(q => q.id === selectedId));
  const agents = detail?.agents || [];
  const pendingAgentIds = [...new Set([
    ...agents.filter(agent => agent.status === 'awaiting_input').map(agent => agent.id),
    ...(detail?.requests || []).filter(request => request.status === 'pending' && request.questId !== detail?.quest.id).map(request => request.questId),
  ])];
  const agentsNeedingInput = pendingAgentIds.length;
  const pendingRequest = detail && detail.quest.id === selectedId ? detail.requests.find(request => request.status === 'pending' && request.questId === selectedId) : undefined;
  const hasPendingRequest = !!pendingRequest;
  const conversationLoading = !!selectedId && detail?.quest.id !== selectedId;
  const composerPaused = !!connectionError || conversationLoading || (!pendingRequest && (live(current) || current?.status === 'awaiting_input'));
  const messageDraftKey = view === 'guildmaster' ? `guildmaster:${bootstrap?.guildmaster?.id ?? 'new'}` : `quest:${selectedId}`;
  const composerDraftKey = pendingRequest ? `answer:${selectedId}:${pendingRequest.id}` : messageDraftKey;
  const answerLabel = pendingRequest ? `Answer ${view === 'guildmaster' ? 'Guildmaster' : 'quest lead'}’s question` : undefined;
  const chosenGmModel = (bootstrap?.models.some(model => model.id === gmModel) ? gmModel : '') || bootstrap?.guildmaster?.model || bootstrap?.defaultModel || '';
  const displayedGmModel = view === 'guildmaster' && (composerPaused || hasPendingRequest) && current ? current.model : chosenGmModel;
  const canStartFresh = !!bootstrap?.guildmaster && !live(bootstrap.guildmaster) && bootstrap.guildmaster.status !== 'awaiting_input' && !hasPendingRequest && !busy && !connectionError;
  const startFresh = async () => {
    if (!bootstrap?.guildmaster || !canStartFresh) return;
    setBusy(true); setActionError('');
    try {
      await api('/api/guildmaster/new', { questId: bootstrap.guildmaster.id, commandId: commandId() });
      composerDrafts.clear(`guildmaster:${bootstrap.guildmaster.id}`); composerDrafts.clear('guildmaster:new');
      setDetail(null); setResultJump(undefined); setGmSuggestion(undefined); setGmDraftVersion(value => value + 1); await refresh();
    } catch (cause) { setActionError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const clearAgentHistory = () => { const next = { ...history.state }; delete next.guildmasterAgent; delete next.guildmasterProject; history.replaceState(next, ''); };
  const navigate = (next: View) => {
    const proceed=()=>{clearAgentHistory();setInspectingAgent(false);setView(next);if(location.search.includes('scheduleDraft='))history.replaceState(history.state,'',location.pathname);};
    if(window.dispatchEvent(new CustomEvent('guildmaster:before-navigate',{cancelable:true,detail:{proceed}})))proceed();
  };
  const resultMessage = latestResultMessage(detail?.messages || [], current?.result);
  const currentStream = current && Object.hasOwn(streaming, current.id) ? streaming[current.id] : detail?.live;
  const latestGmMessageId = current?.kind === 'guildmaster' && detail
    ? visibleLive(detail.messages, currentStream, current.status, current.activeRunId)?.messageId
      ?? transcriptItems(detail.messages, detail.requests.filter(request => request.questId === current.id)).at(-1)?.id
    : undefined;
  const changeTab = (next: string) => { setResultJump(undefined); clearAgentHistory(); setInspectingAgent(false); setTab(next); };
  const openAgent = (id: string) => {
    clearAgentHistory();
    window.history.replaceState({ ...window.history.state, guildmasterAgent: { questId: selectedId, agentId: id } }, '');
    setResultJump(undefined); setTab('agents');
  };
  const action = async (name: string, id = selectedId) => {
    if (!id || busy) return;
    setBusy(true); setActionError('');
    try { await api(`/api/quests/${encodeURIComponent(id)}/${name}`, { commandId: commandId() }); await refresh(); } catch (err) { setActionError((err as Error).message); } finally { setBusy(false); }
  };
  const deleteArchived = async (ids: string[]) => {
    setDeleteConfirm(null);if(busy)return;setBusy(true);setActionError('');
    pendingArchiveDeletes.current = new Map(quests.filter(quest => ids.includes(quest.id)).map(quest => [quest.id, quest]));
    try {
      const result=await api<{deleted:string[];failed:{id:string;error:string}[]}>('/api/quests/delete',{ids});
      for (const id of result.deleted) composerDrafts.clear(`quest:${id}`);
      pendingArchiveDeletes.current.clear();
      ++refreshNumber.current; // Discard snapshots fetched during the batch.
      setBootstrap(previous => previous ? { ...previous, quests: previous.quests.filter(quest => !result.deleted.includes(quest.id)) } : previous);
      setSelectedArchives(previous=>previous.filter(id=>!result.deleted.includes(id)));
      if(result.failed.length)setActionError(result.failed.map(item=>`${quests.find(q=>q.id===item.id)?.title || 'Quest'}: ${item.error}`).join(' '));
    } catch(error) {setActionError((error as Error).message);} finally {
      pendingArchiveDeletes.current.clear();
      await refresh();
      setBusy(false);
    }
  };
  const send = async (message: string, images?: ImageUpload[]) => {
    if (selectedId) setStreaming(old => ({ ...old, [selectedId]: null }));
    // New conversations retain the app's existing full tool set; existing grants stay on the service.
    if (pendingRequest) { await api(`/api/requests/${encodeURIComponent(pendingRequest.id)}/answer`, { answer: message, images, commandId: commandId() }); }
    else if (view === 'guildmaster') { await api('/api/guildmaster', { message, images, model: chosenGmModel || undefined, tools: bootstrap?.guildmaster ? undefined : ALLOWED_TOOLS, projectId: null, workspaceMode: 'none', commandId: commandId() }); }
    else { await api(`/api/quests/${encodeURIComponent(selectedId!)}/continue`, { message, images, commandId: commandId() }); }
    setTab('conversation'); setGmSuggestion(undefined);
    await refresh();
  };
  const boardQuests = scopedQuests.filter(q => `${q.title} ${q.objective}`.toLowerCase().includes(search.toLowerCase()));
  const currentBoardQuests = boardQuests.filter(q => !q.archivedAt);
  const boardTabs = [
    { value: 'all', label: 'Current', icon: 'grid', count: currentBoardQuests.length },
    { value: 'active', label: 'In progress', icon: 'activity', count: currentBoardQuests.filter(q => live(q)).length },
    { value: 'review', label: 'Needs attention', icon: 'chat', count: currentBoardQuests.filter(needsAttention).length },
    { value: 'accepted', label: 'Accepted', icon: 'check', count: currentBoardQuests.filter(q => q.status === 'accepted').length },
    { value: 'archived', label: 'Archived', icon: 'archive', count: boardQuests.filter(q => !!q.archivedAt).length },
  ];
  const filtered = boardQuests.filter(q => (filter === 'archived' ? !!q.archivedAt : !q.archivedAt && (filter === 'all' || filter === 'active' && live(q) || filter === 'review' && needsAttention(q) || filter === 'accepted' && q.status === 'accepted')));
  useEffect(() => { setSelectedArchives(previous => { const next=previous.filter(id=>filtered.some(q=>q.id===id&&q.archivedAt)); return next.length===previous.length ? previous : next; }); }, [bootstrap?.quests, filter, search, projectFilter]);

  return <div className="app-shell">
    {freshConfirm && <ConfirmDialog title="Start a new conversation?" description="Start with fresh context. Your projects and quests will stay as they are. Any unsent draft will be cleared." confirmLabel="New conversation" cancelLabel="Keep conversation" onClose={() => setFreshConfirm(false)} onConfirm={() => { setFreshConfirm(false); void startFresh(); }}/>}
    {deleteConfirm && <ConfirmDialog title={deleteConfirm.title} description="Permanently deletes the quests, agent conversations, activity, and Guildmaster-owned workspaces. Source repositories and published work are kept. This cannot be undone." confirmLabel="Delete permanently" cancelLabel="Keep archived" onClose={() => setDeleteConfirm(null)} onConfirm={() => void deleteArchived(deleteConfirm.ids)}/>}
    {cancelQuest && <ConfirmDialog title={`Cancel “${cancelQuest.title}”?`} description={cancelQuest.running ? 'This will stop the quest and its running agents. The conversation and workspace will be kept.' : 'This quest will be marked cancelled. The conversation and workspace will be kept.'} confirmLabel="Cancel" onClose={() => setCancelQuest(null)} onConfirm={() => { const id = cancelQuest.id; setCancelQuest(null); void action('cancel', id); }}/>}
    <aside className="sidebar"><button className="brand" onClick={() => navigate('guildmaster')} aria-label="Guildmaster home"><span className="brand-logo" aria-hidden="true"><img className="brand-logo-light" src="/gm-avatar-dark.png" alt=""/><img className="brand-logo-dark" src="/gm-avatar-light.png" alt=""/></span>{bootstrap?.version && <span className="brand-version">v{bootstrap.version}</span>}</button><div className="sidebar-main"><nav><button className={`nav-item ${view === 'guildmaster' ? 'active' : ''}`} onClick={() => navigate('guildmaster')}><Icon name="spark"/><span>Guildmaster</span></button><button className={`nav-item ${view === 'board' ? 'active' : ''}`} onClick={() => navigate('board')}><Icon name="grid"/><span>Quest board</span>{sidebarReview > 0 && <span className="nav-count" title={`${sidebarReview} ${sidebarReview === 1 ? 'quest needs' : 'quests need'} attention`} aria-label={`${sidebarReview} ${sidebarReview === 1 ? 'quest needs' : 'quests need'} attention`}>{sidebarReview}</span>}</button><button className={`nav-item ${view === 'schedules'||view.startsWith('schedule:') ? 'active' : ''}`} onClick={() => navigate('schedules')}><Icon name="calendar"/><span>Schedules</span></button><button className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => navigate('projects')}><Icon name="folder"/><span>Projects</span></button></nav><div className="nav-label quests-label"><span>Current quests</span><span>{`${currentQuests.length} total`}</span></div><div className="recent-quests">{currentQuests.length === 0 ? <p className="sidebar-empty">No current quests.</p> : [...currentQuests].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || a.id.localeCompare(b.id)).slice(0, 12).map(q => <SidebarQuest key={q.id} quest={q} selected={view === q.id} onOpen={navigate}/>)}</div></div><div className="sidebar-bottom"><div className="service-line" role="status" tabIndex={0} aria-describedby="service-connection-help"><span className={`connection-dot ${connectionError ? 'offline' : !bootstrap ? 'connecting' : ''}`}/><span>{connectionError ? 'Service disconnected' : bootstrap ? 'Connected' : 'Connecting…'}</span><span id="service-connection-help" className="service-tooltip" role="tooltip">{connectionError ? 'Cannot reach the local Guildmaster service.' : bootstrap ? 'Connected to the local Guildmaster service that runs quests and saves your conversations.' : 'Connecting to the local Guildmaster service.'}</span></div><div className="sidebar-footer-actions"><button className={`icon-button sidebar-settings ${view === 'settings' ? 'active' : ''}`} aria-label="Settings" aria-describedby="sidebar-settings-help" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="gear" size={18}/><span className="sidebar-settings-tooltip" id="sidebar-settings-help" role="tooltip">Settings</span></button></div></div></aside>
    <main className="main" onClick={event=>{const anchor=(event.target as HTMLElement).closest('a');if(!anchor)return;const url=new URL(anchor.href,location.href);const draft=url.searchParams.get('scheduleDraft');if(url.origin===location.origin&&draft&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();navigate(`schedule:draft:${draft}`);}}}>
      {bootstrap && !bootstrap.models.length && !bootstrap.modelError && view !== 'settings' && <div className="connection-banner" role="status"><Icon name="settings" size={17}/><div><strong>Connect a model provider to begin.</strong><small>Add an API key or use your provider’s browser sign-in in Settings.</small></div><button className="button small" onClick={() => navigate('settings')}>Connect provider</button></div>}{bootstrap && typeof bootstrap.modelError === 'string' && bootstrap.modelError && view !== 'settings' && <div className="connection-banner" role="status"><Icon name="alert" size={17}/><div><strong>Model setup needs attention.</strong><small>{bootstrap.modelError}</small></div><button className="button small" onClick={() => navigate('settings')}>Open settings</button></div>}{connectionError && <div className="connection-banner" role="alert"><Icon name="alert" size={17}/><div><strong>Cannot reach the Guildmaster service.</strong> {connectionError}<small>Your saved work is retained. This page will reconnect automatically when the service is available.</small></div><button className="button small" onClick={() => void refresh()}>Retry</button></div>}
      {!bootstrap ? <div className="startup"><h1>{connectionError ? 'Let’s get connected' : 'Opening your workspace'}</h1><p>{connectionError ? 'Guildmaster needs its local service to load your quests and saved conversations.' : 'Connecting to your local Guildmaster service…'}</p>{!connectionError && <span className="spinner"/>}</div> : view === 'schedules'||view.startsWith('schedule:') ? <Schedules selectedId={view.startsWith('schedule:')?view.slice(9):undefined} onSelect={id=>navigate(id?`schedule:${id}`:'schedules')} onQuest={navigate} projects={bootstrap.projects} models={bootstrap.models} request={api}/> : view === 'projects' ? !bootstrap.projectsSupported ? <div className="projects-page settings-page page-scroll"><div className="page-header-sticky"><div className="page-heading"><div><h1>Projects</h1></div></div></div><section className="settings-section"><h2>Restart the local service to use projects.</h2><p>Restart Guildmaster when your current quests have finished to enable projects. Your saved work will be retained.</p></section></div> : <Projects onAction={async (id, action) => {
        try { const response = await api<{project: Project}>(`/api/projects/${encodeURIComponent(id)}/${action}`, {commandId: commandId()}); await refresh(); return response.project; }
        catch (error) { if ((error as {status?:number}).status === 404) throw new Error('Restart the local service to enable project archiving.'); throw error; }
      }} onGuildmaster={() => navigate('guildmaster')} projects={bootstrap.projects || []} onSave={async (id, body) => { const existingIds = new Set(bootstrap.projects.find(project => project.id === id)?.repositories.map(repo => repo.id)); const response = await api<{ project: Project }>(id ? `/api/projects/${encodeURIComponent(id)}` : '/api/projects', { ...body, repositories: body.repositories.map(repo => existingIds.has(repo.id) ? repo : { name: repo.name, path: repo.path, description: repo.description }), commandId: commandId() }); await refresh(); return response.project; }}/> : view === 'settings' ? <ProviderSettings onChanged={async () => { await refresh(); }}/> : view === 'board' ? <div className="board page-scroll"><div className="page-header-sticky"><div className="page-heading"><div><h1>Quest board</h1></div><BoardControls search={search} onSearch={setSearch} projectFilter={projectFilter} onProjectFilter={value => { setProjectFilter(value); savePreference('guildmaster:project-filter', value); }} projects={bootstrap.projects}/></div><div className="board-toolbar"><div className="filter-tabs">{boardTabs.map(({ value, label, icon, count }) => <button className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)} key={value}><Icon name={icon} size={15}/>{label}<span>{count}</span></button>)}</div></div>{filter === 'archived' && filtered.length > 0 && <div className="archive-bulk-actions"><label><input type="checkbox" checked={filtered.slice(0,100).every(q => selectedArchives.includes(q.id))} disabled={busy} onChange={event => setSelectedArchives(event.target.checked ? filtered.slice(0,100).map(q => q.id) : [])}/>{filtered.length > 100 ? 'Select first 100' : 'Select all'}</label><span>{selectedArchives.length ? `${selectedArchives.length} selected` : ''}</span><button className="button small" disabled={busy || !selectedArchives.length} onClick={() => setDeleteConfirm({ids:selectedArchives,title:`Delete ${selectedArchives.length} archived ${selectedArchives.length === 1 ? 'quest' : 'quests'} permanently?`})}>{busy && pendingArchiveDeletes.current.size ? 'Deleting…' : 'Delete selected'}</button></div>}</div>{actionError && <div className="inline-error" role="alert">{actionError}</div>}{filtered.length ? <div className="quest-grid">{filtered.map(q => <article className="quest-card" data-status={q.status} key={q.id}><button className="quest-card-open" onClick={() => navigate(q.id)}><div className="quest-card-top"><span className="quest-monogram"><Icon name={q.archivedAt ? 'archive' : statusIcons[q.status]} size={22}/></span><Badge status={q.status}/></div><h2>{q.title}</h2><p>{q.objective}</p><div className="quest-card-footer"><span><Icon name={q.workspaceMode === 'worktree' ? 'branch' : 'folder'} size={14}/>{q.project?.name || (q.workspaceMode === 'none' ? 'No workspace' : q.workspacePath?.split('/').filter(Boolean).pop() || workspaceNames[q.workspaceMode])}</span><span className="quest-card-updated">{date(q.updatedAt)}<span className="quest-open-icon"><Icon name="right" size={15}/></span></span></div></button>{(q.archivedAt || ['accepted', 'cancelled'].includes(q.status)) && <div className="quest-card-controls">{!!q.archivedAt && <label className="archive-select"><input type="checkbox" aria-label={`Select ${q.title}`} checked={selectedArchives.includes(q.id)} disabled={busy || selectedArchives.length >= 100 && !selectedArchives.includes(q.id)} onChange={event => setSelectedArchives(previous => event.target.checked ? [...previous,q.id] : previous.filter(id => id !== q.id))}/>Select</label>}<button className="button small" disabled={busy} onClick={() => void action(q.archivedAt ? 'restore' : 'archive', q.id)} aria-label={`${q.archivedAt ? 'Restore' : 'Archive'} ${q.title}`}><Icon name={q.archivedAt ? 'retry' : 'archive'} size={15}/>{q.archivedAt ? 'Restore' : 'Archive'}</button>{!!q.archivedAt && <button className="button small quest-delete" disabled={busy} onClick={() => setDeleteConfirm({ids:[q.id],title:`Delete “${q.title}” permanently?`})}>Delete permanently</button>}</div>}</article>)}</div> : <div className="board-empty"><div className="empty-emblem"><Icon name="grid" size={30}/></div><h2>{filter === 'archived' ? 'No archived quests found' : quests.length ? 'No quests match this view' : 'Make room for your next idea'}</h2><p>{filter === 'archived' ? 'Archive accepted or cancelled quests to keep your board clear. You can restore them here.' : quests.length ? 'Try another filter or a different search.' : 'Tell Guildmaster what you want to accomplish. Your quests will appear here.'}</p>{!quests.length && filter !== 'archived' && <button className="button primary" onClick={() => navigate('guildmaster')}><Icon name="spark" size={16}/> Start a quest with Guildmaster</button>}</div>}<div className="board-footnote"><Icon name="clock" size={15}/><span>Archive finished quests to clear your board. Archived work stays saved until deleted.</span></div></div> : view === 'guildmaster' ? <div className="guildmaster-view"><div className="gm-heading"><div><h1>Guildmaster</h1></div><div className="gm-header-actions">{current && <button className="button small" disabled={!canStartFresh} title={canStartFresh ? 'Start with fresh context' : 'Finish or cancel the current turn first'} onClick={() => setFreshConfirm(true)}><Icon name="plus" size={15}/>New conversation</button>}</div></div><div className="quest-conversation-wrap"><div className="gm-scroll page-scroll">{current ? <Conversation jumpTo={resultJump} detail={detail} streaming={Object.hasOwn(streaming, current.id) ? streaming[current.id] : detail?.live} onResume={() => void action('resume')} resumeDisabled={busy || !!connectionError}/> : <div className="welcome"><h2>What are we working on?</h2><div className="welcome-suggestions" aria-label="Conversation suggestions">{[
      ['Explore a project', 'Explain the architecture and main entry points of '],
      ['Review a pull request', 'Review the pull request at '],
      ['Build a feature', 'Help me build a feature: '],
    ].map(([label, prompt]) => <button key={label} disabled={composerPaused} onClick={() => setGmSuggestion(previous => ({ text: prompt, sequence: (previous?.sequence ?? 0) + 1 }))}>{label}<Icon name="right" size={14}/></button>)}</div></div>}</div>{latestGmMessageId && <LatestResultShortcut label="Latest message" messageId={latestGmMessageId} onJump={() => setResultJump(previous => ({ id: latestGmMessageId, sequence: (previous?.sequence ?? 0) + 1 }))}/>}</div>{actionError && <div className="inline-error">{actionError}</div>}<div className="gm-composer"><Composer key={`${composerDraftKey}:${gmDraftVersion}`} draftKey={composerDraftKey} answerLabel={answerLabel} onSend={send} onStop={live(current) && !pendingRequest ? () => action('cancel') : undefined} stopDisabled={busy || !!connectionError} stopLabel="Stop Guildmaster" suggestion={pendingRequest ? undefined : gmSuggestion} disabled={composerPaused || busy} placeholder={pendingRequest ? 'Share your answer…' : composerPaused ? 'Draft your next message…' : 'Tell Guildmaster what you have in mind…'} footer={<><ModelPicker models={bootstrap.models} value={displayedGmModel} disabled={composerPaused || hasPendingRequest || busy || !bootstrap.models.length} onChange={value => { setGmModel(value); savePreference('guildmaster:model', value); }}/><ContextUsage usage={current?.contextUsage} model={displayedGmModel}/></>}/></div></div> : <div className="quest-view"><div className="quest-header" hidden={inspectingAgent}><Breadcrumbs current="Quest" items={[{ label: 'Quest board', onClick: () => navigate('board') }]}/><div className="quest-title-row"><div><h1>{current?.title || 'Loading quest…'}</h1><div className="quest-subline">{current && <><Badge status={current.status}/>{current.queueReason && <span>{current.queueReason}</span>}{!!current.archivedAt && <span className="archived-label"><Icon name="archive" size={14}/> Archived</span>}<span>Created {date(current.createdAt)}</span>{current.schedule&&(detail?.quest.id===current.id&&detail.scheduleAvailable?<button className="origin-quest-link" onClick={()=>navigate(`schedule:${current.schedule!.id}`)}>Scheduled · {current.schedule.name}</button>:<span>Scheduled · {current.schedule.name}{detail?.quest.id===current.id&&detail.scheduleAvailable===false?' (schedule deleted)':''}</span>)}{detail?.quest.id === current.id && detail.originQuest && <button className="origin-quest-link" onClick={() => navigate(detail.originQuest!.id)}>From: {detail.originQuest.title}</button>}</>}</div></div><div className="quest-actions">{current && (current.archivedAt || ['accepted', 'cancelled'].includes(current.status)) && <button className="button small" disabled={busy} onClick={() => void action(current.archivedAt ? 'restore' : 'archive')}><Icon name={current.archivedAt ? 'retry' : 'archive'} size={15}/>{current.archivedAt ? 'Restore quest' : 'Archive quest'}</button>}{current?.archivedAt && <button className="button small quest-delete" disabled={busy} onClick={() => setDeleteConfirm({ids:[current.id],title:`Delete “${current.title}” permanently?`})}>Delete permanently</button>}{current && !['accepted', 'cancelled'].includes(current.status) && <button className="button small" disabled={busy} onClick={() => setCancelQuest({ id: current.id, title: current.title, running: live(current) })}>Cancel</button>}{current && !current.archivedAt && ['awaiting_review', 'accepted'].includes(current.status) && <QuestAcceptButton key={current.id} accepted={current.status === 'accepted'} disabled={busy || hasPendingRequest || agentsNeedingInput > 0} title={hasPendingRequest || agentsNeedingInput > 0 ? 'Resolve pending questions before accepting this quest.' : undefined} onAccept={() => action('accept')}/>}{current && tab !== 'conversation' && !hasPendingRequest && ['interrupted', 'failed'].includes(current.status) && <button className="button primary small" disabled={busy} onClick={() => void action('resume')}><Icon name="retry" size={16}/> Resume quest</button>}</div></div>{actionError && <div className="inline-error" role="alert">{actionError}</div>}</div><div className="quest-body"><section className="quest-content">{!inspectingAgent && hasPendingRequest && tab !== 'conversation' && <div className="pending-strip"><span>Your input is needed to continue this quest.</span><button className="button small" onClick={() => setTab('conversation')}>Answer question</button></div>}<div className="quest-tabbar" hidden={inspectingAgent}><div className="detail-tabs">{[['conversation', 'Conversation', 'chat'], ['agents', 'Agents', 'team']].map(([id, label, icon]) => <button key={id} className={tab === id ? 'selected' : ''} onClick={() => changeTab(id)}><Icon name={icon} size={15}/>{label}{id === 'agents' && agents.length > 0 && <span>{agents.length}</span>}</button>)}</div><div className="quest-tabbar-actions"><button className="icon-button" aria-label="Quest info" title="Quest info" aria-expanded={infoOpen} aria-controls="quest-info" onClick={() => setInfoOpen(open => !open)}><Icon name="panel" size={18}/></button></div></div>{tab === 'agents' && current ? <Agents key={current.id} onBoard={() => navigate('board')} questId={current.id} parentTitle={current.title} onInspectChange={setInspectingAgent} connectionError={connectionError} agents={agents} liveByQuest={streaming} refreshVersion={refreshVersion} pendingAgentIds={pendingAgentIds} canResume={!current.archivedAt && current.status !== 'cancelled'} onResume={async id => { await api(`/api/quests/${encodeURIComponent(id)}/resume`, { commandId: commandId() }); await refresh(); }}/> : <div className="quest-conversation-wrap"><div className="quest-scroll page-scroll"><Conversation onOpenQuest={navigate} onOpenAgent={openAgent} jumpTo={resultJump} detail={detail} streaming={current && Object.hasOwn(streaming, current.id) ? streaming[current.id] : detail?.live} onResume={() => void action('resume')} resumeDisabled={busy || !!connectionError}/></div>{resultMessage && <LatestResultShortcut messageId={resultMessage.id} onJump={() => setResultJump(previous => ({ id: resultMessage.id, sequence: (previous?.sequence ?? 0) + 1 }))}/>}</div>}{current && <div className="quest-composer" hidden={tab !== 'conversation'}>{current.archivedAt ? <div className="archived-notice"><Icon name="archive" size={18}/><span>This quest is archived. Restore it to send a follow-up.</span></div> : <><Composer key={composerDraftKey} draftKey={composerDraftKey} answerLabel={answerLabel} active={tab === 'conversation'} onSend={send} disabled={composerPaused || busy} placeholder={pendingRequest ? 'Share your answer…' : composerPaused ? 'Draft your next message…' : current.status === 'accepted' || current.status === 'cancelled' ? 'Reopen this quest with a follow-up…' : 'Send feedback or continue the conversation…'}/></>}</div>}</section>{infoOpen && !inspectingAgent && <QuestInfo onClose={() => setInfoOpen(false)} activity={<ActivityFeed events={detail?.events || []}/>} details={<div className="details-pane"><QuestInspector current={current}/></div>}/>}</div></div>}
    </main>
  </div>;
}
