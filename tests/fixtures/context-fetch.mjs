// Local fake transport only. Never forwards any network request.
import './model-fetch.mjs';
import { appendFileSync } from 'node:fs';
const success = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (['1', 'overflow'].includes(process.env.GUILDMASTER_CONTEXT_FAIL)) {
    appendFileSync(process.env.GUILDMASTER_TEST_REQUESTS, init.body + '\n');
    return new Response(JSON.stringify({ error: { message: process.env.GUILDMASTER_CONTEXT_FAIL === 'overflow' ? 'maximum context length exceeded' : 'fixture summarizer unavailable' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  return success(input, init);
};
