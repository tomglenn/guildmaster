import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type Quest, type Message, type Activity, type Request, type Project, type ToolCall, type MessagePresentation } from '../domain/types.ts';
import type { QuestSchedule, ScheduleOccurrence, ScheduleConfig } from '../domain/schedules.ts';
import type { DeliveryInstruction } from '../engine/protocol.ts';

export interface Delivery extends DeliveryInstruction {
  questId: string; commandId: string; createdAt: number; deliveredAt?: number; cancelledAt?: number;
}

export class Store {
  db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'state.sqlite'));
    chmodSync(join(dataDir, 'state.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, questId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, questId TEXT NOT NULL, name TEXT NOT NULL, mimeType TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS image_jobs (questId TEXT NOT NULL, commandId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(questId,commandId));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, questId TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, questId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, questId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, questId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, questId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_occurrences (id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS occurrences_schedule ON schedule_occurrences(scheduleId);
      CREATE TABLE IF NOT EXISTS schedule_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS application_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_calls_quest ON tool_calls(questId);
      CREATE INDEX IF NOT EXISTS messages_quest ON messages(questId);
      CREATE INDEX IF NOT EXISTS events_quest ON events(questId);
      CREATE INDEX IF NOT EXISTS deliveries_quest ON deliveries(questId);
      CREATE INDEX IF NOT EXISTS quests_parent ON quests(json_extract(data,'$.parentQuestId'));
    `);
    // Normalize historical finished records into History once. Their close date
    // is also the retention date; never re-close a subsequently reopened quest.
    if (!this.setting('questLifecycleV1')) this.transaction(() => {
      const all = this.list();
      for (const q of all.filter(q => q.kind === 'quest' && q.closedAt === undefined)) {
        const family = [q, ...all.filter(child => child.parentQuestId === q.id)];
        const unsafe = family.some(member => member.activeRunId || ['queued','running','awaiting_input','waiting'].includes(member.status) || this.requests(member.id).some(r => r.status === 'pending') || this.pendingDeliveries(member.id).length);
        if (q.archivedAt !== undefined || (!unsafe && ['accepted','cancelled'].includes(q.status))) {
          q.closedAt = q.archivedAt ?? q.updatedAt; q.closeReason = 'legacy';
          this.db.prepare('UPDATE quests SET data=? WHERE id=?').run(JSON.stringify(q), q.id);
        }
      }
      this.saveSetting('questLifecycleV1', true);
    });
    // Remove retired registry preferences without changing saved quest workspaces.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT id, data FROM projects').all() as { id: string; data: string }[]) {
        const project = JSON.parse(row.data);
        if (!project.repositories.some((repository: Record<string, unknown>) => 'defaultMode' in repository)) continue;
        for (const repository of project.repositories) delete repository.defaultMode;
        this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), row.id);
      }
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Quest | undefined {
    const row = this.db.prepare('SELECT data FROM quests WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list(): Quest[] { return (this.db.prepare('SELECT data FROM quests').all() as { data: string }[]).map(r => JSON.parse(r.data)).sort((a, b) => b.createdAt - a.createdAt); }
  children(parentId: string): Quest[] { return (this.db.prepare("SELECT data FROM quests WHERE json_extract(data,'$.parentQuestId')=?").all(parentId) as { data: string }[]).map(r => JSON.parse(r.data)); }
  projects(): Project[] { return (this.db.prepare('SELECT data FROM projects').all() as { data: string }[]).map(r => JSON.parse(r.data)).sort((a, b) => a.name.localeCompare(b.name)); }
  project(id: string): Project | undefined {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveProject(project: Project) { this.db.prepare('INSERT OR REPLACE INTO projects VALUES (?,?)').run(project.id, JSON.stringify(project)); }
  save(q: Quest) {
    const previous = this.get(q.id);
    const now = Date.now();
    // Activity, tool output and token updates must not reorder the attention inbox.
    q.statusChangedAt = previous && previous.status === q.status
      ? previous.statusChangedAt ?? previous.updatedAt
      : now;
    q.updatedAt = now;
    this.db.prepare('INSERT OR REPLACE INTO quests VALUES (?,?)').run(q.id, JSON.stringify(q));
  }
  message(questId: string, role: Message['role'], text: string, id: string = randomUUID(), presentation?: MessagePresentation) {
    const m: Message = { id, questId, role, text, createdAt: Date.now(), ...(role === 'user' ? { source: 'user' as const } : {}), ...presentation };
    this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?)').run(m.id, questId, JSON.stringify(m)); return m;
  }
  messages(id: string): Message[] { return (this.db.prepare('SELECT data FROM messages WHERE questId=? ORDER BY rowid').all(id) as {data: string}[]).map(r => JSON.parse(r.data)); }
  saveImages(questId: string, images: import('../domain/images.ts').ImageUpload[]): import('../domain/images.ts').ImageAttachment[] {
    return images.map(image => {
      const id = randomUUID(), bytes = Buffer.from(image.data, 'base64');
      this.db.prepare('INSERT INTO images VALUES (?,?,?,?,?)').run(id, questId, image.name, image.mimeType, bytes);
      return { id, name: image.name, mimeType: image.mimeType, size: bytes.length };
    });
  }
  image(questId: string, id: string) {
    return this.db.prepare('SELECT name,mimeType,data FROM images WHERE questId=? AND id=?').get(questId,id) as { name: string; mimeType: import('../domain/images.ts').ImageMimeType; data: Uint8Array } | undefined;
  }
  toolCalls(questId: string): ToolCall[] {
    return (this.db.prepare('SELECT data FROM tool_calls WHERE questId=? ORDER BY rowid').all(questId) as { data: string }[]).map(row => JSON.parse(row.data));
  }
  toolCall(id: string): ToolCall | undefined {
    const row = this.db.prepare('SELECT data FROM tool_calls WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveToolCall(call: ToolCall) { this.db.prepare('INSERT INTO tool_calls VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(call.id, call.questId, JSON.stringify(call)); }
  interruptToolCalls(questId: string, runId?: string) {
    const rows = this.db.prepare("SELECT data FROM tool_calls WHERE questId=? AND json_extract(data,'$.status')='running'").all(questId) as { data: string }[];
    for (const call of rows.map(row => JSON.parse(row.data) as ToolCall)) {
      if (!runId || call.runId === runId) this.saveToolCall({ ...call, status: 'interrupted', endedAt: Date.now() });
    }
  }
  event(questId: string, type: string, detail: string) { this.db.prepare('INSERT INTO events (questId,type,detail,createdAt) VALUES (?,?,?,?)').run(questId, type, detail, Date.now()); }
  events(id: string): Activity[] { return this.db.prepare('SELECT * FROM events WHERE questId=? ORDER BY id DESC LIMIT 300').all(id).reverse() as unknown as Activity[]; }
  request(r: Request) { this.db.prepare('INSERT OR REPLACE INTO requests VALUES (?,?,?)').run(r.id, r.questId, JSON.stringify(r)); }
  getRequest(id: string): Request | undefined { const r = this.db.prepare('SELECT data FROM requests WHERE id=?').get(id) as {data: string} | undefined; return r ? JSON.parse(r.data) : undefined; }
  pendingRequestSummary(): Map<string, {count: number; since: number}> {
    const rows = this.db.prepare("SELECT questId, count(*) AS count, min(json_extract(data,'$.createdAt')) AS since FROM requests WHERE json_extract(data,'$.status')='pending' GROUP BY questId").all() as {questId: string; count: number; since: number}[];
    return new Map(rows.map(row => [row.questId, {count: row.count, since: row.since}]));
  }
  requests(id: string): Request[] { return (this.db.prepare('SELECT data FROM requests WHERE questId=? ORDER BY rowid').all(id) as {data: string}[]).map(r => JSON.parse(r.data)); }
  command(id: string): {fingerprint: string; response: unknown} | undefined { const r = this.db.prepare('SELECT fingerprint,response FROM commands WHERE id=?').get(id) as {fingerprint: string;response: string} | undefined; if (!r) return; const response=JSON.parse(r.response); if(response?.permanentlyDeleted)throw new AppError('This command refers to a permanently deleted quest.',410); return {...r,response}; }
  saveCommand(id: string, fingerprint: string, response: unknown) { this.db.prepare('INSERT INTO commands VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(response)); }
  saveDelivery(delivery: Delivery) { this.db.prepare('INSERT INTO deliveries VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(delivery.id, delivery.questId, JSON.stringify(delivery)); }
  deliveries(questId: string): Delivery[] { return (this.db.prepare('SELECT data FROM deliveries WHERE questId=? ORDER BY rowid').all(questId) as { data: string }[]).map(row => JSON.parse(row.data)); }
  pendingDeliveries(questId: string): Delivery[] { return this.deliveries(questId).filter(delivery => !delivery.deliveredAt && !delivery.cancelledAt); }
  run(id: string, questId: string, data: unknown) {
    const previous=this.getRun(id);const patch=data as Record<string,unknown>;
    if(previous && previous.questId!==questId) throw new AppError('Run belongs to another quest.',403);
    if(previous?.data.execution && patch.execution!==undefined && JSON.stringify(previous.data.execution)!==JSON.stringify(patch.execution)) throw new AppError('Run model selection cannot change.',409);
    this.db.prepare('INSERT INTO runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,questId,JSON.stringify({...previous?.data,...patch}));
  }
  runs(questId: string): { id: string; data: { execution?: import('../domain/model-defaults.ts').ModelSelection; actualExecution?: import('../domain/model-defaults.ts').ModelSelection; connectionGrants?: import('../connections/types.ts').ConnectionGrant[]; prompt?: string; sourcePrompt?: string; commandId?: string; messageId?: string; messageSource?: Message['source']; displayText?: string; queuedAt?: number; startedAt?: number; deliveryIds?: string[] } }[] {
    return (this.db.prepare('SELECT id,data FROM runs WHERE questId=? ORDER BY rowid').all(questId) as { id: string; data: string }[]).map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  }
  lastRun(questId: string): { id: string; data: { execution?: import('../domain/model-defaults.ts').ModelSelection; actualExecution?: import('../domain/model-defaults.ts').ModelSelection; connectionGrants?: import('../connections/types.ts').ConnectionGrant[]; prompt?: string; sourcePrompt?: string } } | undefined {
    const row = this.db.prepare('SELECT id,data FROM runs WHERE questId=? ORDER BY rowid DESC LIMIT 1').get(questId) as { id: string; data: string } | undefined;
    return row ? { id: row.id, data: JSON.parse(row.data) } : undefined;
  }
  getRun(id: string): { questId: string; data: { execution?: import('../domain/model-defaults.ts').ModelSelection; actualExecution?: import('../domain/model-defaults.ts').ModelSelection; messageId?: string; connectionGrants?: import('../connections/types.ts').ConnectionGrant[]; prompt?: string; sourcePrompt?: string; deliveryIds?: string[] } } | undefined {
    const row = this.db.prepare('SELECT questId,data FROM runs WHERE id=?').get(id) as {questId: string; data: string} | undefined;
    return row ? { questId: row.questId, data: JSON.parse(row.data) } : undefined;
  }
  setting<T>(key: string): T | undefined { const row=this.db.prepare('SELECT data FROM application_settings WHERE key=?').get(key) as {data:string}|undefined; return row ? JSON.parse(row.data) : undefined; }
  saveSetting(key: string, value: unknown) { this.db.prepare('INSERT INTO application_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,JSON.stringify(value)); }
  schedules(): QuestSchedule[] {return (this.db.prepare('SELECT data FROM schedules ORDER BY rowid').all() as {data:string}[]).map(row=>JSON.parse(row.data));}
  schedule(id: string): QuestSchedule | undefined {const row=this.db.prepare('SELECT data FROM schedules WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  saveSchedule(value: QuestSchedule) {this.db.prepare('INSERT INTO schedules VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(value));}
  deleteSchedule(id: string) {this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);}
  occurrences(id?: string): ScheduleOccurrence[] {return (id===undefined?this.db.prepare('SELECT data FROM schedule_occurrences ORDER BY rowid DESC').all():this.db.prepare('SELECT data FROM schedule_occurrences WHERE scheduleId=? ORDER BY rowid DESC').all(id) as {data:string}[]).map(row=>JSON.parse((row as {data:string}).data));}
  occurrence(id: string): ScheduleOccurrence | undefined {const row=this.db.prepare('SELECT data FROM schedule_occurrences WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  occurrencePage(id: string, offset=0, limit=20): {items:ScheduleOccurrence[];total:number} {
    const rows=this.db.prepare('SELECT data FROM schedule_occurrences WHERE scheduleId=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(id,limit,offset) as {data:string}[];
    const count=this.db.prepare('SELECT count(*) AS total FROM schedule_occurrences WHERE scheduleId=?').get(id) as {total:number};
    return {items:rows.map(row=>JSON.parse(row.data)),total:count.total};
  }
  preparingOccurrences(id?: string): ScheduleOccurrence[] {
    const rows=(id===undefined?this.db.prepare("SELECT data FROM schedule_occurrences WHERE json_extract(data,'$.state')='preparing'").all():this.db.prepare("SELECT data FROM schedule_occurrences WHERE scheduleId=? AND json_extract(data,'$.state')='preparing'").all(id)) as {data:string}[];
    return rows.map(row=>JSON.parse(row.data));
  }
  saveOccurrence(value: ScheduleOccurrence) {this.db.prepare('INSERT INTO schedule_occurrences VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,value.scheduleId,JSON.stringify(value));}
  saveScheduleDraft(id: string, value: ScheduleConfig) {this.db.prepare('INSERT INTO schedule_drafts VALUES (?,?)').run(id,JSON.stringify(value));}
  scheduleDraft(id: string): ScheduleConfig | undefined {const row=this.db.prepare('SELECT data FROM schedule_drafts WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  deleteQuestRecords(ids: string[]) {
    const deleted=new Set(ids);
    const refers=(value:unknown):boolean=>typeof value==='string' ? deleted.has(value) : Array.isArray(value) ? value.some(refers) : !!value&&typeof value==='object'&&Object.values(value).some(refers);
    this.transaction(()=>{
      for(const row of this.db.prepare('SELECT id,response FROM commands').all() as {id:string;response:string}[]) {
        if(refers(JSON.parse(row.response)))this.db.prepare('UPDATE commands SET response=? WHERE id=?').run(JSON.stringify({permanentlyDeleted:true}),row.id);
      }
      for(const table of ['messages','images','image_jobs','events','requests','runs','deliveries','tool_calls'])for(const id of ids)this.db.prepare(`DELETE FROM ${table} WHERE questId=?`).run(id);
      for(const id of ids)this.db.prepare('DELETE FROM quests WHERE id=?').run(id);
    });
  }
  close() { this.db.close(); }
}
