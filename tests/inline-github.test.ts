import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubReader, type GitHubReadInput } from '../src/service/inline-github.ts';

const input: GitHubReadInput = { operation: 'issue', host: 'github.com', owner: 'octocat', repository: 'hello-world', number: 42 };
const signal = () => new AbortController().signal;
const json = (value: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(value), { headers });
function harness(source: unknown = { number: 42, title: 'Issue', body: 'Untrusted source', user: { login: 'author' } }, headers?: Record<string, string>) {
  const commands: any[] = [], requests: { url: string; options?: RequestInit }[] = [];
  const read = createGitHubReader({
    run: async (...args: any[]) => { commands.push(args); return { stdout: 'test-secret-token\n' }; },
    fetch: (async (url: string | URL | Request, options?: RequestInit) => {
      requests.push({ url: String(url), options });
      return json(String(url).endsWith('/user') ? { login: 'active-account' } : source, headers);
    }) as typeof fetch,
  });
  return { read, commands, requests };
}

test('rejects malformed or injected inputs before credential access', async () => {
  for (const change of [
    { host: 'evil.example' }, { host: 'github.com/path' }, { owner: '--hostname' },
    { owner: 'a/b' }, { owner: 'a%2fb' }, { repository: '..' }, { repository: 'a?x=1' },
    { repository: 'a\\\\b' }, { operation: 'graphql' }, { number: 0 }, { number: 1.5 },
    { number: Number.MAX_SAFE_INTEGER + 1 }, { page: 0 }, { page: 4 }, { page: 1.2 },
    { path: '/user' }, { url: 'https://evil.example' }, { page: 2 },
  ]) {
    const h = harness();
    await assert.rejects(h.read({ ...input, ...change } as GitHubReadInput, signal()), /Invalid GitHub read input/);
    assert.equal(h.commands.length, 0);
  }
  for (const value of [null, [], 'issue']) {
    await assert.rejects(harness().read(value as any, signal()), /Invalid GitHub read input/);
  }
});

test('bounds issue text and returns explicit truncation and coverage', async () => {
  const h = harness({ title: 't'.repeat(10_000), body: '😀'.repeat(30_000), arbitrary: 'not returned', comments: 200, user: { login: 'author' } });
  const result = await h.read(input, signal()) as any;
  assert.ok(Buffer.byteLength(result.data.body) <= 32 * 1024);
  assert.ok(Buffer.byteLength(result.data.title) <= 1024);
  assert.equal(result.truncation.body, true);
  assert.equal(result.truncation.title, true);
  assert.equal(result.coverage.commentsIncluded, false);
  assert.equal(result.data.comments, 200);
  assert.equal(result.data.arbitrary, undefined);
  assert.doesNotMatch(result.data.body, /\uFFFD/);
});

test('comments return one bounded page with locally constructed continuation and citations', async () => {
  const comments = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, body: 'x'.repeat(10_000), html_url: 'https://evil.example', user: { login: 'writer' } }));
  const h = harness(comments, { link: '<https://api.github.com/repos/octocat/hello-world/issues/42/comments?per_page=20&page=2>; rel="next"' });
  const result = await h.read({ ...input, operation: 'comments' }, signal()) as any;
  assert.equal(result.data.length, 20);
  assert.ok(result.data.every((item: any) => Buffer.byteLength(item.body) <= 2048 && item.truncated));
  assert.equal(result.data[0].url, 'https://github.com/octocat/hello-world/issues/42#issuecomment-1');
  assert.deepEqual(result.pagination.continuation, { ...input, operation: 'comments', page: 2 });
  assert.equal(result.pagination.hasMore, true);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.maxPages, 3);
  assert.equal(h.requests[1].url, 'https://api.github.com/repos/octocat/hello-world/issues/42/comments?per_page=20&page=1');
  assert.equal(h.requests.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100 * 1024);
});

test('escaped source text cannot inflate serialized receipts above the output bound', async () => {
  const comments = Array.from({ length: 20 }, (_, id) => ({ id, body: '\u0000'.repeat(3000) }));
  const result = await harness(comments).read({ ...input, operation: 'comments' }, signal());
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 100 * 1024);
});

test('comments stop after page three and disclose missing coverage', async () => {
  const h = harness([{ id: 1, body: 'hi' }], { link: '<https://api.github.com/repos/octocat/hello-world/issues/42/comments?per_page=20&page=4>; rel="next"' });
  const result = await h.read({ ...input, operation: 'comments', page: 3 }, signal()) as any;
  assert.equal(result.pagination.continuation, null);
  assert.equal(result.pagination.truncated, true);
  assert.equal(result.pagination.hasMore, true);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.priorPagesIncluded, false);
});

