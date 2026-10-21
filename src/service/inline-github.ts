import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GitHubReadInput {
  operation: 'issue' | 'comments' | 'pull';
  host: string;
  owner: string;
  repository: string;
  number: number;
  page?: number;
}

interface Dependencies {
  run: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number; maxBuffer: number; encoding: 'utf8' }) => Promise<{ stdout: string }>;
  fetch: typeof fetch;
}
const execute = promisify(execFile);
const MAX_RESPONSE = 512 * 1024;
const MAX_PAGES = 3;
const PAGE_SIZE = 20;
class GitHubReadError extends Error {}

function validate(input: GitHubReadInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['operation', 'host', 'owner', 'repository', 'number', 'page'].includes(key))
    || !['issue', 'comments', 'pull'].includes(input.operation) || input.host !== 'github.com'
    || typeof input.owner !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(input.owner)
    || typeof input.repository !== 'string' || !/^[a-z\d_.-]{1,100}$/i.test(input.repository)
    || ['.', '..'].includes(input.repository) || input.repository.startsWith('-')
    || !Number.isSafeInteger(input.number) || input.number < 1
    || (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1 || input.page > MAX_PAGES))
    || (input.operation !== 'comments' && input.page !== undefined && input.page !== 1)) {
    throw new GitHubReadError('Invalid GitHub read input. Use github.com, a repository identity, a positive issue/PR number, and comment pages 1–3 only.');
  }
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubReadError('GitHub returned an invalid response.');
  return value as Record<string, any>;
}

function bounded(value: unknown, bytes: number): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : '';
  // Count JSON escapes too, so control characters cannot inflate the tool receipt.
  const fits = (value: string) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes + 2;
  if (fits(text)) return { text, truncated: false };
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  // Do not split a UTF-16 surrogate pair at the bound.
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return { text: text.slice(0, low), truncated: true };
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function metadata(data: Record<string, any>) {
  return {
    state: bounded(data.state, 30).text,
    author: bounded(data.user?.login, 100).text,
    createdAt: bounded(data.created_at, 40).text,
    updatedAt: bounded(data.updated_at, 40).text,
    closedAt: bounded(data.closed_at, 40).text,
  };
}

