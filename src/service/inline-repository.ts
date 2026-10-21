import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface RepositoryReadInput {
 operation: 'read' | 'search';
 commit: string;
 path?: string;
 startLine?: number;
 endLine?: number;
 query?: string;
}

// These are per-call ceilings; the broker must additionally enforce shared run budgets.
const LIMITS = { deadlineMs: 15_000, treeBytes: 2 * 1024 * 1024, fileBytes: 256 * 1024,
 scanBytes: 2 * 1024 * 1024, files: 200, lines: 400, matches: 50, resultBytes: 100 * 1024 };
const decoder = new TextDecoder('utf-8', { fatal: true });

function validPath(path: unknown): path is string {
 return typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 1024 &&
  !isAbsolute(path) && !/[\\\x00-\x1f\x7f:]/.test(path) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('-'));
}

function sensitivePath(path: string): boolean {
 return path.split('/').some(part => /^(?:\.git|\.git-credentials|\.gitconfig|\.env(?:[.-].*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|\.pypirc|\.docker|\.config|\.authinfo|\.htpasswd|\.vault-token|\.boto|\.s3cfg|gcloud|credentials?(?:[.-].*)?|(?:secrets?|tokens?)(?:[.-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|kubeconfig|\.kube)$/i.test(part) ||
  /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(part));
}

function textContent(buffer: Buffer): string | undefined {
 let text: string;
 try { text = decoder.decode(buffer); } catch { return undefined; }
 if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return undefined;
 return text;
}

// Defense in depth, not a claim that arbitrary secrets can be detected reliably.
function containsSecret(text: string): boolean {
 return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s/:]+:[^\s/@]+@|\b(?:password|passwd|(?:api|secret|private)[_-]?key|(?:(?:access|auth|refresh)[_-]?)?token|client[_-]?secret|secret)\b["']?\s*[:=]\s*["']?[^\s"',;}{]{4,}/i.test(text);
}

/** Read only immutable committed blobs. Never use worktree content, textconv, grep, or filters. */
export async function readRepository(sourcePath: string, input: RepositoryReadInput, signal: AbortSignal): Promise<object> {
 if (!input || !['read', 'search'].includes(input.operation) || typeof input.commit !== 'string' || !/^[a-fA-F0-9]{40}$/.test(input.commit))
  throw new Error('An operation and exact 40-hex commit are required');
 if (input.path !== undefined && !validPath(input.path)) throw new Error('Invalid repository-relative path');
 if (input.path && sensitivePath(input.path)) throw new Error('Sensitive repository paths are excluded');
 if (input.operation === 'read' && !input.path) throw new Error('Read requires a path');
 if (input.operation === 'search' && (typeof input.query !== 'string' || !input.query.length || Buffer.byteLength(input.query) > 256 || /[\x00-\x1f\x7f]/.test(input.query)))
  throw new Error('Search requires a single-line literal query of at most 256 bytes');
 const start = input.startLine ?? 1, end = input.endLine ?? start + LIMITS.lines - 1;
 if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > LIMITS.lines)
  throw new Error('Invalid line range (maximum 400 lines)');
 if (input.operation === 'search' && (input.startLine !== undefined || input.endLine !== undefined)) throw new Error('Search does not accept a line range');
 if (input.operation === 'read' && input.query !== undefined) throw new Error('Read does not accept a query');
 const revision = input.commit.toLowerCase(), deadline = Date.now() + LIMITS.deadlineMs;
 const check = () => {
  signal.throwIfAborted();
  if (Date.now() >= deadline) throw new Error('Repository read deadline exceeded');
 };
 const git = async (args: string[], maxBuffer: number): Promise<Buffer> => {
  check();
  return new Promise((resolve, reject) => {
   execFile('git', ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never',
    ...args], { cwd: sourcePath, encoding: 'buffer', maxBuffer, signal,
    timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: '/dev/null',
     GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
     GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
   }, (error, stdout) => {
    if (error) reject(signal.aborted ? signal.reason ?? new Error('Repository read aborted') : new Error('Git object read failed or exceeded its output/deadline limit'));
    else resolve(stdout);
   });
  });
 };
 if ((await git(['cat-file', '-t', revision], 1024)).toString().trim() !== 'commit') throw new Error('Revision must identify a commit');
 const tree = await git(['ls-tree', '-r', '-z', '--full-tree', revision], LIMITS.treeBytes);
 const entries: { path: string; oid: string; mode: string }[] = [];
 for (const record of tree.toString('utf8').split('\0')) {
  if (!record) continue;
  const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
  if (!match) throw new Error('Unsupported repository tree');
  // Invalid UTF-8 paths cannot be round-tripped, and are never passed back to Git.
  if (match[3].includes('\ufffd')) continue;
  entries.push({ mode: match[1], oid: match[2], path: match[3] });
 }
 // Per-call caching also avoids spawning hundreds of processes for duplicate blobs.
 const sizes = new Map<string, number>(), blobs = new Map<string, Buffer>();
 const skipped = { excluded: 0, unsupported: 0, oversized: 0, binary: 0, secrets: 0 };
 let filesScanned = 0, bytesScanned = 0;
 const reasons: string[] = [];
 const load = async (entry: typeof entries[number]): Promise<string | undefined> => {
  check();
  if (sensitivePath(entry.path) || !validPath(entry.path)) { skipped.excluded++; return; }
  if (!['100644', '100755'].includes(entry.mode)) { skipped.unsupported++; return; }
  const size = sizes.get(entry.oid) ?? Number((await git(['cat-file', '-s', entry.oid], 1024)).toString().trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid blob size');
  sizes.set(entry.oid, size);
  if (size > LIMITS.fileBytes) { skipped.oversized++; return; }
  if (bytesScanned + size > LIMITS.scanBytes) { reasons.push('scan_byte_limit'); return; }
  const buffer = blobs.get(entry.oid) ?? await git(['cat-file', 'blob', entry.oid], LIMITS.fileBytes);
  blobs.set(entry.oid, buffer);
  filesScanned++; bytesScanned += buffer.length;
  const text = textContent(buffer);
  if (text === undefined) { skipped.binary++; return; }
  if (containsSecret(text)) { skipped.secrets++; return; }
  return text;
 };
 const coverage = () => ({ filesScanned, bytesScanned, skipped,
  complete: reasons.length === 0 && Object.values(skipped).every(count => count === 0),
  scope: input.path ?? '', exclusionsApplied: true, reasons });
 if (input.operation === 'read') {
  const entry = entries.find(entry => entry.path === input.path);
  if (!entry) throw new Error('Committed file not found');
  const text = await load(entry);
  if (text === undefined) throw new Error('File excluded: sensitive, binary, oversized, or unsupported');
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const selected: { line: number; text: string }[] = [];
  let bytes = 0;
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
   const row = { line: i + 1, text: lines[i] };
   const size = Buffer.byteLength(JSON.stringify(row));
   if (bytes + size > LIMITS.resultBytes - 4096) { reasons.push('result_byte_limit'); break; }
   selected.push(row); bytes += size;
  }
  if (start > 1 || end < lines.length) reasons.push('line_range');
  return { operation: 'read', revision, path: entry.path, totalLines: lines.length,
   startLine: selected[0]?.line ?? null, endLine: selected.at(-1)?.line ?? null,
   lines: selected, truncated: reasons.length > 0, coverage: coverage() };
 }
 const matches: { path: string; line: number; text: string }[] = [];
 let resultBytes = 0, candidatesVisited = 0;
 const candidates = entries.filter(entry => !input.path || entry.path === input.path || entry.path.startsWith(input.path + '/'));
 for (const entry of candidates) {
  signal.throwIfAborted();
  if (Date.now() >= deadline) { reasons.push('deadline_limit'); break; }
  if (filesScanned >= LIMITS.files) { reasons.push('file_limit'); break; }
  candidatesVisited++;
  let text: string | undefined;
  try { text = await load(entry); }
  catch {
   signal.throwIfAborted();
   reasons.push(Date.now() >= deadline ? 'deadline_limit' : 'object_read_failed');
   break;
  }
  if (reasons.length) break;
  if (text === undefined) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
   if (!lines[i].includes(input.query!)) continue;
   const match = { path: entry.path, line: i + 1, text: lines[i] };
   const size = Buffer.byteLength(JSON.stringify(match));
   if (resultBytes + size > LIMITS.resultBytes - 4096) { reasons.push('result_byte_limit'); break; }
   matches.push(match); resultBytes += size;
   if (matches.length >= LIMITS.matches) { reasons.push('match_limit'); break; }
  }
  if (reasons.length) break;
 }
 return { operation: 'search', revision, path: input.path ?? '', query: input.query, matches,
  truncated: reasons.length > 0, coverage: { ...coverage(), candidates: candidates.length, candidatesVisited } };
}
