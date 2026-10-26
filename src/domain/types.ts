export type Status = 'queued' | 'running' | 'awaiting_input' | 'awaiting_review' | 'accepted' | 'interrupted' | 'failed' | 'cancelled' | 'waiting' | 'completed';
export type WorkspacePolicy = 'shared' | 'isolated';
export type WorkspaceMode = 'existing' | 'worktree' | 'none';
export interface ProjectRepository { id: string; name: string; path: string; description?: string }
export interface Project {
  id: string; name: string; aliases: string[]; instructions: string; repositories: ProjectRepository[];
  createdAt: number; updatedAt: number; archivedAt?: number;
}
export interface ProjectSnapshot { id: string; name: string; instructions: string }
export interface RepositorySelection { repositoryId: string; mode?: 'existing' | 'worktree' }
export interface IsolationRequest { repositoryId: string; commit: string }
export interface QuestWorkspace {
  repositoryId: string; name: string; description?: string; sourcePath: string; workspacePath: string;
  mode: 'existing' | 'worktree'; branch?: string; commit?: string;
}
export interface PreparedWorkspace extends QuestWorkspace { id: string; guidanceRevision: string; outputPath: string }
export interface DelegationSource { role?: 'quest' | 'guildmaster'; questId: string; runId: string; text: string }
export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; model?: string; updatedAt: number }
export interface Quest {
  id: string; title: string; objective: string; kind: 'quest' | 'guildmaster' | 'delegate'; status: Status;
  workspaceMode: WorkspaceMode; workspacePath: string; sourcePath?: string; branch?: string;
  model: string; tools: string[]; instructions: string; createdAt: number; updatedAt: number; statusChangedAt?: number;
  sessionPath: string; error?: string; result?: string; runCount: number; activeRunId?: string;
  execution?: import('./model-defaults.ts').ModelSelection;
  modelPreference?: import('./model-defaults.ts').ModelPreference;
  teamModels?: import('./model-defaults.ts').ModelDefaults;
  contextUsage?: ContextUsage;
  guidanceRevision?: string; sessionStartRun?: number; sessionEstablished?: boolean;
  schedule?: import('./schedules.ts').ScheduleOrigin;
  sourceRequest?: DelegationSource; archivedAt?: number;
  closedAt?: number; closeReason?: 'accepted' | 'closed' | 'legacy'; reopenedAt?: number;
  acceptance?: { acceptedAt: number; runCount: number; result?: string };
  inbox?: { included: boolean; group: 'input' | 'attention' | 'working'; label: string; since: number; pendingQuestions: number; active: number };
  project?: ProjectSnapshot; workspaces?: QuestWorkspace[];
  workspacePolicy?: WorkspacePolicy;
  preparedWorkspaces?: PreparedWorkspace[]; isolation?: IsolationRequest[]; outputPath?: string;
  queueReason?: string;
  parentQuestId?: string; waitForAgentIds?: string[]; consumedDelegateRuns?: Record<string, number>; routedQuestionIds?: string[];
  agentSummary?: { total: number; active: number; needsAttention: number };
}
export type MessageSource = 'user' | 'guildmaster' | 'quest_lead' | 'schedule' | 'system';
export interface MessagePresentation { source?: MessageSource; displayText?: string; attachments?: import('./images.ts').ImageAttachment[] }
export interface Message extends MessagePresentation { id: string; questId: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: number }
export interface LiveMessage { runId: string; messageId: string; text: string }
export interface ToolCall {
  id: string; questId: string; runId: string; tool: string; detail: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: number; endedAt?: number; output?: string;
}
export interface Activity { id: number; questId: string; type: string; detail: string; createdAt: number }
export interface Request { id: string; questId: string; runId: string; toolCallId?: string; question: string; status: 'pending' | 'answered' | 'dismissed'; answer?: string; answerMessageId?: string; createdAt: number }
export interface CreateQuest {
  images?: import('./images.ts').ImageUpload[];
  workspacePolicy?: WorkspacePolicy; revisions?: IsolationRequest[];
  title?: string; objective: string; workspaceMode?: WorkspaceMode; workspacePath?: string;
  model?: string; tools?: string[]; instructions?: string; commandId: string;
  projectId?: string | null; repositories?: RepositorySelection[];
}
export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const MAX_SUBAGENTS = 5;
export const DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls'];
export const ALLOWED_TOOLS = [...DEFAULT_TOOLS, 'write', 'edit', 'bash'];
export function writes(q: Pick<Quest, 'tools' | 'kind'>) { return q.kind !== 'guildmaster' && q.tools.some(t => ['edit', 'write', 'bash'].includes(t)); }
