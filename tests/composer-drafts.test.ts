import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposerDrafts, type DraftContent, type DraftPersistence } from '../src/web/composer-drafts.ts';

function fixture() {
  const saved = new Map<string, DraftContent>();
  const persistence: DraftPersistence = {
    load: async key => structuredClone(saved.get(key)),
    save: async (key, draft) => { if (draft.text || draft.images.length) saved.set(key, structuredClone(draft)); else saved.delete(key); },
  };
  return { saved, persistence, drafts: new ComposerDrafts(persistence) };
}
const image = { id: 'image-one', name: 'Reference.png', mimeType: 'image/png' as const, data: 'image-bytes' };

test('conversation drafts retain separate text and images across navigation and storage reload', async () => {
  const { saved, persistence, drafts } = fixture();
  for (const key of ['guildmaster:one', 'quest:one', 'quest:two', 'answer:one']) await drafts.load(key);
  drafts.update('guildmaster:one', () => ({ text: 'Guildmaster draft', images: [image] }));
  drafts.update('quest:one', () => ({ text: 'First quest draft', images: [] }));
  drafts.update('quest:two', () => ({ text: 'Second quest draft', images: [] }));
  drafts.update('answer:one', () => ({ text: 'Question answer', images: [] }));
  assert.equal(drafts.get('quest:one').text, 'First quest draft');
  assert.equal(drafts.get('quest:two').text, 'Second quest draft');
  assert.deepEqual(drafts.get('guildmaster:one').images, [image]);
  await Promise.all([...saved.keys(), 'guildmaster:one', 'quest:one', 'quest:two', 'answer:one'].map(key => drafts.saved(key)));
  const reloaded = new ComposerDrafts(persistence);
  await reloaded.load('guildmaster:one');
  assert.equal(reloaded.get('guildmaster:one').text, 'Guildmaster draft');
  assert.deepEqual(reloaded.get('guildmaster:one').images, [image]);
  await reloaded.load('guildmaster:new'); assert.equal(reloaded.get('guildmaster:new').text, '');
});

test('failed sends preserve a draft, and successful sends clear only their own conversation', async () => {
  const { drafts, saved } = fixture();
  await drafts.load('quest:one'); await drafts.load('quest:two');
  drafts.update('quest:one', () => ({ text: 'Send this', images: [image] }));
  drafts.update('quest:two', () => ({ text: 'Keep this', images: [] }));
  const failed = drafts.beginSend('quest:one')!;
  assert.equal(drafts.get('quest:one').sending, true);
  assert.equal(drafts.beginSend('quest:one'), undefined);
  drafts.finishSend('quest:one', failed, false);
  assert.equal(drafts.get('quest:one').text, 'Send this');
  assert.equal(drafts.get('quest:one').sending, false);
  const success = drafts.beginSend('quest:one')!;
  drafts.finishSend('quest:one', success, true);
  await drafts.saved('quest:one');
  assert.equal(drafts.get('quest:one').text, ''); assert.deepEqual(drafts.get('quest:one').images, []);
  assert.equal(saved.has('quest:one'), false);
  assert.equal(drafts.get('quest:two').text, 'Keep this');
});

test('completion of an earlier send cannot erase a newer draft or a fresh conversation', async () => {
  const { drafts } = fixture(); await drafts.load('guildmaster:old'); await drafts.load('guildmaster:new');
  drafts.update('guildmaster:old', () => ({ text: 'Old message', images: [] }));
  const submission = drafts.beginSend('guildmaster:old')!;
  drafts.update('guildmaster:old', () => ({ text: 'Newer draft', images: [] }));
  drafts.update('guildmaster:new', () => ({ text: 'Fresh conversation', images: [] }));
  drafts.finishSend('guildmaster:old', submission, true);
  assert.equal(drafts.get('guildmaster:old').text, 'Newer draft');
  assert.equal(drafts.get('guildmaster:new').text, 'Fresh conversation');
});

test('clearing a conversation while its saved draft loads does not resurrect it', async () => {
  let finish!: (draft: DraftContent) => void;
  const drafts = new ComposerDrafts({ load: () => new Promise(resolve => { finish = resolve; }), save: async () => {} });
  const load = drafts.load('guildmaster:old'); drafts.clear('guildmaster:old');
  finish({ text: 'Obsolete saved draft', images: [image] }); await load;
  assert.equal(drafts.get('guildmaster:old').text, ''); assert.deepEqual(drafts.get('guildmaster:old').images, []);
  assert.equal(drafts.get('guildmaster:old').ready, true);
});

test('writes finish in order so a slow save cannot restore a sent draft', async () => {
  let release!: () => void; const persisted: string[] = [];
  const drafts = new ComposerDrafts({ load: async () => undefined, save: async (_key, draft) => {
    if (draft.text === 'First') await new Promise<void>(resolve => { release = resolve; });
    persisted.push(draft.text);
  } });
  await drafts.load('quest:one'); drafts.update('quest:one', () => ({ text: 'First', images: [] }));
  await Promise.resolve(); drafts.update('quest:one', () => ({ text: 'Second', images: [] })); drafts.clear('quest:one');
  release(); await drafts.saved('quest:one'); assert.deepEqual(persisted, ['First', 'Second', '']);
});

test('unavailable browser storage still retains drafts during page navigation', async () => {
  const drafts = new ComposerDrafts({ load: async () => { throw new Error('Storage unavailable'); }, save: async () => { throw new Error('Quota exceeded'); } });
  await drafts.load('quest:one'); drafts.update('quest:one', () => ({ text: 'Keep in memory', images: [image] }));
  await drafts.saved('quest:one'); await drafts.load('quest:two'); await drafts.load('quest:one');
  assert.equal(drafts.get('quest:one').text, 'Keep in memory'); assert.deepEqual(drafts.get('quest:one').images, [image]);
});
