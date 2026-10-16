import type { ImageUpload } from '../domain/images.ts';

export interface DraftImage extends ImageUpload { id: string }
export interface DraftContent { text: string; images: DraftImage[] }
export interface DraftSnapshot extends DraftContent { ready: boolean; sending: boolean }
export interface DraftPersistence {
  load(key: string): Promise<DraftContent | undefined>;
  save(key: string, draft: DraftContent): Promise<void>;
}
type Submission = { content: DraftContent; revision: number };
type Entry = {
  snapshot: DraftSnapshot; revision: number; listeners: Set<() => void>;
  loading?: Promise<void>; writes: Promise<void>; submission?: Submission;
};

export class ComposerDrafts {
  private entries = new Map<string, Entry>();
  private persistence: DraftPersistence;
  constructor(persistence: DraftPersistence) { this.persistence = persistence; }
  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: { text: '', images: [], ready: false, sending: false }, revision: 0, listeners: new Set(), writes: Promise.resolve() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  get(key: string) { return this.entry(key).snapshot; }
  subscribe(key: string, listener: () => void) {
    const entry = this.entry(key); entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }
  private publish(entry: Entry, snapshot: DraftSnapshot) {
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }
  load(key: string): Promise<void> {
    const entry = this.entry(key);
    if (entry.snapshot.ready) return Promise.resolve();
    if (!entry.loading) {
      const revision = entry.revision;
      entry.loading = this.persistence.load(key).catch(() => undefined).then(saved => {
        if (entry.revision !== revision) return;
        this.publish(entry, { text: saved?.text ?? '', images: saved?.images ?? [], ready: true, sending: false });
      });
    }
    return entry.loading;
  }
  private persist(key: string, entry: Entry) {
    const { text, images } = entry.snapshot;
    // Serialize writes, so a slower old save cannot resurrect a sent draft.
    // If browser storage is unavailable, navigation still uses the memory copy.
    entry.writes = entry.writes.then(() => this.persistence.save(key, { text, images })).catch(() => {});
  }
  update(key: string, change: (draft: DraftContent) => DraftContent) {
    const entry = this.entry(key);
    if (!entry.snapshot.ready) return;
    const next = change(entry.snapshot);
    if (next.text === entry.snapshot.text && next.images === entry.snapshot.images) return;
    entry.revision++;
    this.publish(entry, { ...entry.snapshot, ...next }); this.persist(key, entry);
  }
  clear(key: string) {
    const entry = this.entry(key); entry.revision++; entry.submission = undefined;
    this.publish(entry, { text: '', images: [], ready: true, sending: false }); this.persist(key, entry);
  }
  beginSend(key: string): Submission | undefined {
    const entry = this.entry(key), draft = entry.snapshot;
    if (!draft.ready || draft.sending || (!draft.text.trim() && !draft.images.length)) return;
    const submission = { content: { text: draft.text, images: draft.images }, revision: entry.revision };
    entry.submission = submission; this.publish(entry, { ...draft, sending: true });
    return submission;
  }
  finishSend(key: string, submission: Submission, success: boolean) {
    const entry = this.entry(key);
    if (entry.submission !== submission) return;
    entry.submission = undefined;
    if (success && entry.revision === submission.revision) this.clear(key);
    else this.publish(entry, { ...entry.snapshot, sending: false });
  }
  async saved(key: string) { await this.entry(key).writes; }
}
