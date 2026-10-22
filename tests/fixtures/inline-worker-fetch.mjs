// Deterministic transport for production-worker budget boundary tests.
import { appendFileSync } from 'node:fs';
const scenario = process.env.GUILDMASTER_INLINE_SCENARIO;
const realSetTimeout = globalThis.setTimeout;
if (scenario === 'deadline') {
  globalThis.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 60_000 ? 5 : ms, ...args);
}
let modelCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse(init.body);
  appendFileSync(process.env.GUILDMASTER_TEST_REQUESTS, JSON.stringify({ url, body }) + '\n');
  if (url.endsWith('/api/agent/inline-read')) {
    if (scenario === 'deadline') await new Promise(resolve => realSetTimeout(resolve, 20));
    if (scenario === 'refuse' || scenario === 'empty') process.emit('message', { type: 'inline_exhausted', reason: 'Server durable call budget exhausted.' });
    return Response.json({ text: 'x'.repeat(100 * 1024), coverage: { complete: false, missingPages: [2, 3], truncated: true }, budget: { calls: 1 } });
  }
  if (!url.startsWith('http://fixture.invalid/v1/')) throw new Error(`Unexpected URL ${url}`);
  modelCalls++;
  if (scenario === 'mid-model' && modelCalls === 1) process.emit('message', { type: 'inline_exhausted', reason: 'Server durable source budget exhausted.' });
  const tools = body.tools ?? [];
  const finalOnly = tools.length === 0;
  let calls = [];
  if (!finalOnly || scenario === 'refuse') {
    calls = scenario === 'question' || (scenario === 'mid-model' && modelCalls === 1) || (scenario === 'refuse' && finalOnly)
      ? [{ name: 'request_user', args: { question: 'Must not wait after exhaustion' } }]
      : [{ name: 'read_repository', args: { repositoryId: 'repo', commit: 'a'.repeat(40), path: 'file.ts' } }];
    if (scenario === 'mid-model') calls.push({ name: 'read_repository', args: { repositoryId: 'repo', commit: 'a'.repeat(40), path: 'file.ts' } });
  }
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'inline-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  let stream = chunk({ role: 'assistant', ...(modelCalls === 1 && scenario !== 'empty' ? { content: 'Partial finding retained.' } : {}) });
  if (calls.length) {
    stream += chunk({ tool_calls: calls.map((call, index) => ({ index, id: `call-${modelCalls}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
    stream += chunk({}, 'tool_calls');
  } else {
    if (scenario !== 'empty') stream += chunk({ content: 'Honest partial answer; coverage is incomplete.' });
    stream += chunk({}, 'stop');
  }
  return new Response(stream + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
