import test from 'node:test';
import assert from 'node:assert/strict';
import { imageTools } from './image-tools.ts';
import type { WorkerSpec } from './protocol.ts';

// Network is mocked in every execution test; no service, provider or user data is accessed.
const spec: WorkerSpec = { questId: 'quest', runId: 'run-one', cwd: '/tmp', prompt: 'Work', sessionPath: '/tmp/not-used', tools: [], role: 'quest', serviceUrl: 'http://127.0.0.1:41999', imageToken: 'image-scope', serviceToken: 'not-the-image-token' };
const call = (name: string, args: any = {}, signal?: AbortSignal, id = 'call-one') => imageTools(spec).find(tool => tool.name === name)!.execute(id, args, signal, undefined, {} as any);
const args = { prompt: 'Compact concept', authorization: 'Include mockup images illustrating the concepts.' };

test('image tools are available to all worker roles only with a dedicated capability and local service URL', () => {
  for (const role of ['guildmaster', 'quest', 'delegate'] as const) assert.deepEqual(imageTools({ ...spec, role }).map(tool => tool.name), ['generate_image', 'list_generated_images']);
  assert.deepEqual(imageTools({ ...spec, imageToken: undefined }), []);
  assert.deepEqual(imageTools({ ...spec, serviceUrl: undefined }), []);
  for (const serviceUrl of ['https://127.0.0.1', 'http://remote.invalid', 'http://127.0.0.1.evil.invalid', 'http://user:secret@localhost', 'file:///tmp/service']) assert.throws(() => imageTools({ ...spec, serviceUrl }), /local HTTP/);
  assert.equal(imageTools({ ...spec, serviceUrl: 'http://[::1]:41999' }).length, 2);
});

test('schemas and focused guidance require authorization and bound output counts', () => {
  const tool = imageTools(spec)[0];
  const schema = tool.parameters as any;
  assert.deepEqual(schema.required, ['prompt', 'authorization']);
  assert.equal(schema.properties.count.minimum, 1);
  assert.equal(schema.properties.count.maximum, 10);
  assert.deepEqual(schema.properties.quality.enum, ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(schema.properties.size.enum, ['auto', '1024x1024', '1536x1024', '1024x1536']);
  assert.equal(schema.properties.count.default, 1);
  assert.equal(schema.additionalProperties, false);
  assert.ok(tool.promptSnippet);
  for (const phrase of ['Honor the user’s requested count, quality and size', 'inherit Settings defaults', 'bounded batches', 'Generate one image by default unless the user asks for more', 'never silently trim', 'Internal duplicate/loop safeguards', 'Identical successful requests']) assert.ok(tool.description.includes(phrase), phrase);
  assert.ok(!tool.description.includes('at most two'));
  for (const phrase of ['screenshots and design conventions', 'HTML/CSS', 'concepts', 'never remote URLs', 'no automatic retries', 'preserves earlier versions']) {
    // Guidance may express the retry constraint as “or automatic retries”.
    assert.ok(tool.description.includes(phrase.replace('no automatic retries', 'automatic retries')), phrase);
  }
});

test('generation forwards references, revision and exact authorization with stable local command identity and no provider key', async t => {
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const metadata = { images: [{ id: 'image-two', parentImageId: 'image-one', version: 2, url: '/api/images/image-two', name: 'Concept' }] };
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    requests.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(metadata);
  });
  const revision = { ...args, references: [{ imageId: 'attachment-one' }, { path: '/tmp/quest/reference.png' }], reviseImageId: 'image-one' };
  const result = await call('generate_image', revision);
  await call('generate_image', revision);
  assert.equal(requests[0].url, 'http://127.0.0.1:41999/api/agent/images/generate');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(requests[0].init.headers, { Authorization: 'Bearer image-scope', 'Content-Type': 'application/json' });
  assert.deepEqual(requests[0].body, { ...revision, count: 1, commandId: 'run-one:call-one' });
  assert.deepEqual(requests[1].body, requests[0].body);
  assert.deepEqual(result, { content: [{ type: 'text', text: JSON.stringify(metadata) }], details: {} });
  assert.ok(!JSON.stringify(result).includes('image-scope'));
});

test('requested quality, size and counts through the provider maximum are forwarded unchanged; omitted defaults remain unset', async t => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ images: [] });
  });
  await call('generate_image', args);
  assert.equal(bodies[0].count, 1);
  assert.ok(!Object.hasOwn(bodies[0], 'quality'));
  assert.ok(!Object.hasOwn(bodies[0], 'size'));
  for (const quality of ['auto', 'low', 'medium', 'high']) {
    for (const size of ['auto', '1024x1024', '1536x1024', '1024x1536']) {
      await call('generate_image', { ...args, count: 10, quality, size });
      assert.deepEqual(bodies.at(-1), { ...args, commandId: 'run-one:call-one', count: 10, quality, size });
    }
  }
  await call('generate_image', { ...args, count: 3 });
  assert.equal(bodies.at(-1).count, 3);
});

test('listing returns durable metadata and attachment IDs as text, with no generated request or image content blocks', async t => {
  const metadata = { images: [{ id: 'image-one', conceptIndex: 1, version: 1 }], attachments: [{ id: 'attachment-one', mimeType: 'image/png' }], settings: { defaultQuality: 'auto', defaultSize: 'auto' } };
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(String(url), 'http://127.0.0.1:41999/api/agent/images');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return Response.json(metadata);
  });
  const result = await call('list_generated_images');
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(metadata) }]);
});

test('invalid counts, quality, size, missing authorization and URL references fail before any network request', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Invalid input must not reach the service.'));
  for (const invalid of [{ ...args, count: 0 }, { ...args, count: 11 }, { ...args, count: 1.5 }, { ...args, quality: 'standard' }, { ...args, quality: null }, { ...args, size: '512x512' }, { ...args, size: null }, { ...args, authorization: '' }, { ...args, references: [{}] }, { ...args, references: [{ path: 'https://remote.invalid/image.png' }] }, { ...args, references: [{ path: '//remote.invalid/image.png' }] }]) await assert.rejects(call('generate_image', invalid));
});

test('abort forwards to fetch and uncertain paid failures never automatically retry or expose capability', async t => {
  let attempts = 0;
  let forwarded: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    attempts++;
    forwarded = init.signal!;
    return new Promise<Response>((_resolve, reject) => forwarded!.addEventListener('abort', () => reject(new Error('Aborted image-scope')), { once: true }));
  });
  const controller = new AbortController();
  const pending = call('generate_image', args, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => {
    assert.match(String(error), /Do not automatically retry/);
    assert.match(String(error), /may still incur charges/);
    assert.ok(!String(error).includes('image-scope'));
    return true;
  });
  assert.equal(forwarded!.aborted, true);
  assert.equal(attempts, 1);
});

test('timeout is longer than the provider limit and HTTP failures are not retried', async t => {
  const durations: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (duration: number) => { durations.push(duration); return timeout(duration); });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => { attempts++; return Response.json({ error: 'Provider outcome uncertain' }, { status: 504 }); });
  await assert.rejects(call('generate_image', args), /504.*uncertain.*Do not automatically retry/);
  assert.deepEqual(durations, [240_000]);
  assert.equal(attempts, 1);
});
