export interface DeliveryInstruction {
  id: string;
  kind: 'prompt' | 'answer';
  text: string;
  attachments?: import('../domain/images.ts').ImageAttachment[];
  images?: import('../domain/images.ts').ModelImage[];
  answer?: string;
  toolCallId?: string;
}

export interface QuestBoardSnapshot {
  capturedAt: number;
  quests: { id: string; title: string; status: string; archivedAt?: number; projectName?: string }[];
  omitted: number;
}

export interface WorkerSpec {
  questId: string;
  parentQuestId?: string;
  questBoard?: QuestBoardSnapshot;
  runId: string;
  cwd: string;
  sourcePath?: string;
  guidancePath?: string;
  workspacePolicy?: import('../domain/types.ts').WorkspacePolicy;
  isolation?: import('../domain/types.ts').IsolationRequest[];
  preparedWorkspaces?: import('../domain/types.ts').PreparedWorkspace[];
  outputPath?: string;
  project?: { id: string; name: string; instructions: string };
  workspaces?: import('../domain/types.ts').QuestWorkspace[];
  workspaceMode?: 'existing' | 'worktree' | 'none';
  prompt: string;
  deliveries?: DeliveryInstruction[];
  requireExistingSession?: boolean;
  sessionPath: string;
  agentDir?: string;
  model?: string;
  modelIdleTimeoutMs?: number;
  tools: string[];
  instructions?: string;
  role: 'quest' | 'guildmaster' | 'delegate';
  serviceUrl?: string;
  serviceToken?: string;
  /** Scoped local image capability; never a provider API credential. */
  imageToken?: string;
  connectionToken?: string;
  connectionGrants?: import('../connections/types.ts').ConnectionGrant[];
}

export type WorkerEvent =
  | { type: 'context'; tokens: number | null; contextWindow: number; percent: number | null; model?: string }
  | { type: 'ready' }
  | { type: 'delivered'; ids: string[] }
  | { type: 'yielded' }
  | { type: 'session'; sessionPath: string; sessionId: string; model?: string }
  | { type: 'message_start'; messageId: string }
  | { type: 'message'; role: 'assistant'; text: string; messageId?: string }
  | { type: 'delta'; text: string; messageId?: string }
  | { type: 'tool_start'; toolCallId: string; tool: string; detail: string }
  | { type: 'tool_end'; toolCallId: string; tool: string; output: string; isError: boolean }
  | { type: 'activity'; tool: string; detail: string }
  | { type: 'question'; id: string; question: string }
  | { type: 'complete'; text: string }
  | { type: 'error'; error: string };

export type WorkerCommand =
  | { type: 'answer'; id: string; answer: string; delivery?: DeliveryInstruction }
  | { type: 'cancel' };

export const BUILTIN_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] as const;

export function validateToolNames(names: string[]): string[] {
  if (!Array.isArray(names) || names.some((name) => !BUILTIN_TOOLS.includes(name as typeof BUILTIN_TOOLS[number]))) {
    throw new Error('Unsupported tool selection. Available tools: ' + BUILTIN_TOOLS.join(', '));
  }
  return [...new Set(names)];
}
