import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { CURRENT_SESSION_VERSION, SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { DeliveryInstruction } from './protocol.ts';
import type { ModelImage } from '../domain/images.ts';

const INTENT = 'guildmaster.delivery.intent.v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (delivery: DeliveryInstruction) => hash(JSON.stringify([delivery.kind, delivery.text, delivery.answer, delivery.toolCallId, ...(delivery.images?.length ? [delivery.images] : [])]));
type Receipt = { id: string; fingerprint: string; answerText?: string };
type Intent = { receipts: Receipt[]; promptHash: string; imagesHash?: string };

export function deliveryDetails(delivery: DeliveryInstruction) {
  return { guildmasterDelivery: { id: delivery.id, fingerprint: fingerprint(delivery) } };
}

/** Refuse damaged sessions before the SDK's tolerant loader can silently skip bad lines. */
export function openDeliverySession(path: string, cwd: string, required = false): SessionManager {
  if (!existsSync(path)) {
    if (required) throw new Error('The saved agent conversation is missing. Restore it before continuing this quest.');
  } else {
    const contents = readFileSync(path, 'utf8');
    if (!contents.trim()) throw new Error('The saved agent conversation is empty. Restore it before continuing this quest.');
    try {
      const records = contents.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      const header = records[0];
      if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id || typeof header.timestamp !== 'string' || typeof header.cwd !== 'string' || (header.version !== undefined && (!Number.isInteger(header.version) || header.version < 1 || header.version > CURRENT_SESSION_VERSION))) throw new Error('Invalid session header');
      if (records.slice(1).some(record => !record || typeof record !== 'object' || typeof record.type !== 'string' || record.type === 'session')) throw new Error('Invalid session entry');
    } catch { throw new Error('The saved agent conversation contains incomplete or invalid data. Restore it before continuing this quest.'); }
  }
  return SessionManager.open(path, undefined, cwd);
}

function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== 'message' || entry.message.role !== 'user') return;
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  return content.map(part => part.type === 'text' ? part.text : '').join('');
}

function savedReceipts(entries: SessionEntry[]): Receipt[] {
  const receipts: Receipt[] = [];
  let intent: Intent | undefined;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === INTENT) {
      const data = entry.data as Intent;
      if (!data || !Array.isArray(data.receipts) || typeof data.promptHash !== 'string' || data.receipts.some(receipt => typeof receipt?.id !== 'string' || typeof receipt.fingerprint !== 'string')) {
        throw new Error('The saved delivery record is invalid. Restore the conversation before continuing.');
      }
      intent = data;
    } else if (intent && entry.type === 'message' && entry.message.role === 'user') {
      const text = userText(entry);
      if (text === undefined || hash(text) !== intent.promptHash) throw new Error('A saved instruction does not match its delivery record. Inspect the conversation before continuing.');
      const images = typeof entry.message.content === 'string' ? [] : entry.message.content.filter(part => part.type === 'image').map(part => ({ type: part.type, mimeType: part.mimeType, data: part.data }));
      if (intent.imagesHash !== (images.length ? hash(JSON.stringify(images)) : undefined)) throw new Error('Saved reference images do not match their delivery record. Inspect the conversation before continuing.');
      receipts.push(...intent.receipts);
      intent = undefined;
    }
    if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'request_user' && !entry.message.isError) {
      const details = entry.message.details as { guildmasterDelivery?: Receipt } | undefined;
      const receipt = details?.guildmasterDelivery;
      if (receipt && typeof receipt.id === 'string' && typeof receipt.fingerprint === 'string') receipts.push({ ...receipt, answerText: entry.message.content.map(part => part.type === 'text' ? part.text : '').join('') });
    }
  }
  return receipts;
}

