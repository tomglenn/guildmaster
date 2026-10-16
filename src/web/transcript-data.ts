export type TranscriptRequest = { id: string; question: string; status: 'pending' | 'answered'; createdAt: string | number; answer?: string; answerMessageId?: string };
export type TranscriptMessage = { attachments?: import('../domain/images').ImageAttachment[]; source?: 'user' | 'guildmaster' | 'quest_lead' | 'schedule' | 'system'; displayText?: string; id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string | number; request?: TranscriptRequest; answerFor?: string };
export type LiveMessage = { runId: string; messageId: string; text: string };
export type ToolCall = { id: string; runId: string; tool: string; detail: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: number; endedAt?: number; output?: string };
export function transcriptItems(messages: TranscriptMessage[], requests: TranscriptRequest[] = []): TranscriptMessage[] {
  const answers = new Map(requests.filter(request => request.answerMessageId).map(request => [request.answerMessageId, request]));
  const conversation = messages.filter(message => message.source !== 'system').map(message => {
    const request = answers.get(message.id);
    return request ? { ...message, text: request.answer ?? message.displayText ?? message.text, answerFor: request.id } : { ...message, text: message.displayText ?? message.text };
  });
  for (const request of new Map(requests.map(request => [request.id, request])).values()) {
    conversation.push({ id: `question:${request.id}`, role: 'assistant', text: request.question, createdAt: request.createdAt, request });
  }
  return conversation.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export type ProgressEvent = { type: string; detail: unknown; createdAt: string | number };

export function visibleActivity<T extends Pick<ProgressEvent, 'type' | 'detail'>>(events: T[]): T[] {
  return events.filter(event => event.type !== 'model' || !['Waiting for model response.', 'Model is thinking.'].includes(String(event.detail)));
}

const toolProgress: Record<string, string> = {
  read: 'Reading files…', grep: 'Searching code…', find: 'Finding files…', ls: 'Exploring files…',
  bash: 'Running a command…', edit: 'Editing files…', write: 'Writing files…',
  set_repository_revision: 'Preparing repository revision…', create_workspace: 'Preparing workspace…',
  delegate_task: 'Delegating work…', continue_agent: 'Delegating work…', wait_for_agents: 'Waiting for agents…',
  list_agents: 'Checking agents…', inspect_agent: 'Checking an agent…',
  prepare_schedule: 'Preparing a schedule…', create_followup_quest: 'Starting a follow-up quest…', create_quest: 'Starting a quest…', continue_quest: 'Continuing a quest…', list_quests: 'Checking quests…', inspect_quest: 'Checking a quest…',
  archive_project: 'Archiving a project…', restore_project: 'Restoring a project…',
  list_projects: 'Finding a project…', inspect_project: 'Checking a project…', register_project: 'Saving a project…', add_project_repositories: 'Updating a project…',
};

export function conversationProgress(status: string, calls: ToolCall[], events: ProgressEvent[], activeRunId?: string, queueReason?: string, agents: { status: string }[] = []): string | null {
  const visibleAgentProgress = agents.some(agent => ['running', 'queued'].includes(agent.status));
  if (status === 'queued') return queueReason ? queueReason + '…' : 'Waiting for an available worker…';
  if (status === 'waiting') return visibleAgentProgress ? null : 'Waiting for agents…';
  if (status !== 'running') return null;
  const currentCalls = activeRunId ? calls.filter(call => call.runId === activeRunId) : [];
  const running = currentCalls.filter(call => call.status === 'running' && call.tool !== 'request_user');
  if (running.length) {
    const labels = new Set(running.map(call => toolProgress[call.tool] || 'Using tools…'));
    const label = labels.size === 1 ? [...labels][0] : 'Running tools…';
    return label === 'Waiting for agents…' && visibleAgentProgress ? null : label;
  }
  // Activity has no run ID: only consider events after the latest run-start marker.
  const start = events.findLastIndex(event => event.type === 'run_started');
  const model = start < 0 ? undefined : events.slice(start + 1).findLast(event => event.type === 'model');
  const lastTool = Math.max(0, ...currentCalls.map(call => call.endedAt ?? call.startedAt));
  if (model && new Date(model.createdAt).getTime() >= lastTool && typeof model.detail === 'string') {
    if (model.detail.startsWith('Model is thinking')) return 'Thinking…';
    if (model.detail.startsWith('Model retry')) return 'Retrying model request…';
    if (model.detail === 'Compacting the saved conversation.') return 'Condensing conversation…';
  }
  return 'Thinking…';
}

export function visibleLive(messages: TranscriptMessage[], live: LiveMessage | null | undefined, status: string, activeRunId?: string) {
  if (!live?.text || !['running', 'awaiting_input'].includes(status) || (activeRunId && live.runId !== activeRunId)) return null;
  return messages.some(message => message.id === live.messageId) ? null : live;
}

// Match the saved outcome, not later commentary from a follow-up still in progress.
export function latestResultMessage(messages: TranscriptMessage[], result?: string): TranscriptMessage | undefined {
  if (!result) return undefined;
  return messages.findLast(message => message.role === 'assistant' && message.source !== 'system' && message.text === result);
}

/** Compact navigation shows the overall quest lifecycle, not scheduler internals. */
export function sidebarStatus(status: string): string {
  return ['queued','running','waiting'].includes(status) ? 'running' : status;
}

export type Delegation = { id: string; agentId?: string; questLink?: boolean; followup?: boolean; title: string; status: string; createdAt: string | number };
export type ConversationEntry =
  | { kind: 'message'; id: string; message: TranscriptMessage }
  | { kind: 'delegation'; id: string; agent: Delegation }
  | { kind: 'tools'; id: string; calls: ToolCall[] };

/** Interleave operational evidence with the conversation, keeping consecutive calls together. */
export function conversationEntries(messages: TranscriptMessage[], calls: ToolCall[] = [], agents: Delegation[] = []): ConversationEntry[] {
  const entries = [
    ...messages.map(message => ({ kind: 'message' as const, id: `message:${message.id}`, time: new Date(message.createdAt).getTime(), message })),
    ...[...new Map(calls.map(call => [call.id, call])).values()].map(call => ({ kind: 'call' as const, id: `tool:${call.id}`, time: call.startedAt, call })),
    ...[...new Map(agents.map(agent => [agent.id, agent])).values()].map(agent => ({ kind: 'delegation' as const, id: `delegation:${agent.id}`, time: new Date(agent.createdAt).getTime(), agent })),
  ].sort((a, b) => a.time - b.time);
  const result: ConversationEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'call') {
      const previous = result.at(-1);
      if (previous?.kind === 'tools' && previous.calls.at(-1)?.runId === entry.call.runId) previous.calls.push(entry.call);
      else result.push({ kind: 'tools', id: entry.id, calls: [entry.call] });
    } else result.push(entry);
  }
  return result;
}

