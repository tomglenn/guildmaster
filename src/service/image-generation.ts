import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { openImageWithoutSymlinks } from './image-file.ts';
import { imageAttemptAllowance } from './image-request.ts';
import { basename, join, resolve, sep } from 'node:path';
import { AppError, type Quest } from '../domain/types.ts';
import type { ImageAttachment, ImageMimeType } from '../domain/images.ts';
import type { Store } from './store.ts';

export interface ImageGenerationInput {
  commandId: string; prompt: string; count?: number; quality?: ImageQuality; size?: ImageSize;
  references?: { imageId?: string; path?: string }[];
  reviseImageId?: string; authorization: string;
}
export interface GeneratedImage extends ImageAttachment {
  questId: string; commandId: string; conceptIndex: number; rootImageId: string; url: string;
  version: number; parentImageId?: string; createdAt: number; mock: boolean;
}
export interface ImageJob {
  commandId: string; questId: string; fingerprint: string; authorizationHash: string; budgetFamilyId?: string;
  status: 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
  count: number; quality?: ImageQuality; size?: ImageSize; createdAt: number; endedAt?: number; outputs: GeneratedImage[]; error?: string;
}
type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
type ImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
interface Settings { enabled: boolean; mock: boolean; model: string; defaultQuality: ImageQuality; defaultSize: ImageSize }
const DEFAULTS: Settings = { enabled: false, mock: true, model: 'gpt-image-1.5', defaultQuality: 'auto', defaultSize: 'auto' };
const QUALITIES = ['auto','low','medium','high'];
const SIZES = ['auto','1024x1024','1536x1024','1024x1536'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
// A small valid PNG; mock output is deliberately labelled, never represented as a rendered UI.
const MOCK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string, status = 400): never { throw new AppError(message, status); }
function mime(bytes: Uint8Array): ImageMimeType {
  const b = Buffer.from(bytes);
  if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.readUInt32BE(8)===13 && b.toString('ascii',12,16)==='IHDR' && b.readUInt32BE(16)>0 && b.readUInt32BE(20)>0) {
    let offset=8, hasData=false;
    while(offset+12<=b.length) {
      const length=b.readUInt32BE(offset), type=b.toString('ascii',offset+4,offset+8);
      if(length>b.length-offset-12) break;
      if(type==='IDAT') hasData=true;
      offset+=length+12;
      if(type==='IEND' && length===0 && offset===b.length && hasData) return 'image/png';
    }
  }
  if (b.length >= 4 && b[0]===255 && b[1]===216 && b[2]===255 && b[b.length-2]===255 && b[b.length-1]===217) return 'image/jpeg';
  if (b.length >= 20 && b.readUInt32LE(4)===b.length-8 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP' && ['VP8 ','VP8L','VP8X'].includes(b.toString('ascii',12,16))) return 'image/webp';
  return fail('Only valid PNG, JPEG or WebP images are supported.');
}
function validateImage(bytes: Uint8Array, expected?: string, limit = MAX_BYTES) {
  if (!bytes.length || bytes.length > limit) fail(`Image exceeds the ${limit / 1024 / 1024} MB limit.`, 413);
  const detected = mime(bytes);
  if (expected && detected !== expected) fail('Image MIME type does not match its bytes.');
  return detected;
}