export class DeliveryAdapter {
  images: ModelImage[] = [];
  private instructions = new Map<string, DeliveryInstruction>();
  private acknowledged = new Set<string>();
  private pending = Promise.resolve();
  private error: Error | undefined;
  private established: boolean;
  private manager: SessionManager; private cwd: string; private acknowledge: (ids: string[]) => void; private failed?: () => void;
  constructor(manager: SessionManager, cwd: string, acknowledge: (ids: string[]) => void, failed?: () => void) {
    this.manager = manager; this.cwd = cwd; this.acknowledge = acknowledge; this.failed = failed;
    this.established = !!manager.getSessionFile() && existsSync(manager.getSessionFile()!);
  }

  track(delivery: DeliveryInstruction) {
    if (!delivery || typeof delivery.id !== 'string' || !delivery.id || !['prompt', 'answer'].includes(delivery.kind) || typeof delivery.text !== 'string' || !delivery.text) throw new Error('Invalid pending instruction.');
    const previous = this.instructions.get(delivery.id);
    if (previous && fingerprint(previous) !== fingerprint(delivery)) throw new Error('A delivery ID was reused for another instruction.');
    this.instructions.set(delivery.id, delivery);
  }

  /** Reconcile only from a freshly reopened native session, never from buffered SDK state. */
  reconcile(): Set<string> {
    const path = this.manager.getSessionFile();
    if (!path || !existsSync(path)) {
      if (this.established) throw new Error('The saved agent conversation disappeared during delivery. Restore it before continuing.');
      return new Set();
    }
    this.established = true;
    const persisted = openDeliverySession(path, this.cwd, true);
    if (persisted.getSessionId() !== this.manager.getSessionId()) throw new Error('The saved conversation changed identity during delivery. Stop and inspect the session before continuing.');
    const receipts = savedReceipts(persisted.getBranch());
    const delivered = new Set<string>();
    for (const receipt of receipts) {
      const instruction = this.instructions.get(receipt.id);
      if (!instruction) continue;
      if (receipt.fingerprint !== fingerprint(instruction)) throw new Error('The saved instruction differs from the pending delivery. Inspect the conversation before continuing.');
      if (receipt.answerText !== undefined && receipt.answerText !== (instruction.answer ?? instruction.text)) throw new Error('The saved answer differs from the pending delivery. Inspect the conversation before continuing.');
      delivered.add(receipt.id);
    }
    const newlyDelivered = [...delivered].filter(id => !this.acknowledged.has(id));
    if (newlyDelivered.length) {
      // Pi appends synchronously but does not fsync. Flush before acknowledging its receipt.
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      this.acknowledge(newlyDelivered);
      for (const id of newlyDelivered) this.acknowledged.add(id);
    }
    return delivered;
  }

  prepare(deliveries: DeliveryInstruction[]): string {
    this.images = [];
    for (const delivery of deliveries) this.track(delivery);
    const saved = this.reconcile();
    const missing = deliveries.filter(delivery => !saved.has(delivery.id));
    this.images = missing.flatMap(delivery => delivery.images ?? []);
    if (!missing.length) return 'Continue from the saved conversation. The previous instructions are already saved; do not repeat completed work. Inspect actual files and tool effects before continuing any interrupted work.';
    const prompt = missing.length === 1 ? missing[0].text
      : `These saved instructions are listed in the order received. Read all instructions before acting; newer instructions supersede conflicting older ones. Inspect the saved conversation and actual effects before retrying interrupted operations. Preserve the wording and constraints of the current request.\n\n${missing.map((delivery, index) => `Instruction ${index + 1}:\n${delivery.text}`).join('\n\n')}`;
    this.manager.appendCustomEntry(INTENT, { receipts: missing.map(delivery => ({ id: delivery.id, fingerprint: fingerprint(delivery) })), promptHash: hash(prompt), ...(this.images.length ? { imagesHash: hash(JSON.stringify(this.images)) } : {}) } satisfies Intent);
    return prompt;
  }

  /** Public message_end listeners run before Pi appends the message. Check on the next turn. */
  afterMessage() {
    this.pending = this.pending.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(() => { this.reconcile(); }).catch(error => {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.failed?.();
    });
  }

  async drain() {
    await this.pending;
    if (this.error) throw this.error;
    this.reconcile();
  }
}