export function compactToolCalls(calls: ToolCall[], expanded = false): { calls: ToolCall[]; hidden: number } {
  const visible = expanded ? calls : calls.filter((call, index) => index >= calls.length - 3 || call.status === 'running');
  return { calls: visible, hidden: calls.length - visible.length };
}

export function toolPresentation(tool: string): { label: string; icon: string } {
  const names: Record<string, [string, string]> = {
    read: ['Read', 'document'], grep: ['Search', 'search'], find: ['Find', 'search'], ls: ['List', 'folder'],
    bash: ['Run', 'terminal'], edit: ['Edit', 'edit'], write: ['Write', 'edit'],
    load_skill: ['Load skill', 'document'], read_guidance: ['Read guidance', 'document'],
    slack_read_thread: ['Read Slack thread', 'chat'], slack_read_channel: ['Read Slack channel', 'chat'],
  };
  const [label, icon] = names[tool] ?? [tool.replaceAll('_', ' '), 'activity'];
  return { label: label.charAt(0).toUpperCase() + label.slice(1), icon };
}

/** Merge direct transitions with snapshots without reverting completed/interrupted calls. */
export function mergeToolCalls(snapshot: ToolCall[], updates: ToolCall[]): ToolCall[] {
  const calls = new Map(snapshot.map(call => [call.id, call]));
  for (const call of updates) {
    const previous = calls.get(call.id);
    if (!previous || (call.endedAt ?? 0) > (previous.endedAt ?? 0) ||
        ((call.endedAt ?? 0) === (previous.endedAt ?? 0) && (previous.status === 'running' || call.status !== 'running'))) calls.set(call.id, call);
  }
  return [...calls.values()].sort((a,b) => a.startedAt - b.startedAt);
}

/** A successful continue is a new handoff to an existing agent, not a new agent. */
export function delegationEntries(agents: Delegation[], calls: ToolCall[]): Delegation[] {
  return agents.flatMap(agent => {
    const followups = calls.filter(call => call.tool === 'continue_agent' && call.status === 'completed' && call.detail === agent.id)
      .sort((a,b) => a.startedAt - b.startedAt);
    return [
      { ...agent, agentId: agent.id, status: followups.length ? 'previous' : agent.status },
      ...followups.map((call, index) => ({ ...agent, agentId: agent.id, id: call.id, followup: true,
        createdAt: call.endedAt ?? call.startedAt, status: index === followups.length - 1 ? agent.status : 'previous' })),
    ];
  });
}