/** Independent Images API credentials and durable, locally deduplicated jobs. Never retries upstream. */
export class ImageGeneration {
  private store: Store;
  private credentialPath: string;
  private key = '';
  private fetcher: typeof fetch;
  private changed: () => void;
  private timeoutMs: number;
  private controllers = new Map<string, AbortController>();
  private closed = false;
  constructor(options: { store: Store; dataDir: string; changed?: () => void; fetch?: typeof fetch; timeoutMs?: number }) {
    this.store = options.store;
    this.changed = options.changed ?? (() => {});
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.credentialPath = join(options.dataDir, 'image-api-key.json');
    try { this.key = JSON.parse(readFileSync(this.credentialPath, 'utf8')).apiKey ?? ''; chmodSync(this.credentialPath, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read private image credentials.'); }
    this.store.db.exec('CREATE TABLE IF NOT EXISTS image_jobs (questId TEXT NOT NULL, commandId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(questId,commandId))');
    const rows = this.store.db.prepare('SELECT data FROM image_jobs').all() as { data: string }[];
    for (const row of rows) {
      const job: ImageJob = JSON.parse(row.data);
      if (job.status === 'running') {
        job.status = 'uncertain'; job.endedAt = Date.now();
        job.error = 'Service restarted during generation. Upstream outcome and charges are unknown; no automatic retry.';
        this.persist(job); this.activity(job, job.error);
      }
    }
  }
  settingsView() {
    const saved = this.store.setting<Settings>('image-generation');
    // Do not carry forward retired budget fields from earlier local configuration.
    const { enabled, mock, model, defaultQuality, defaultSize } = { ...DEFAULTS, ...saved };
    return { enabled, mock, model, defaultQuality, defaultSize, hasApiKey: !!this.key, configured: !!this.key, provider: 'openai' as const };
  }
  saveSettings(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid image settings.');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(k => !['enabled','mock','model','apiKey','defaultQuality','defaultSize'].includes(k))) fail('Unknown image setting.');
    const current = this.settingsView();
    for (const k of ['enabled','mock']) if (value[k] !== undefined && typeof value[k] !== 'boolean') fail(`Invalid ${k} setting.`);
    if (value.model !== undefined && !['gpt-image-1.5','gpt-image-1','gpt-image-1-mini'].includes(value.model as string)) fail('Only gpt-image-1.5, gpt-image-1 and gpt-image-1-mini are supported.');
    if (value.defaultQuality !== undefined && !QUALITIES.includes(value.defaultQuality as string)) fail('Invalid default image quality.');
    if (value.defaultSize !== undefined && !SIZES.includes(value.defaultSize as string)) fail('Invalid default image size for the selected models.');
    if (value.apiKey !== undefined) {
      if (typeof value.apiKey !== 'string' || value.apiKey.length > 512 || /[\r\n\0]/.test(value.apiKey)) fail('Invalid API key.');
      const temp = `${this.credentialPath}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ apiKey: value.apiKey.trim() }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.credentialPath); this.key = value.apiKey.trim();
    }
    this.store.saveSetting('image-generation', { enabled: value.enabled ?? current.enabled, mock: value.mock ?? current.mock, model: value.model ?? current.model, defaultQuality: value.defaultQuality ?? current.defaultQuality, defaultSize: value.defaultSize ?? current.defaultSize  });
    this.notify(); return this.settingsView();
  }
  list(questId: string): ImageJob[] {
    return (this.store.db.prepare('SELECT data FROM image_jobs WHERE questId=? ORDER BY rowid').all(questId) as {data:string}[]).map(r => JSON.parse(r.data));
  }
  private persist(job: ImageJob) { this.store.db.prepare('INSERT INTO image_jobs VALUES (?,?,?) ON CONFLICT(questId,commandId) DO UPDATE SET data=excluded.data').run(job.questId, job.commandId, JSON.stringify(job)); }
  private notify() { try { this.changed(); } catch { /* UI notifications must not change a paid operation's outcome. */ } }
  private activity(job: ImageJob, detail: string) { this.store.event(job.questId, `image_${job.status}`, detail); this.notify(); }
  private familyRoot(quest: Quest): string {
    const visited=new Set<string>(); let current=quest;
    for (;;) {
      if (visited.has(current.id)) fail('Invalid quest provenance cycle.',403);
      visited.add(current.id);
      const parent=current.parentQuestId ?? current.sourceRequest?.questId;
      if (!parent) return current.id;
      const saved=this.store.get(parent);
      if (!saved) return parent;
      current=saved;
    }
  }
  private directAuthorizations(quest: Quest, visited=new Set<string>()): string[] {
    if (visited.has(quest.id)) return [];
    visited.add(quest.id);
    const direct=this.store.messages(quest.id).filter(m=>m.role==='user' && (!m.source || m.source==='user')).map(m=>m.text);
    // Only persisted provenance is authority. Agent-authored objectives and quoted JSON are never parsed.
    // A Guildmaster sourceRequest is service-created from the originating run's real user sourcePrompt.
    if (quest.sourceRequest && quest.sourceRequest.role !== 'quest') direct.push(quest.sourceRequest.text);
    // GM feedback preserves its original user text separately from the delegated prompt/brief.
    for (const run of this.store.runs(quest.id)) {
      if (run.data.messageSource==='guildmaster' && typeof run.data.sourcePrompt==='string' && run.data.sourcePrompt!==run.data.prompt) direct.push(run.data.sourcePrompt);
    }
    // Delegates/follow-up quests inherit authority, never authority asserted in their own brief.
    const origin=quest.parentQuestId ?? (quest.sourceRequest?.role==='quest' ? quest.sourceRequest.questId : undefined);
    const parent=origin ? this.store.get(origin) : undefined;
    if (parent) direct.push(...this.directAuthorizations(parent,visited));
    return direct;
  }
  private authorization(quest: Quest, text: string) {
    if (!this.directAuthorizations(quest).includes(text)) fail('Authorization must exactly quote a direct user request for this quest.', 403);
    if (/\b(?:do not|don't|never|without|no)\s+(?:\w+\s+){0,3}(?:generate|create|image|mockup)/i.test(text) || !/\b(?:generate|create|include|produce|draw|render|provide|make|revise|edit|update)\b[\s\S]{0,160}\b(?:concept|image|mockup|illustration|visual deliverable)s?\b/i.test(text)) fail('Explicit user authorization for visual deliverables is required.', 403);
    return hash(text);
  }
  private async reference(quest: Quest, ref: { imageId?: string; path?: string }) {
    if (!ref || typeof ref !== 'object' || (!!ref.imageId === !!ref.path) || Object.keys(ref).some(k => !['imageId','path'].includes(k))) fail('Each reference requires exactly one imageId or path.');
    if (ref.imageId) {
      if (typeof ref.imageId !== 'string') fail('Invalid image ID.');
      const image = this.store.image(quest.id, ref.imageId);
      if (!image) fail('Reference image was not found in this quest.', 404);
      validateImage(image.data, image.mimeType, MAX_OUTPUT_BYTES); return image;
    }
    const path = ref.path;
    if (typeof path !== 'string' || !path || path.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(path)) fail('Reference URLs and invalid paths are not allowed.');
    const roots = [...new Set([quest.workspacePath, quest.outputPath, ...(quest.workspaces ?? []).map(w => w.workspacePath), ...(quest.preparedWorkspaces ?? []).flatMap(w => [w.workspacePath,w.outputPath])].filter((r): r is string => !!r))];
    const canonical = (await Promise.all(roots.map(r => realpath(r).catch(() => undefined)))).filter((r): r is string => !!r);
    for (const root of roots) {
      const requested = resolve(root, path);
      if (!roots.some(r => requested.startsWith(resolve(r) + sep))) continue;
      const file = await realpath(requested).catch(() => undefined);
      if (!file) continue;
      if (!canonical.some(r => file.startsWith(r + sep))) fail('Reference is outside the quest workspace.',403);
      // Reject symlinks in every component, closing the realpath/open race.
      const handle = await openImageWithoutSymlinks(file);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_BYTES) fail('Reference must be a regular image file of at most 5 MB.',413);
        // Bounded read even if another process grows the file after stat.
        const data = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        const bytes = data.subarray(0, bytesRead);
        return { name: basename(file), mimeType: validateImage(bytes), data: bytes };
      } finally { await handle.close(); }
    }
    return fail('Reference file not found in this quest.',404);
  }
  async generate(quest: Quest, input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage[]> {
    if (this.closed) fail('Image generation service is closed.',503);
    if (!input || typeof input.commandId !== 'string' || !input.commandId.trim() || input.commandId.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(input.commandId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000 || typeof input.authorization !== 'string' || input.authorization.length > 100000) fail('Invalid image generation input.');
    // The server scopes the quest; reload it so caller-supplied objectives/provenance/roots cannot grant authority.
    quest=this.store.get(quest.id) ?? fail('Quest not found.',404);
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 10) fail('OpenAI supports 1–10 images per API call. Batch larger authorized requests without reducing their total.');
    if (input.quality !== undefined && !QUALITIES.includes(input.quality)) fail('Unsupported quality for the configured GPT image models.');
    if (input.size !== undefined && !SIZES.includes(input.size)) fail('Unsupported size for the configured GPT image models.');
    if (input.references !== undefined && (!Array.isArray(input.references) || input.references.length > 4)) fail('At most four references are allowed.');
    const fingerprint = hash(JSON.stringify({ prompt: input.prompt, count, references: input.references ?? [], reviseImageId: input.reviseImageId ?? null, quality: input.quality ?? null, size: input.size ?? null, authorization: input.authorization }));
    const prior = this.list(quest.id).find(j => j.commandId === input.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('Command ID was already used with different input.',409);
      if (prior.status === 'succeeded') return prior.outputs;
      fail(prior.error ?? 'This command is already in progress. No duplicate request was sent.',409);
    }
    const identical = this.list(quest.id).find(job => job.fingerprint === fingerprint && job.status === 'succeeded');
    if (identical) return identical.outputs;
    const settings = this.settingsView();
    if (!settings.enabled) fail('Image generation is disabled.',409);
    if (!settings.mock && !this.key) fail('Configure a separate OpenAI API key for image generation.',409);
    const authorizationHash = this.authorization(quest, input.authorization);
    if (signal?.aborted) fail('Image generation cancelled before dispatch.',409);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    // Register before asynchronous reference checks so close() cancels pending preparation too.
    const activeId = randomUUID(); this.controllers.set(activeId,controller);
    let job: ImageJob | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    let rejectedStatus: number | undefined;
    try {
      const jobs = this.list(quest.id);
      const parent = input.reviseImageId ? jobs.flatMap(j => j.outputs).find(i => i.id === input.reviseImageId) : undefined;
      if (input.reviseImageId && !parent) fail('Revision target must be a generated image in this quest.',404);
      const refs = [...(parent ? [{imageId:parent.id}] : []), ...(input.references ?? [])];
      if (refs.length > 4) fail('At most four references including the revision target are allowed.');
      const references = await Promise.all(refs.map(ref => this.reference(quest,ref)));
      if (controller.signal.aborted || this.closed) fail('Image generation cancelled before dispatch.',409);
      // Recheck after asynchronous preparation. Reserve the budget and command synchronously.
      const budgetFamilyId=this.familyRoot(quest);
      this.store.transaction(()=>{
        const latest=this.list(quest.id);
        if (latest.some(j=>j.commandId===input.commandId)) fail('This command is already in progress.',409);
        if (latest.some(j => j.fingerprint === fingerprint && ['running','uncertain'].includes(j.status))) fail('An identical request is in progress or has an unknown upstream outcome. A new tool-call ID does not authorize a paid retry; obtain a new direct user request.',409);
        const all=(this.store.db.prepare('SELECT data FROM image_jobs').all() as {data:string}[]).map(row=>JSON.parse(row.data) as ImageJob);
        const budget=all.filter(j=>j.authorizationHash===authorizationHash && (j.budgetFamilyId ?? (this.store.get(j.questId) ? this.familyRoot(this.store.get(j.questId)!) : j.questId))===budgetFamilyId);
        // Internal loop protection, not a user-configured output budget. Explicit
        // large requests get enough calls even when an agent generates one at a time.
        if (budget.length >= imageAttemptAllowance(input.authorization)) fail('Image generation stopped to prevent an agent loop. Report the saved results and ask the user before making further attempts; do not silently reduce a requested deliverable.',409);
        job={commandId:input.commandId,questId:quest.id,fingerprint,authorizationHash,budgetFamilyId,status:'running',count,quality:input.quality ?? settings.defaultQuality,size:input.size ?? settings.defaultSize,createdAt:Date.now(),outputs:[]};
        this.persist(job);
      });
      this.activity(job!, `Generating ${count} ${settings.mock ? 'mock ' : ''}concept image(s).`);
      timer = setTimeout(abort, this.timeoutMs);
      const work = async (): Promise<string[]> => {
        if (settings.mock) return Array.from({length:count}, () => MOCK_PNG);
        const fields = { model:settings.model, prompt:input.prompt, n:count, quality:input.quality ?? settings.defaultQuality, size:input.size ?? settings.defaultSize, output_format:'png' };
        const maxResponse = Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 * count + 1024 * 1024;
        const headers: Record<string,string> = { Authorization:`Bearer ${this.key}` };
        let body: string | FormData;
        if (references.length) {
          body = new FormData();
          for (const [key,value] of Object.entries(fields)) body.append(key,String(value));
          for (const ref of references) body.append('image[]',new Blob([new Uint8Array(ref.data)],{type:ref.mimeType}),ref.name);
        } else { headers['Content-Type']='application/json'; body=JSON.stringify(fields); }
        dispatched = true;
        const response = await this.fetcher(`https://api.openai.com/v1/images/${references.length ? 'edits' : 'generations'}`, { method:'POST', headers, body, signal:controller.signal, redirect:'error' });
        if (!response.ok) {
          rejectedStatus=response.status;
          void response.body?.cancel().catch(()=>{});
          fail(`Image provider rejected the request (HTTP ${response.status}). No retry was sent.`,502);
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) fail('Invalid image provider response.',502);
        if (Number(response.headers.get('content-length')) > maxResponse) fail('Image provider response exceeded the limit.',502);
        const reader = response.body?.getReader();
        if (!reader) fail('Empty image provider response.',502);
        const chunks: Uint8Array[] = []; let size=0;
        try {
          for (;;) {
            const {done,value}=await reader.read(); if(done) break;
            size+=value.length; if(size>maxResponse) fail('Image provider response exceeded the limit.',502);
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(()=>{}); }
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(result.data) || result.data.length !== count) fail('Unexpected image provider output count.',502);
        return result.data.map((image: {b64_json?:unknown}) => {
          if (typeof image.b64_json !== 'string' || image.b64_json.length > Math.ceil(MAX_OUTPUT_BYTES/3)*4 || image.b64_json.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.b64_json)) fail('Invalid image provider output.',502);
          validateImage(Buffer.from(image.b64_json,'base64'),'image/png',MAX_OUTPUT_BYTES); return image.b64_json;
        });
      };
      // Fetch implementations (and stalled body streams) need not honor AbortSignal.
      const images = await new Promise<string[]>((resolve,reject) => {
        const cancelled=()=>reject(new Error('local-abort'));
        controller.signal.addEventListener('abort',cancelled,{once:true});
        if(controller.signal.aborted) cancelled();
        else work().then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',cancelled));
      });
      if (controller.signal.aborted) throw new Error('local-abort');
      const nextConcept = Math.max(0,...this.list(quest.id).flatMap(j=>j.outputs.map(i=>i.conceptIndex)))+1;
      this.store.transaction(() => {
        const nextVersion = parent ? Math.max(...this.list(quest.id).flatMap(j=>j.outputs).filter(o=>o.rootImageId===parent.rootImageId).map(o=>o.version)) + 1 : 1;
        const attachments = this.store.saveImages(quest.id,images.map((data,i)=>({name:`${settings.mock?'mock-':''}concept-${parent?.conceptIndex ?? nextConcept+i}-v${parent ? nextVersion+i : 1}.png`,mimeType:'image/png',data})));
        job!.outputs = attachments.map((image,i)=>({ ...image, url:`/api/quests/${encodeURIComponent(quest.id)}/images/${encodeURIComponent(image.id)}`, questId:quest.id, commandId:input.commandId, conceptIndex:parent?.conceptIndex ?? nextConcept+i, rootImageId:parent?.rootImageId ?? image.id, version:parent ? nextVersion+i : 1, ...(parent?{parentImageId:parent.id}:{}), createdAt:Date.now(), mock:settings.mock }));
        job!.status='succeeded'; job!.endedAt=Date.now(); this.persist(job!);
        this.store.message(quest.id,'assistant',`${settings.mock ? 'Mock placeholder' : 'Generated concept'} image${count>1?'s':''} — not screenshots of implemented UI.\n${job!.outputs.map(o=>`Concept ${o.conceptIndex}, version ${o.version}${o.parentImageId ? ` (revision of ${o.parentImageId})` : ''}: ${o.id}`).join('\n')}`,`image-job-${hash(quest.id+':'+input.commandId)}`,{attachments:job!.outputs});
      });
      this.activity(job!,`Saved ${count} concept image(s).`); return job!.outputs;
    } catch (error) {
      if (job) {
        job.status = dispatched && rejectedStatus === undefined ? 'uncertain' : controller.signal.aborted ? 'cancelled' : 'failed'; job.endedAt=Date.now();
        // Never expose upstream response bodies, prompt data, credentials or fetch error strings.
        job.error = rejectedStatus !== undefined ? `Image provider rejected the request (HTTP ${rejectedStatus}). No retry was sent.` : dispatched ? 'Image request did not complete locally. Upstream outcome and charges may be unknown; no automatic retry.' : 'Image generation failed or was cancelled before provider dispatch.';
        this.persist(job); this.activity(job,job.error);
        throw new AppError(job.error,502);
      }
      throw error;
    } finally { if(timer) clearTimeout(timer); signal?.removeEventListener('abort',abort); controller.abort(); this.controllers.delete(activeId); }
  }
  close() { this.closed=true; for(const controller of this.controllers.values()) controller.abort(); }
}
