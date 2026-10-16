// Test-only transport. No requests leave this process. Production never imports it.
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (!url.startsWith('http://fixture.invalid/v1/')) throw new Error(`Unexpected fixture request: ${url}`);
  const body = JSON.parse(init.body);
  appendFileSync(process.env.GUILDMASTER_TEST_REQUESTS, JSON.stringify(body) + '\n');
  // Native user-message persistence happens before inference reaches this transport.
  // Exit synchronously before the adapter's deferred receipt check can acknowledge it.
  if (process.env.GUILDMASTER_TEST_EXIT_BEFORE_RESPONSE === '1') process.exit(86);
  const last = body.messages.at(-1);
  if (JSON.stringify(last.content).includes('STALL_MODEL_REQUEST')) return new Promise(() => {}); // Deliberately ignores abort.
  let stream = '';
  const send = (delta, finish_reason = null) => {
    stream += `data: ${JSON.stringify({
      id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  };
  if (last.role === 'user' && JSON.stringify(last.content).includes('ASK_REQUIRED')) {
    send({ role: 'assistant', tool_calls: [{ index: 0, id: 'question-fixture', type: 'function',
      function: { name: 'request_user', arguments: JSON.stringify({ question: 'Which colour?' }) } }] });
    send({}, 'tool_calls');
  } else {
    const text = last.role === 'tool' ? `Answer received: ${last.content}`
      : body.messages.some((message) => message.role === 'assistant')
        ? 'The earlier phrase was copper-otter.' : 'Remembered copper-otter.';
    send({ role: 'assistant', content: text });
    send({}, 'stop');
  }
  return new Response(stream + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
