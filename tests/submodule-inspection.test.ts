import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsSubmodules } from '../src/service/isolated-workspaces.ts';

test('submodule inspection streams large trees and still detects nested gitlinks', async t => {
  const source = await mkdtemp(join(tmpdir(), 'guildmaster-tree-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const git = (args: string[], input?: string) => execFileSync('git', args, {
    cwd: source, input, encoding: 'utf8',
  }).trim();
  git(['init', '-q']);
  const blob = git(['hash-object', '-w', '--stdin'], 'fixture');
  const files = Array.from({ length: 4096 }, (_, i) => `100644 blob ${blob}\tfile-${String(i).padStart(4, '0')}-${'x'.repeat(80)}\n`).join('');
  const subtree = git(['mktree'], files);
  const directories = Array.from({ length: 20 }, (_, i) => `040000 tree ${subtree}\tdir-${String(i).padStart(2, '0')}\n`).join('');
  const tree = git(['mktree'], directories);
  assert.throws(() => execFileSync('git', ['ls-tree', '-r', tree], {
    cwd: source, maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'pipe'],
  }), (error: any) => error.code === 'ENOBUFS');
  assert.equal(await containsSubmodules(source, tree), false);
  // A gitlink needs no .gitmodules file, and may be nested after all normal files.
  const modules = git(['mktree'], `160000 commit ${'a'.repeat(40)}\tmodule\n`);
  const withModule = git(['mktree'], directories + `040000 tree ${modules}\tzzz\n`);
  assert.equal(await containsSubmodules(source, withModule), true);
  await assert.rejects(containsSubmodules(source, 'b'.repeat(40)), /Could not inspect repository submodules/);
});