test('comments never follow source URLs or pagination redirects', async () => {
  const h = harness([], { link: '<https://evil.example/steal>; rel="next"' });
  const result = await h.read({ ...input, operation: 'comments' }, signal()) as any;
  assert.equal(h.requests.length, 2);
  assert.equal(result.pagination.continuation, null);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.truncated, true);
});

test('empty final comment pages disclose complete coverage only from page one', async () => {
  for (const page of [1, 2]) {
    const result = await harness([]).read({ ...input, operation: 'comments', page }, signal()) as any;
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.complete, page === 1);
    assert.equal(result.pagination.continuation, null);
  }
});

test('pull reads metadata only, not body, patches, review, or source links', async () => {
  const h = harness({ title: 'PR', body: 'not metadata', diff_url: 'https://evil.example/diff', patch: 'secret patch', draft: true, merged: false, additions: 2, deletions: 1, changed_files: 3, head: { ref: 'feature', sha: 'a'.repeat(40), repo: { token: 'hidden' } }, base: { ref: 'main', sha: 'b'.repeat(40) } });
  const result = await h.read({ ...input, operation: 'pull' }, signal()) as any;
  assert.equal(h.requests[1].url, 'https://api.github.com/repos/octocat/hello-world/pulls/42');
  assert.equal(result.source.url, 'https://github.com/octocat/hello-world/pull/42');
  assert.equal(result.data.head.ref, 'feature');
  assert.equal(result.data.changedFiles, 3);
  assert.equal(result.data.draft, true);
  assert.equal(result.data.body, undefined);
  assert.equal(result.coverage.diffsIncluded, false);
  assert.equal(result.coverage.reviewIncluded, false);
  assert.doesNotMatch(JSON.stringify(result), /secret patch|evil.example|hidden|not metadata/);
  assert.equal(h.requests.length, 2);
});

test('issue operation cannot bypass the PR metadata-only boundary', async () => {
  await assert.rejects(harness({ title: 'PR via issue API', body: 'PR body', pull_request: { url: 'https://evil.example' } }).read(input, signal()), /use the pull metadata operation/);
});

test('redacts credential reflection in returned source content', async () => {
  const result = await harness({ title: 'test-secret-token', body: 'source says test-secret-token', user: { login: 'test-secret-token' } }).read(input, signal());
  assert.doesNotMatch(JSON.stringify(result), /test-secret-token/);
  assert.match(JSON.stringify(result), /REDACTED/);
});

test('credential reflection is redacted before text truncation', async () => {
  const result = await harness({ body: 'x'.repeat(32760) + 'test-secret-token' }).read(input, signal()) as any;
  assert.doesNotMatch(result.data.body, /test-sec/);
});

test('validated scope cannot change while credential lookup is in flight', async () => {
  const mutable = { ...input };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const read = createGitHubReader({ run: async () => { await gate; return { stdout: 'secret' }; }, fetch: (async (url: string) => { requests.push(url); return json(url.endsWith('/user') ? { login: 'account' } : {}); }) as typeof fetch });
  const result = read(mutable, signal());
  mutable.owner = 'other/../../user?x=';
  mutable.repository = 'changed';
  release();
  await result;
  assert.equal(requests[1], 'https://api.github.com/repos/octocat/hello-world/issues/42');
});

