import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageGeneration } from '../src/service/image-generation.ts';
import { Store } from '../src/service/store.ts';
import type { Quest } from '../src/domain/types.ts';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const authorization = 'Generate twelve high quality portrait mockup images.';
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'guildmaster-image-options-'));
  const store = new Store(dir); const requests: any[] = [];
  const service = new ImageGeneration({ store, dataDir: dir, fetch: async (_url, options) => {
    const data = options?.body instanceof FormData ? Object.fromEntries(options.body) : JSON.parse(options!.body as string);
    requests.push(data); return new Response(JSON.stringify({ data: Array.from({ length: Number(data.n) }, () => ({ b64_json: png })) }), { headers: { 'content-type': 'application/json' } });
  } });
  const quest: Quest = { id: 'options', kind: 'quest', title: 'Options fixture', objective: authorization, status: 'running', workspaceMode: 'none', workspacePath: dir, sessionPath: '', model: '', tools: [], instructions: '', runCount: 0, createdAt: 0, updatedAt: 0 };
  store.save(quest); store.message(quest.id, 'user', authorization);
  service.saveSettings({ enabled: true, mock: false, apiKey: 'mock-not-real' });
  t.after(async () => { service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, store, quest, requests, dir };
}
test('requested count/quality/portrait size pass through; larger totals batch without fixed output cap', async t => {
  const { service, quest, requests } = await fixture(t);
  for (let batch = 0; batch < 2; batch++) {
    const output = await service.generate(quest, { commandId: `batch:${batch}`, prompt: `Concept batch ${batch}`, count: 6, quality: 'high', size: '1024x1536', authorization });
    assert.equal(output.length, 6);
    assert.equal(requests[batch].n, 6); assert.equal(requests[batch].quality, 'high'); assert.equal(requests[batch].size, '1024x1536');
  }
  assert.equal(service.list(quest.id).flatMap(job => job.outputs).length, 12);
});
test('defaults are configurable, explicit values win, edits support multiple uniquely versioned variants', async t => {
  const { service, quest, requests } = await fixture(t);
  service.saveSettings({ defaultQuality: 'medium', defaultSize: '1536x1024' });
  const first = await service.generate(quest, { commandId: 'default', prompt: 'First concept', authorization });
  assert.equal(requests[0].quality, 'medium'); assert.equal(requests[0].size, '1536x1024'); assert.equal(requests[0].n, 1);
  const revisions = await service.generate(quest, { commandId: 'variants', prompt: 'Three compact variants', count: 3, quality: 'high', size: '1024x1536', reviseImageId: first[0].id, authorization });
  assert.equal(requests[1].n, '3'); assert.equal(requests[1].quality, 'high'); assert.equal(requests[1].size, '1024x1536');
  assert.deepEqual(revisions.map(image => image.version), [2, 3, 4]);
  assert.ok(revisions.every(image => image.parentImageId === first[0].id));
  await service.generate(quest, { commandId: 'duplicate-new-id', prompt: 'Three compact variants', count: 3, quality: 'high', size: '1024x1536', reviseImageId: first[0].id, authorization });
  assert.equal(requests.length, 2, 'an identical successful operation is not paid twice via a new tool ID');
});
test('explicit larger requests expand internal loop allowance; retired settings do not impose hidden budgets', async t => {
  const { service, quest, requests, store, dir } = await fixture(t);
  store.saveSetting('image-generation', { enabled: true, mock: false, model: 'gpt-image-1.5', maxOutputs: 1, maxAttempts: 1 });
  for (let i = 0; i < 12; i++) {
    const output = await service.generate(quest, { commandId: `requested-${i}`, prompt: `Requested concept ${i}`, authorization });
    assert.equal(output.length, 1);
  }
  assert.equal(requests.length, 12);
  assert.ok(!('maxOutputs' in service.settingsView()));
  assert.ok(!('maxAttempts' in service.settingsView()));
  await assert.rejects(service.generate(quest, { commandId: 'loop', prompt: 'Unrequested extra attempt', authorization }), /prevent an agent loop/);
  const more = 'Generate more images.'; store.message(quest.id, 'user', more);
  await service.generate(quest, { commandId: 'more', prompt: 'Additional requested concept', authorization: more });
  service.close(); const reopened = new ImageGeneration({ store, dataDir: dir, fetch: async () => { throw Error('No network'); } });
  try { assert.ok(!('maxOutputs' in reopened.settingsView())); assert.ok(!('maxAttempts' in reopened.settingsView())); } finally { reopened.close(); }
});
test('invalid provider options/budgets fail before dispatch instead of downgrading silently', async t => {
  const { service, quest, requests } = await fixture(t);
  for (const bad of [{ count: 11 }, { quality: 'ultra' }, { size: '4096x4096' }]) {
    await assert.rejects(service.generate(quest, { commandId: 'invalid', prompt: 'A concept', authorization, ...bad } as any));
  }
  for (const bad of [{ maxOutputs: 0 }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { defaultQuality: 'ultra' }, { defaultSize: '9x9' }]) assert.throws(() => service.saveSettings(bad));
  assert.equal(requests.length, 0);
});
