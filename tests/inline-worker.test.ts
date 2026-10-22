import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inlineToolOutput, INLINE_OUTPUT_BYTES } from '../src/engine/inline-tools.ts';
import type { WorkerEvent, WorkerSpec } from '../src/engine/protocol.ts';

test('inline evidence preserves complete bounded JSON receipts; ordinary output cap is unchanged', () => {
  const output = JSON.stringify({ text: 'x'.repeat(100 * 1024), coverage: { missingPages: [2, 3], truncated: true }, budget: { calls: 8 } });
  assert.equal(inlineToolOutput(output, true), output);
  assert.deepEqual(JSON.parse(inlineToolOutput(output, true)).coverage.missingPages, [2, 3]);
  assert.equal(inlineToolOutput(output, false).length, 20_000);
  const boundary = JSON.stringify({ text: 'x'.repeat(INLINE_OUTPUT_BYTES - 11) });
  assert.equal(Buffer.byteLength(boundary), INLINE_OUTPUT_BYTES);
  assert.equal(inlineToolOutput(boundary, true), boundary);
  for (const oversized of [boundary + ' ', 'é'.repeat(INLINE_OUTPUT_BYTES / 2 + 1)]) {
    const receipt = JSON.parse(inlineToolOutput(oversized, true));
    assert.equal(receipt.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < INLINE_OUTPUT_BYTES);
    assert.ok(receipt.originalBytes > INLINE_OUTPUT_BYTES);
  }
});

for (const scenario of ['rounds', 'mid-model', 'question', 'deadline', 'refuse', 'empty']) {
  test(`production worker inline termination: ${scenario}`, { timeout: 20_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'guildmaster-inline-worker-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const agentDir = join(directory, 'pi');
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
      fixture: { baseUrl: 'http://fixture.invalid/v1', api: 'openai-completions', apiKey: 'fixture', models: [
        { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 300000, maxTokens: 2048 },
      ] },
    } }));
    const sessionPath = join(directory, 'session.jsonl');
    const requestsPath = join(directory, 'requests.jsonl');
    const spec: WorkerSpec = { questId: 'main', runId: scenario, cwd: directory, agentDir, sessionPath,
      role: 'guildmaster', tools: [], prompt: 'Summarize bounded committed evidence.', model: 'fixture/fixture',
      serviceUrl: 'http://127.0.0.1:4173', serviceToken: 'fixture', inlineToken: 'fixture',
      inlineGrant: { repository: { repositoryId: 'repo', commit: 'a'.repeat(40) } } };
    const specPath = join(directory, 'spec.json');
    await writeFile(specPath, JSON.stringify(spec));
    const child = fork(resolve('src/worker.ts'), [specPath], {
      execArgv: ['--experimental-strip-types', '--import', resolve('tests/fixtures/inline-worker-fetch.mjs')],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, GUILDMASTER_TEST_REQUESTS: requestsPath, GUILDMASTER_INLINE_SCENARIO: scenario }, silent: true,
    });
    const events: WorkerEvent[] = [];
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('message', (event: WorkerEvent) => {
      events.push(event);
      if (event.type === 'question') child.send({ type: 'inline_exhausted', reason: 'Server absolute deadline exhausted.' });
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, JSON.stringify({ events, stderr }).slice(-6000));
    const complete = events.find(event => event.type === 'complete');
    assert.ok(complete?.type === 'complete');
    assert.match(complete.text, /incomplete/);
    const requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const models = requests.filter(request => request.url.startsWith('http://fixture.invalid'));
    const reads = requests.filter(request => request.url.endsWith('/inline-read'));
    assert.equal(models.at(-1).body.tools?.length ?? 0, 0, 'Final generation must declare no tools.');
    assert.equal(models.length, scenario === 'rounds' ? 5 : 2, 'No model/tool loops after final-only transition.');
    if (scenario === 'rounds') {
      assert.equal(reads.length, 4, 'The fourth tool round is allowed; the fifth is not.');
      assert.equal(events.filter(event => event.type === 'inline_round_end').length, 4);
    }
    if (scenario === 'mid-model') {
      assert.equal(reads.length, 0, 'Already planned source calls are blocked.');
      assert.equal(events.filter(event => event.type === 'question').length, 0, 'Already planned questions are blocked.');
    }
    if (scenario === 'question') assert.equal(events.filter(event => event.type === 'question').length, 1);
    if (scenario === 'deadline') assert.equal(reads.length, 1);
    if (scenario === 'refuse') assert.match(complete.text, /Partial finding retained[\s\S]*did not provide a final answer/);
    if (scenario === 'empty') assert.match(complete.text, /did not provide a final answer/);
    for (const event of events) if (event.type === 'tool_end' && event.tool === 'read_repository' && !event.isError) {
      const receipt = JSON.parse(event.output);
      assert.equal(receipt.text.length, 100 * 1024);
      assert.deepEqual(receipt.coverage.missingPages, [2, 3]);
      const transcript = await readFile(sessionPath, 'utf8');
      assert.ok(transcript.includes('missingPages'));
      assert.ok(transcript.includes('x'.repeat(100 * 1024)));
    }
  });
}
