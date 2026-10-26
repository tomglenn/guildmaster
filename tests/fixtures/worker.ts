/** A deliberately fake engine for deterministic service tests. It never calls a model. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import type { DeliveryInstruction } from '../../src/engine/protocol.ts';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const sessionPath = spec.sessionPath || `${dirname(process.argv[2])}/fake-session.json`;
let history: string[] = [];
let savedIds: string[] = [];
try { const saved = JSON.parse(await readFile(sessionPath, 'utf8')); history = saved.history; savedIds = saved.deliveryIds ?? []; } catch {}
await mkdir(dirname(sessionPath), { recursive: true });
const send = (event: object) => process.send?.(event);
process.on('message', (message: any) => { if (message.type === 'cancel') process.exit(0); });

// Fault markers are persisted separately so a recovered delivery fails only once.
let faults: string[] = [];
try { faults = JSON.parse(await readFile(`${sessionPath}.faults`, 'utf8')); } catch {}
async function failOnce(marker: string, delivery: DeliveryInstruction): Promise<void> {
  const key = `${delivery.id}:${marker}`;
  if (!delivery.text.includes(marker) || faults.includes(key)) return;
  faults.push(key);
  await writeFile(`${sessionPath}.faults`, JSON.stringify(faults));
  await new Promise<void>(resolve => process.send?.({ type: 'error', error: `Fixture interruption: ${marker}` }, () => resolve()));
  process.exit(1);
}
async function persist(delivery: DeliveryInstruction, liveAnswer = false) {
  if (!savedIds.includes(delivery.id)) {
    await failOnce(liveAnswer ? '[fault-answer-before-save]' : '[fault-before-delivery]', delivery);
    history.push(delivery.text);
    savedIds.push(delivery.id);
    await writeFile(sessionPath, JSON.stringify({ history, deliveryIds: savedIds }));
    await failOnce(liveAnswer ? '[fault-answer-after-save]' : '[fault-after-save]', delivery);
    if (delivery.text.includes('[complete-without-ack]') && !spec.prompt.startsWith('Resume this quest')) return;
  }
  send({ type: 'delivered', ids: [delivery.id] });
}
if (Array.isArray(spec.deliveries)) {
  for (const delivery of spec.deliveries) await persist(delivery);
} else {
  history.push(spec.prompt);
  await writeFile(sessionPath, JSON.stringify({ history, deliveryIds: savedIds }));
}
const questionId = spec.prompt.includes('[fixed-question]') ? 'same-engine-question-id' : `question-${spec.runId}`;
send({ type: 'session', sessionPath, sessionId: 'fake-session', model: spec.execution?.model || spec.model || 'fake/test', reasoning: spec.execution?.reasoning ?? null });
if (spec.prompt.includes('[write]')) await writeFile(join(spec.cwd, 'quest-result.txt'), 'Work produced by the fake test worker.');

const finish = (text: string) => {
  send({ type: 'message', role: 'assistant', text });
  send({ type: 'complete', text });
  setTimeout(() => process.exit(0), 20);
};

process.on('message', async (message: any) => {
  // Direct service tests control held workers without an HTTP listener or model.
  if (message.type === 'fixture-finish') {
    finish(message.text ?? `Fake engine history (${history.length} turns): ${history.join('\n')}`);
    return;
  }
  if (message.type === 'fixture-yield') {
    send({ type: 'yielded' });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.type === 'answer') {
    if (message.id !== questionId) {
      send({ type: 'error', error: `Answer sent to wrong engine question ID: ${message.id}` });
      setTimeout(() => process.exit(1), 20);
    } else {
      if (message.delivery) await persist(message.delivery, true);
      finish(`Answer received: ${message.answer}. History: ${history.join('\n')}`);
    }
  }
});

if (spec.prompt.includes('[question-fail]')) {
  send({ type: 'question', id: questionId, question: 'Which color should I use?' });
  send({ type: 'error', error: 'Model transport failed while waiting for an answer' });
} else if (spec.prompt.includes('[fail]')) {
  send({ type: 'error', error: 'Deliberate test worker failure' });
  setTimeout(() => process.exit(1), 20);
} else if ((spec.prompt.includes('[question]') || spec.prompt.includes('[fixed-question]')) && !spec.prompt.includes('RESUME') && !spec.prompt.startsWith('Resume this quest')) {
  send({ type: 'question', id: questionId, question: 'Which color should I use?' });
} else if (spec.prompt.includes('[wait]') && !spec.prompt.includes('RESUME') && !spec.prompt.startsWith('Resume this quest')) {
  send({ type: 'activity', tool: 'test', detail: 'Waiting for cancellation in test worker' });
} else {
  setTimeout(() => finish(`Fake engine history (${history.length} turns): ${history.join('\n')}`), spec.prompt.includes('[slow]') ? 600 : 30);
}
