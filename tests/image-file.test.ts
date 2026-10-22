import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openImageWithoutSymlinks } from '../src/service/image-file.ts';

test('canonical image open rejects ancestor replacement with an escaping symlink before reading', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guildmaster-image-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const allowed = join(dir, 'allowed'), outside = join(dir, 'outside');
  await mkdir(join(allowed, 'sub'), { recursive: true }); await mkdir(outside);
  await writeFile(join(allowed, 'sub', 'image.png'), 'inside');
  await writeFile(join(outside, 'image.png'), 'private');
  const canonical = await realpath(join(allowed, 'sub', 'image.png'));
  const before = await openImageWithoutSymlinks(canonical);
  assert.equal(await before.readFile('utf8'), 'inside'); await before.close();
  // Replacement happens after containment/realpath but before the actual open.
  await rename(join(allowed, 'sub'), join(allowed, 'original'));
  await symlink(outside, join(allowed, 'sub'));
  await assert.rejects(openImageWithoutSymlinks(canonical));
});
