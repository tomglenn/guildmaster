import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, ModelRuntime, resolveCliModel, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { listModels } from '../src/engine/models.ts';
import { runtimeOptions } from '../src/engine/settings.ts';
import type { WorkerEvent, WorkerSpec } from '../src/engine/protocol.ts';

async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-model-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'engine');
  await mkdir(agentDir);
  const config = { providers: { 'local-fixture': {
    baseUrl: 'http://fixture.invalid/v1', api: 'openai-completions', apiKey: 'fixture-only',
    models: [
      { id: 'reasoner', name: 'Reasoner', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 1024,
        thinkingLevelMap: { minimal: null, xhigh: 'extreme', max: null } },
      { id: 'text', name: 'Text only', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024 },
      { id: 'literal:high', name: 'ID with a colon', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024 },
      { id: 'small', name: 'Small context', reasoning: false, input: ['text'], contextWindow: 1200, maxTokens: 1024 },
    ],
  } } };
  await writeFile(join(agentDir, 'models.json'), JSON.stringify(config));
  const requestPath = join(directory, 'requests.jsonl');
  const requests = async () => (await readFile(requestPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function run(id: string, overrides: Partial<WorkerSpec> = {}, mismatch = false) {
    const spec: WorkerSpec = {
      questId: 'test', runId: id, cwd: directory, agentDir, sessionPath: join(directory, 'session.jsonl'),
      prompt: `Exact instruction ${id}`, deliveries: [{ id, kind: 'prompt', text: `Exact instruction ${id}` }],
      model: 'local-fixture/text', role: 'quest', tools: [], ...overrides,
    };
    const specPath = join(directory, `${id}.json`);
    await writeFile(specPath, JSON.stringify(spec));
    const child = fork(resolve('src/worker.ts'), [specPath], {
      execArgv: ['--experimental-strip-types', '--import', resolve('tests/fixtures/model-fetch.mjs'),
        ...(mismatch ? ['--import', resolve('tests/fixtures/worker-model-mismatch.mjs')] : [])],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, GUILDMASTER_TEST_REQUESTS: requestPath }, silent: true,
    });
    const events: WorkerEvent[] = [];
    let stderr = '';
    child.on('message', (event: WorkerEvent) => events.push(event));
    child.stderr?.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    clearTimeout(timer);
    return { code, events, stderr };
  }
  return { directory, agentDir, config, requestPath, requests, run };
}

const execution = (model: string, reasoning: string | null): NonNullable<WorkerSpec['execution']> =>
  ({ model, reasoning });

test('Pi 1.0.4 capabilities and native reopen precedence are characterized without inference', async t => {
  const f = await fixture(t);
  const catalog = await listModels(f.agentDir);
  const reasoner = catalog.find(model => model.id === 'local-fixture/reasoner')!;
  assert.deepEqual(reasoner.reasoningLevels, ['off', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(catalog.find(model => model.id === 'local-fixture/text')!.reasoningLevels, ['off']);
  assert.equal(reasoner.tools, 'unknown');
  const runtime = await ModelRuntime.create(runtimeOptions(f.agentDir));
  // CLI resolution is intentionally permissive: it is not an authorization API.
  assert.equal(resolveCliModel({ cliModel: 'local-fixture/reas', modelRuntime: runtime }).model?.id, 'reasoner');
  assert.equal(resolveCliModel({ cliModel: 'local-fixture/reasoner:high', modelRuntime: runtime }).thinkingLevel, 'high');
  assert.equal(resolveCliModel({ cliModel: 'local-fixture/literal:high', modelRuntime: runtime }).model?.id, 'literal:high');
  const manager = SessionManager.inMemory(f.directory);
  manager.appendModelChange('local-fixture', 'reasoner');
  manager.appendThinkingLevelChange('high');
  manager.appendMessage({ role: 'user', content: 'Retain exact history.', timestamp: 1 });
  const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: 'low' });
  const restored = await createAgentSession({ cwd: f.directory, agentDir: f.agentDir, modelRuntime: runtime, sessionManager: manager, settingsManager, noTools: 'all' });
  assert.equal(restored.session.model?.id, 'reasoner');
  assert.equal(restored.session.thinkingLevel, 'high', 'native effort wins over global default');
  restored.session.dispose();
  const explicit = await createAgentSession({ cwd: f.directory, agentDir: f.agentDir, modelRuntime: runtime, sessionManager: manager, settingsManager,
    model: runtime.getModel('local-fixture', 'reasoner'), thinkingLevel: 'low', noTools: 'all' });
  assert.equal(explicit.session.thinkingLevel, 'low', 'explicit effort wins over saved effort');
  explicit.session.setThinkingLevel('minimal');
  assert.equal(explicit.session.thinkingLevel, 'low', 'unsupported levels are silently clamped by SDK, so worker must reject');
  explicit.session.dispose();
  manager.appendModelChange('local-fixture', 'removed');
  settingsManager.setDefaultModelAndProvider('local-fixture', 'text');
  const fallback = await createAgentSession({ cwd: f.directory, agentDir: f.agentDir, modelRuntime: runtime, sessionManager: manager, settingsManager, noTools: 'all' });
  assert.equal(fallback.session.model?.id, 'text');
  assert.match(fallback.modelFallbackMessage!, /Could not restore/);
  fallback.session.dispose();
  assert.equal((await f.requests()).length, 0);
});