test('reads an issue using the existing login with fixed endpoints and provenance', async () => {
  const h = harness();
  const result = await h.read(input, signal()) as any;
  assert.equal(result.source.account, 'active-account');
  assert.equal(result.source.host, 'github.com');
  assert.equal(result.source.repository, 'octocat/hello-world');
  assert.equal(result.source.url, 'https://github.com/octocat/hello-world/issues/42');
  assert.ok(Date.parse(result.retrievedAt));
  assert.equal(result.data.body, 'Untrusted source');
  assert.equal(result.untrusted, true);
  assert.deepEqual(h.commands[0].slice(0, 2), ['gh', ['auth', 'token', '--hostname', 'github.com']]);
  assert.deepEqual(h.requests.map(r => r.url), ['https://api.github.com/user', 'https://api.github.com/repos/octocat/hello-world/issues/42']);
  assert.ok(h.requests.every(r => r.options?.redirect === 'error' && r.options?.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(result), /test-secret-token/);
});

test('each call captures its active account token once, including across account switches', async () => {
  let current = 'alice', credentialReads = 0;
  const observed: string[] = [];
  const read = createGitHubReader({
    run: async () => { credentialReads++; return { stdout: `token-${current}` }; },
    fetch: (async (url: string, options?: RequestInit) => {
      const token = new Headers(options?.headers).get('authorization')!;
      observed.push(token);
      if (url.endsWith('/user')) {
        const login = token.slice('Bearer token-'.length);
        current = 'bob'; // Switch during the call: the source must still use alice's captured credential.
        return json({ login });
      }
      return json({ title: 'Source' });
    }) as typeof fetch,
  });
  assert.equal((await read(input, signal()) as any).source.account, 'alice');
  assert.equal((await read(input, signal()) as any).source.account, 'bob');
  assert.equal(credentialReads, 2);
  assert.deepEqual(observed, ['Bearer token-alice', 'Bearer token-alice', 'Bearer token-bob', 'Bearer token-bob']);
});

test('token environment overrides are excluded from the fixed subprocess', async () => {
  const old = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'environment-secret';
  try {
    const h = harness();
    await h.read(input, signal());
    const options = h.commands[0][2];
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) assert.equal(options.env[key], undefined);
    assert.equal(options.maxBuffer, 16 * 1024);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.shell, undefined);
  } finally { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old; }
});

test('subprocess failures never expose stdout, stderr, or reflected token-like errors', async () => {
  const read = createGitHubReader({ run: async () => { throw new Error('GitHub returned test-secret-token stderr'); }, fetch });
  await assert.rejects(read(input, signal()), error => {
    assert.equal((error as Error).message, 'GitHub login/read unavailable. Sign in using gh auth login.');
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});

test('HTTP errors and redirects expose only a status, not server bodies or locations', async () => {
  for (const status of [301, 302, 307, 401, 403, 404, 429, 500]) {
    const read = createGitHubReader({ run: async () => ({ stdout: 'test-secret-token' }), fetch: (async () => new Response('test-secret-token', { status, headers: { location: 'https://evil.example/test-secret-token' } })) as typeof fetch });
    await assert.rejects(read(input, signal()), new RegExp(`^Error: GitHub read failed \\(HTTP ${status}\\)\\.$`));
  }
});

test('fetch failures do not leak credentials through errors or causes', async () => {
  const read = createGitHubReader({ run: async () => ({ stdout: 'test-secret-token' }), fetch: (async () => { throw new Error('test-secret-token'); }) as typeof fetch });
  await assert.rejects(read(input, signal()), error => {
    assert.equal((error as Error).message, 'GitHub request failed; redirects are not allowed.');
    assert.equal((error as Error).cause, undefined);
    return true;
  });
});

test('oversized streamed responses are cancelled at the wire-byte cap', async () => {
  let cancelled = false, calls = 0;
  const read = createGitHubReader({ run: async () => ({ stdout: 'test-secret-token' }), fetch: (async () => {
    if (++calls === 1) return json({ login: 'account' });
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; } }));
  }) as typeof fetch });
  await assert.rejects(read(input, signal()), /exceeds the bounded read limit/);
  assert.equal(cancelled, true);
});

test('malformed JSON or response shapes fail safely', async () => {
  for (const value of [null, [], 'not an issue']) await assert.rejects(harness(value).read(input, signal()), /invalid response/);
  const read = createGitHubReader({ run: async () => ({ stdout: 'test-secret-token' }), fetch: (async () => new Response('invalid test-secret-token')) as typeof fetch });
  await assert.rejects(read(input, signal()), /GitHub returned invalid JSON/);
});

test('pre-cancelled reads perform no credential or source access', async () => {
  const h = harness(), controller = new AbortController();
  controller.abort(new Error('secret cancellation reason'));
  await assert.rejects(h.read(input, controller.signal), /^Error: GitHub read cancelled\.$/);
  assert.equal(h.commands.length, 0);
  assert.equal(h.requests.length, 0);
});

test('cancellation suppresses late responses', async () => {
  const controller = new AbortController();
  let calls = 0;
  const read = createGitHubReader({ run: async () => ({ stdout: 'secret' }), fetch: (async () => {
    if (++calls === 1) return json({ login: 'account' });
    controller.abort();
    return json({ body: 'late response must not appear' });
  }) as typeof fetch });
  await assert.rejects(read(input, controller.signal), /^Error: GitHub read cancelled\.$/);
});