/** Boundary injection for tests; neither dependency is supplied by tool callers. */
export function createGitHubReader(dependencies: Dependencies) {
  return async (input: GitHubReadInput, signal: AbortSignal): Promise<object> => {
    input = { ...input };
    validate(input);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      deadline.throwIfAborted();
      const env = { ...process.env };
      // Ignore token/host overrides: use the active account in gh's existing credential store.
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) delete env[key];
      const { stdout } = await dependencies.run('gh', ['auth', 'token', '--hostname', 'github.com'], {
        env, signal: deadline, timeout: 15_000, maxBuffer: 16 * 1024, encoding: 'utf8',
      });
      const token = stdout.trim();
      if (!token || token.length > 16 * 1024 || /\s/.test(token)) throw new GitHubReadError('GitHub login is unavailable. Sign in using gh auth login.');
      const receipt = (value: object): object => JSON.parse(JSON.stringify({ ...value, retrievedAt: new Date().toISOString() },
        (_key, item) => typeof item === 'string' ? item.replaceAll(token, '[REDACTED]') : item));
      async function get(path: string): Promise<{ value: unknown; headers: Headers }> {
        deadline.throwIfAborted();
        let response: Response;
        try {
          response = await dependencies.fetch(`https://api.github.com${path}`, {
            method: 'GET', redirect: 'error', signal: deadline,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          });
        } catch { throw new GitHubReadError('GitHub request failed; redirects are not allowed.'); }
        if (!response.ok) {
          await response.body?.cancel();
          throw new GitHubReadError(`GitHub read failed (HTTP ${response.status}).`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new GitHubReadError('GitHub returned an empty response.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            deadline.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_RESPONSE) throw new GitHubReadError('GitHub response exceeds the bounded read limit.');
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        deadline.throwIfAborted();
        let value: unknown;
        try {
          // Redact decoded strings before bounds can expose a truncated credential prefix.
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'),
            (_key, item) => typeof item === 'string' ? item.replaceAll(token, '[REDACTED]') : item);
        }
        catch { throw new GitHubReadError('GitHub returned invalid JSON.'); }
        return { value, headers: response.headers };
      }
      const account = record((await get('/user')).value).login;
      if (typeof account !== 'string' || !/^[a-z\d-]{1,100}$/i.test(account)) throw new GitHubReadError('GitHub account identity could not be verified.');
      const repository = `${input.owner}/${input.repository}`;
      const page = input.page ?? 1;
      const path = `/repos/${repository}/${input.operation === 'pull' ? 'pulls' : 'issues'}/${input.number}`;
      const url = `https://github.com/${repository}/${input.operation === 'pull' ? 'pull' : 'issues'}/${input.number}`;
      const envelope = {
        source: { host: 'github.com', account, repository, number: input.number, url, authentication: 'existing gh login (may have broad permissions)' },
        untrusted: true,
      };
      if (input.operation === 'comments') {
        const { value, headers } = await get(`${path}/comments?per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(value)) throw new GitHubReadError('GitHub returned invalid comments.');
        const data = value.slice(0, PAGE_SIZE).map(item => {
          const comment = record(item), body = bounded(comment.body, 2048), id = count(comment.id);
          return { id, body: body.text, truncated: body.truncated, ...metadata(comment), url: id === null ? url : `${url}#issuecomment-${id}` };
        });
        // Validate pagination identity, but never fetch a Link header URL.
        const link = headers.get('link') ?? '';
        const next = link.length <= 8192 ? link.match(/<([^>]+)>;\s*rel="next"/)?.[1] : undefined;
        let validNext = false;
        if (next) {
          try {
            const target = new URL(next);
            validNext = target.origin === 'https://api.github.com' && !target.username && !target.password && !target.hash
              && target.pathname === `${path}/comments`
              && target.searchParams.get('page') === String(page + 1)
              && target.searchParams.get('per_page') === String(PAGE_SIZE)
              && [...target.searchParams.keys()].length === 2;
          } catch { /* Untrusted pagination is reported as incomplete, never followed. */ }
        }
        const invalidLink = link.length > 8192 || (/rel="next"/.test(link) && !validNext);
        const hasMore = validNext || invalidLink || value.length > PAGE_SIZE;
        return receipt({
          ...envelope, data,
          coverage: { linkedSourcesFollowed: false, commentKind: 'issue conversation comments only; excludes PR review comments' },
          pagination: {
            page, pageSize: PAGE_SIZE, maxPages: MAX_PAGES, hasMore,
            complete: page === 1 && !hasMore, priorPagesIncluded: page === 1,
            truncated: value.length > PAGE_SIZE || invalidLink || (hasMore && page >= MAX_PAGES),
            continuation: validNext && page < MAX_PAGES ? { operation: 'comments', host: 'github.com', owner: input.owner, repository: input.repository, number: input.number, page: page + 1 } : null,
          },
        });
      }
      const data = record((await get(path)).value);
      const title = bounded(data.title, 1024);
      if (input.operation === 'pull') {
        const branch = (value: any) => ({ ref: bounded(value?.ref, 256).text, sha: bounded(value?.sha, 64).text });
        return receipt({
          ...envelope,
          data: { title: title.text, ...metadata(data), draft: data.draft === true, merged: data.merged === true,
            head: branch(data.head), base: branch(data.base), changedFiles: count(data.changed_files), additions: count(data.additions), deletions: count(data.deletions) },
          truncation: { title: title.truncated },
          coverage: { metadataOnly: true, bodyIncluded: false, diffsIncluded: false, reviewIncluded: false, commentsIncluded: false, linkedSourcesFollowed: false },
        });
      }
      if (data.pull_request !== undefined) throw new GitHubReadError('GitHub returned a pull request; use the pull metadata operation.');
      const body = bounded(data.body, 32 * 1024);
      return receipt({
        ...envelope,
        data: { title: title.text, body: body.text, ...metadata(data), comments: count(data.comments) },
        truncation: { title: title.truncated, body: body.truncated },
        coverage: { commentsIncluded: false, linkedSourcesFollowed: false },
      });
    } catch (error) {
      if (signal.aborted) throw new Error('GitHub read cancelled.');
      if (deadline.aborted) throw new Error('GitHub read timed out.');
      // Never expose subprocess stderr, fetch causes, credentials, or source-provided errors.
      throw new Error(error instanceof GitHubReadError ? error.message : 'GitHub login/read unavailable. Sign in using gh auth login.');
    }
  };
}

export const readGitHub: (input: GitHubReadInput, signal: AbortSignal) => Promise<object> = createGitHubReader({
  run: async (file, args, options) => execute(file, args, options),
  fetch: (...args) => globalThis.fetch(...args),
});