test('worker enforces exact snapshot and effort across turns; rejects aliases, missing models, clamping and fallback before prompt', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const first = await f.run('first', { execution: execution('local-fixture/reasoner', 'high') });
  assert.equal(first.code, 0, JSON.stringify(first));
  assert.ok(first.events.some(event => event.type === 'session' && event.model === 'local-fixture/reasoner' && event.reasoning === 'high'));
  assert.equal((await f.requests()).at(-1).reasoning_effort, 'high');
  const second = await f.run('second', { execution: execution('local-fixture/reasoner', 'low') });
  assert.equal(second.code, 0, JSON.stringify(second));
  assert.equal((await f.requests()).at(-1).reasoning_effort, 'low');
  assert.match(JSON.stringify((await f.requests()).at(-1).messages), /Exact instruction first/);
  const reopened = SessionManager.open(join(f.directory, 'session.jsonl')).buildSessionContext();
  assert.deepEqual(reopened.model, { provider: 'local-fixture', modelId: 'reasoner' });
  assert.equal(reopened.thinkingLevel, 'low', 'verified factory overrides must also persist to native session');
  const managed = await f.run('managed', { execution: execution('local-fixture/reasoner', null) });
  assert.equal(managed.code, 0, JSON.stringify(managed));
  assert.ok(managed.events.some(event => event.type === 'session' && event.reasoning === 'low'), 'null preserves native/provider-managed effort, not an invented level');
  for (const [id, overrides, mismatch] of [
    ['unsupported', { execution: execution('local-fixture/reasoner', 'minimal') }, false],
    ['invented', { execution: execution('local-fixture/reasoner', 'turbo') }, false],
    ['nonreasoning', { execution: execution('local-fixture/text', 'high') }, false],
    ['removed', { execution: execution('local-fixture/removed', null) }, false],
    ['fuzzy', { model: 'local-fixture/reas' }, false],
    ['bare', { model: 'reasoner' }, false],
    ['missing', { model: undefined }, false],
    ['suffix-in-snapshot', { execution: execution('local-fixture/reasoner:high', null) }, false],
    ['sdk-fallback', { execution: execution('local-fixture/reasoner', 'low') }, true],
  ] as const) {
    const count = (await f.requests()).length;
    const result = await f.run(id, overrides, mismatch);
    assert.equal(result.code, 1, JSON.stringify({ id, ...result }));
    assert.ok(result.events.some(event => event.type === 'error'), id);
    assert.ok(!result.events.some(event => event.type === 'ready' || event.type === 'complete' || event.type === 'delivered'), id);
    assert.equal((await f.requests()).length, count, `${id} must not send a paid request`);
    assert.doesNotMatch(await readFile(join(f.directory, 'session.jsonl'), 'utf8'), new RegExp(`Exact instruction ${id}`));
  }
  const legacy = await f.run('legacy', { model: 'local-fixture/reasoner:high' });
  assert.equal(legacy.code, 0, JSON.stringify(legacy));
  assert.equal((await f.requests()).at(-1).reasoning_effort, 'high');
  const mapped = await f.run('mapped', { execution: execution('local-fixture/reasoner', 'xhigh') });
  assert.equal(mapped.code, 0, JSON.stringify(mapped));
  assert.equal((await f.requests()).at(-1).reasoning_effort, 'extreme', 'provider mapping is SDK-owned, not a universal wire enum');
  const colon = await f.run('colon', { execution: execution('local-fixture/literal:high', null) });
  assert.equal(colon.code, 0, JSON.stringify(colon));
  assert.equal((await f.requests()).at(-1).model, 'literal:high');
  assert.deepEqual(SessionManager.open(join(f.directory, 'session.jsonl')).buildSessionContext().model,
    { provider: 'local-fixture', modelId: 'literal:high' }, 'switches persist as native model changes with history retained');
  const count = (await f.requests()).length;
  delete (f.config.providers['local-fixture'] as { apiKey?: string }).apiKey;
  await writeFile(join(f.agentDir, 'models.json'), JSON.stringify(f.config));
  const unavailable = await f.run('unavailable', { execution: execution('local-fixture/text', null) });
  assert.equal(unavailable.code, 1, JSON.stringify(unavailable));
  assert.ok(unavailable.events.some(event => event.type === 'error' && /unavailable/.test(event.error)));
  assert.equal((await f.requests()).length, count);
});
