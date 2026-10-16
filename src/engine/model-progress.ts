import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export interface ModelProgressOptions {
  idleTimeoutMs?: number;
  onActivity: (detail: string) => void;
  onTimeout: (detail: string) => void;
}

/** Watches model requests, excluding tools, user questions, retry delays, and compaction. */
export class ModelProgress {
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private stopped = false;
  private thinkingReported = false;
  private readonly idleTimeoutMs: number;
  private readonly onActivity: ModelProgressOptions['onActivity'];
  private readonly onTimeout: ModelProgressOptions['onTimeout'];

  constructor(options: ModelProgressOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) throw new Error('Model idle timeout must be a positive number of milliseconds.');
    this.onActivity = options.onActivity;
    this.onTimeout = options.onTimeout;
  }

  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = false;
  }

  private reset() {
    if (!this.active || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.clear();
      this.onTimeout(`The model sent no response or progress for ${Math.ceil(this.idleTimeoutMs / 1000)} seconds. The request was stopped; resume to retry the saved request.`);
    }, this.idleTimeoutMs);
    this.timer.unref?.();
  }

  observe(event: AgentSessionEvent): void {
    if (this.stopped || ('parentToolCallId' in event && event.parentToolCallId)) return;
    if (event.type === 'turn_start') {
      this.active = true;
      this.thinkingReported = false;
      this.reset();
      this.onActivity('Waiting for model response.');
    } else if (event.type === 'message_start' && event.message.role === 'assistant') {
      this.reset();
    } else if (event.type === 'message_update' && event.message.role === 'assistant') {
      this.reset();
      if (this.active && event.assistantMessageEvent.type === 'thinking_delta' && !this.thinkingReported) {
        this.thinkingReported = true;
        this.onActivity('Model is thinking.');
      }
    } else if ((event.type === 'message_end' && event.message.role === 'assistant') || event.type === 'agent_end' || event.type === 'tool_execution_start') {
      this.clear();
    } else if (event.type === 'auto_retry_start') {
      this.clear();
      const error = event.errorMessage.replace(/\s+/g, ' ').trim().slice(0, 300);
      this.onActivity(`Model retry ${event.attempt}/${event.maxAttempts} in ${Math.ceil(event.delayMs / 1000)} seconds.${error ? ` ${error}` : ''}`);
    } else if (event.type === 'compaction_start') {
      this.clear();
      this.onActivity('Compacting the saved conversation.');
    } else if (event.type === 'compaction_end') {
      this.onActivity(event.aborted ? 'Conversation compaction interrupted.' : event.errorMessage ? 'Conversation compaction failed.' : 'Conversation compaction finished.');
    }
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }
}
