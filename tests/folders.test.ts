import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { browseFolders } from '../src/service/folders.ts';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'guildmaster-folders-')));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

test('folder browsing returns naturally sorted folders and Git markers without file contents', async t => {
  const root = await fixture(t);
  await Promise.all(['repo10', 'repo2', 'plain', '.hidden'].map(name => mkdir(join(root, name))));
  await mkdir(join(root, 'repo2', '.git'));
  await writeFile(join(root, 'repo10', '.git'), 'gitdir: /a/worktree/metadata/location');
  await writeFile(join(root, 'private.txt'), 'FILE_CONTENT_MUST_NOT_BE_RETURNED');
  const listing = await browseFolders({ path: root }, root);
  assert.equal(listing.path, root);
  assert.equal(listing.parentPath, dirname(root));
  assert.equal(listing.homePath, root);
  assert.equal(listing.isRepository, false);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.directories, [
    { name: 'plain', path: join(root, 'plain'), isRepository: false },
    { name: 'repo2', path: join(root, 'repo2'), isRepository: true },
    { name: 'repo10', path: join(root, 'repo10'), isRepository: true },
  ]);
  assert.doesNotMatch(JSON.stringify(listing), /FILE_CONTENT_MUST_NOT_BE_RETURNED|private\.txt/);
  const hidden = await browseFolders({ path: root, hidden: true }, root);
  assert.ok(hidden.directories.some(folder => folder.name === '.hidden'));
  assert.equal((await browseFolders({ path: join(root, 'repo10') }, root)).isRepository, true);
});

test('folder browsing expands home, canonicalizes symlinks, and skips broken or file links', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'target'));
  await writeFile(join(root, 'file'), 'not a folder');
  await symlink(join(root, 'target'), join(root, 'alias'));
  await symlink(join(root, 'file'), join(root, 'file-link'));
  await symlink(join(root, 'missing'), join(root, 'broken-link'));
  const home = await browseFolders({}, root);
  assert.equal(home.path, root);
  assert.deepEqual(home.directories.map(folder => folder.name), ['alias', 'target']);
  const linked = await browseFolders({ path: '~/alias' }, root);
  assert.equal(linked.path, join(root, 'target'));
  assert.equal(linked.parentPath, root);
  assert.equal((await browseFolders({ path: '~' }, root)).path, root);
  const filesystemRoot = parse(root).root;
  assert.equal((await browseFolders({ path: filesystemRoot }, root)).parentPath, null);
});

test('folder browsing rejects missing folders, files, relative paths, and malformed values', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'file'), 'text');
  for (const path of [join(root, 'missing'), join(root, 'file'), 'relative/path', '~another-user', '', 14, `${root}\0`]) {
    await assert.rejects(browseFolders({ path }, root), error => (error as { status?: number }).status === 400);
  }
});

test('folder browsing caps selectable directories and reports truncation', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 1001 }, (_, index) => mkdir(join(root, `folder${index + 1}`))));
  const listing = await browseFolders({ path: root }, root);
  assert.equal(listing.directories.length, 1000);
  assert.equal(listing.truncated, true);
  assert.equal(listing.directories[0].name, 'folder1');
  assert.equal(listing.directories.at(-1)?.name, 'folder1000');
  await rm(join(root, 'folder1001'), { recursive: true });
  assert.equal((await browseFolders({ path: root }, root)).truncated, false);
});

test('folder browsing reports inaccessible roots and omits inaccessible child folders', async t => {
  if (process.getuid?.() === 0) { t.skip('Root bypasses directory mode permissions.'); return; }
  const root = await fixture(t);
  const denied = join(root, 'denied'); await mkdir(denied);
  await chmod(denied, 0);
  try {
    await assert.rejects(browseFolders({ path: denied }, root), error => (error as { status?: number }).status === 403);
    assert.deepEqual((await browseFolders({ path: root }, root)).directories, []);
  } finally { await chmod(denied, 0o700); }
});
