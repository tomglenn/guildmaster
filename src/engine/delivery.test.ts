import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DeliveryAdapter, openDeliverySession, deliveryDetails } from './delivery.ts';
import type { DeliveryInstruction } from './protocol.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.jsonl');
  const events: string[][] = [];
  const open = () => {
    const manager = openDeliverySession(path, directory);
    return { manager, adapter: new DeliveryAdapter(manager, directory, ids => events.push(ids)) };
  };
  return { directory, path, events, open };
}
const instruction = (id: string, text = 'Remember this exact phrase: copper lantern.'): DeliveryInstruction => ({ id, kind: 'prompt', text });

test('a crash before native prompt persistence replays exact text and never acknowledges buffered entries', async t => {
  const f = await fixture(t);
  const first = f.open(); const delivery = instruction('before-save');
  assert.equal(first.adapter.prepare([delivery]), delivery.text);
  await first.adapter.drain();
  assert.deepEqual(f.events, []);
  const restarted = f.open();
  const prompt = restarted.adapter.prepare([delivery]);
  assert.equal(prompt, delivery.text);
  restarted.manager.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
  restarted.adapter.afterMessage();
  await restarted.adapter.drain();
  assert.deepEqual(f.events, [[delivery.id]]);
  assert.ok((await readFile(f.path, 'utf8')).includes(delivery.text));
});

test('a saved native prompt is reconciled after a lost acknowledgement without repeating it', async t => {
  const f = await fixture(t); const first = f.open(); const delivery = instruction('lost-ack');
  const prompt = first.adapter.prepare([delivery]);
  first.manager.appendMessage({ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() });
  // No callback or acknowledgement: equivalent to worker exit immediately after native append.
  assert.deepEqual(f.events, []);
  const restarted = f.open();
  const recovery = restarted.adapter.prepare([delivery]);
  assert.deepEqual(f.events, [[delivery.id]]);
  assert.ok(!recovery.includes(delivery.text));
  assert.equal(restarted.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 1);
  await restarted.adapter.drain();
  assert.equal(f.events.length, 1);
});

test('identical prompt text with distinct delivery IDs remains distinct, and batches preserve chronological text', async t => {
  const f = await fixture(t); const first = f.open();
  const a = instruction('identical-a'); const b = instruction('identical-b');
  first.manager.appendMessage({ role: 'user', content: first.adapter.prepare([a]), timestamp: Date.now() });
  await first.adapter.drain();
  const restarted = f.open();
  assert.equal(restarted.adapter.prepare([b]), b.text);
  restarted.manager.appendMessage({ role: 'user', content: b.text, timestamp: Date.now() });
  await restarted.adapter.drain();
  assert.deepEqual(f.events, [[a.id], [b.id]]);
  const c = instruction('batch-c', 'Change the heading to Green.');
  const d = instruction('batch-d', 'Correction: change it to Violet instead.');
  const batch = restarted.adapter.prepare([c, d]);
  assert.ok(batch.indexOf(c.text) < batch.indexOf(d.text));
  assert.match(batch, /Read all instructions before acting; newer instructions supersede/);
  restarted.manager.appendMessage({ role: 'user', content: batch, timestamp: Date.now() });
  await restarted.adapter.drain();
  assert.deepEqual(f.events.at(-1), [c.id, d.id]);
});

test('native request_user results retain answer delivery identity across process loss', async t => {
  const f = await fixture(t); const first = f.open();
  first.manager.appendMessage({ role: 'user', content: 'Ask for a color.', timestamp: Date.now() });
  const answer: DeliveryInstruction = { id: 'answer-1', kind: 'answer', toolCallId: 'question-1', answer: 'Blue', text: 'The user answered the saved question: Blue' };
  first.manager.appendMessage({ role: 'toolResult', toolCallId: 'question-1', toolName: 'request_user', content: [{ type: 'text', text: 'Blue' }], details: deliveryDetails(answer), isError: false, timestamp: Date.now() });
  const restarted = f.open();
  assert.ok(!restarted.adapter.prepare([answer]).includes(answer.text));
  assert.deepEqual(f.events, [[answer.id]]);
  const missing: DeliveryInstruction = { ...answer, id: 'answer-2', toolCallId: 'question-2', answer: 'Green', text: 'The user answered another question: Green' };
  const prompt = restarted.adapter.prepare([missing]);
  assert.equal(prompt, missing.text);
  restarted.manager.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
  await restarted.adapter.drain();
  assert.deepEqual(f.events.at(-1), [missing.id]);
});

test('mismatched receipts and damaged or missing established sessions fail visibly', async t => {
  const f = await fixture(t); const first = f.open(); const delivery = instruction('mismatch');
  first.adapter.prepare([delivery]);
  first.manager.appendMessage({ role: 'user', content: 'Different text', timestamp: Date.now() });
  assert.throws(() => f.open().adapter.prepare([delivery]), /does not match/);
  assert.deepEqual(f.events, []);
  for (const contents of ['', '{broken', '{}\n', '{"type":"session","id":"x"}\n']) {
    await writeFile(f.path, contents);
    assert.throws(() => openDeliverySession(f.path, f.directory, true), /empty|invalid/);
    assert.equal(await readFile(f.path, 'utf8'), contents);
  }
  await rm(f.path);
  assert.throws(() => openDeliverySession(f.path, f.directory, true), /missing/);
});

test('image instructions retain their bytes across interruption and acknowledge only the saved image content', async t => {
  const f = await fixture(t);
  const image = {type:'image' as const,mimeType:'image/png',data:'reference-image-bytes'};
  const input:DeliveryInstruction = {...instruction('image-reference','Review this screen.'),images:[image]};
  const first = f.open(); first.adapter.prepare([input]);
  assert.deepEqual(first.adapter.images,[image]);
  assert.deepEqual(f.events,[]);
  const restarted = f.open();const prompt = restarted.adapter.prepare([input]);
  assert.deepEqual(restarted.adapter.images,[image]);
  restarted.manager.appendMessage({role:'user',content:[{type:'text',text:prompt},image],timestamp:Date.now()});
  await restarted.adapter.drain();assert.deepEqual(f.events,[[input.id]]);
  const next = f.open();next.adapter.prepare([input]);assert.deepEqual(next.adapter.images,[]);
  assert.throws(()=>next.adapter.prepare([{...input,images:[{...image,data:'different'}]}]),/reused|differs/);
});

test('saving text without its reference image does not acknowledge the instruction', async t => {
  const f = await fixture(t);const first = f.open();
  const input:DeliveryInstruction = {...instruction('missing-image'),images:[{type:'image',mimeType:'image/png',data:'expected-image'}]};
  const prompt = first.adapter.prepare([input]);
  first.manager.appendMessage({role:'user',content:prompt,timestamp:Date.now()});
  await assert.rejects(()=>first.adapter.drain(),/reference images do not match/);
  assert.deepEqual(f.events,[]);
});
