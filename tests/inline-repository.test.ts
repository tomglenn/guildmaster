import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepository, type RepositoryReadInput } from '../src/service/inline-repository.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
 const dir = await mkdtemp(join(tmpdir(), 'inline-repository-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
 git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
 await mkdir(join(dir, 'src')); await writeFile(join(dir, 'src', 'file.ts'), 'first\nneedle.* literal\nlast\n');
 git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
 const commit = git('rev-parse', 'HEAD');
 const read = (input: Partial<RepositoryReadInput> = {}, signal = new AbortController().signal) =>
  readRepository(dir, { operation: 'read', commit, path: 'src/file.ts', ...input }, signal) as Promise<any>;
 return { dir, git, commit, read };
}

test('reads immutable committed UTF-8 text with exact revision and bounded line provenance', async t => {
 const f = await fixture(t);
 await writeFile(join(f.dir, 'src/file.ts'), 'changed worktree');
 const result = await f.read();
 assert.equal(result.revision, f.commit);
 assert.deepEqual(result.lines, [{ line: 1, text: 'first' }, { line: 2, text: 'needle.* literal' }, { line: 3, text: 'last' }]);
 assert.equal(result.totalLines, 3); assert.equal(result.truncated, false); assert.equal(result.coverage.complete, true);
 const range = await f.read({ startLine: 2, endLine: 2 });
 assert.deepEqual(range.lines, [{ line: 2, text: 'needle.* literal' }]);
 assert.equal(range.startLine, 2); assert.equal(range.endLine, 2); assert.equal(range.truncated, true);
 assert.deepEqual(range.coverage.reasons, ['line_range']);
 assert.deepEqual((await f.read({ startLine: 99 })).lines, []);
 const search = await f.read({ operation: 'search', path: 'src', query: 'needle.*' });
 assert.deepEqual(search.matches, [{ path: 'src/file.ts', line: 2, text: 'needle.* literal' }]);
 assert.equal((await f.read({ operation: 'search', path: undefined, query: 'needle.+' })).matches.length, 0);
});

test('rejects revision expressions, option injection, traversal, malformed ranges and large queries', async t => {
 const f = await fixture(t);
 for (const commit of ['HEAD', '--help', f.commit + ':src/file.ts', f.commit + '^', 'a'.repeat(41), 'a'.repeat(39), 3])
  await assert.rejects(f.read({ commit: commit as string }), /40-hex/);
 for (const path of ['/etc/passwd', '../secret', 'src/../../secret', './src/file.ts', 'src//file.ts', 'src/../file.ts',
  'C:/secret', 'src\\file.ts', 'src\0file.ts', '--help', 'src/-x', 'x\nfile', 'x'.repeat(1025)])
  await assert.rejects(f.read({ path }), /relative path/);
 for (const range of [{ startLine: 0 }, { startLine: -1 }, { endLine: 401 }, { startLine: 2, endLine: 1 }, { startLine: 1.5 }, { endLine: Infinity }])
  await assert.rejects(f.read(range), /line range/);
 for (const query of ['', 'x'.repeat(257), 'x\ny', 'x\0y'])
  await assert.rejects(f.read({ operation: 'search', query }), /literal query/);
 await assert.rejects(f.read({ operation: 'search', query: 'first', startLine: 1 }), /line range/);
 await assert.rejects(f.read({ query: 'first' }), /does not accept a query/);
 await assert.rejects(f.read({ commit: f.git('rev-parse', 'HEAD:src/file.ts') }), /identify a commit/);
});

test('excludes sensitive names, secret-bearing content, binary, invalid UTF-8, symlinks and submodules', async t => {
 const f = await fixture(t);
 const files: Record<string, string | Buffer> = {
  '.env': 'needle secret', '.env.production': 'needle secret', '.npmrc': 'needle secret', 'credentials.json': 'needle secret',
  'private.pem': 'needle secret', '.git-credentials': 'https://user:password@example.com',
  'innocent.txt': 'needle\napi_key = "supersecretvalue"', 'auth.txt': 'needle\ntoken: supersecretvalue',
  'private.txt': 'needle\n-----BEGIN RSA PRIVATE KEY-----',
  'binary': Buffer.from([0, 1, 2]), 'invalid': Buffer.from([0xff, 0xfe]), 'too-large': 'x'.repeat(256 * 1024 + 1)
 };
 for (const [path, content] of Object.entries(files)) await writeFile(join(f.dir, path), content);
 await symlink('/etc/passwd', join(f.dir, 'link'));
 await symlink('src', join(f.dir, 'directory-link'));
 f.git('add', '.'); f.git('update-index', '--add', '--cacheinfo', `160000,${f.commit},submodule`);
 f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'excluded fixtures');
 const commit = f.git('rev-parse', 'HEAD');
 for (const path of Object.keys(files).concat(['link', 'directory-link', 'submodule']))
  await assert.rejects(f.read({ commit, path }), /excluded|Sensitive/);
 await assert.rejects(f.read({ commit, path: 'directory-link/file.ts' }), /not found/);
 await assert.rejects(f.read({ commit, path: 'submodule/file.ts' }), /not found/);
 const search = await f.read({ operation: 'search', commit, path: undefined, query: 'needle' });
 assert.deepEqual(search.matches, [{ path: 'src/file.ts', line: 2, text: 'needle.* literal' }]);
 assert.equal(search.coverage.complete, false);
 assert.deepEqual(search.coverage.skipped, { excluded: 6, unsupported: 3, oversized: 1, binary: 2, secrets: 3 });
});

test('search has explicit match/result/file/scan limits; reads bound oversized lines', async t => {
 const f = await fixture(t);
 await writeFile(join(f.dir, 'many.txt'), 'hit\n'.repeat(100));
 await writeFile(join(f.dir, 'long.txt'), 'hit' + 'a'.repeat(110 * 1024));
 await mkdir(join(f.dir, 'files'));
 for (let i = 0; i < 201; i++) await writeFile(join(f.dir, 'files', String(i)), 'hello');
 await mkdir(join(f.dir, 'bytes'));
 for (let i = 0; i < 9; i++) await writeFile(join(f.dir, 'bytes', String(i)), 'x'.repeat(256 * 1024));
 f.git('add', '.'); f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'limits');
 const commit = f.git('rev-parse', 'HEAD');
 const many = await f.read({ operation: 'search', commit, path: 'many.txt', query: 'hit' });
 assert.equal(many.matches.length, 50); assert.deepEqual(many.coverage.reasons, ['match_limit']);
 const long = await f.read({ commit, path: 'long.txt' });
 assert.equal(long.truncated, true); assert.equal(long.lines.length, 0); assert.deepEqual(long.coverage.reasons, ['result_byte_limit']);
 const searchLong = await f.read({ operation: 'search', commit, path: 'long.txt', query: 'hit' });
 assert.equal(searchLong.matches.length, 0); assert.deepEqual(searchLong.coverage.reasons, ['result_byte_limit']);
 const files = await f.read({ operation: 'search', commit, path: 'files', query: 'absent' });
 assert.equal(files.coverage.filesScanned, 200); assert.deepEqual(files.coverage.reasons, ['file_limit']);
 const bytes = await f.read({ operation: 'search', commit, path: 'bytes', query: 'absent' });
 assert.equal(bytes.coverage.bytesScanned, 2 * 1024 * 1024); assert.deepEqual(bytes.coverage.reasons, ['scan_byte_limit']);
 assert.ok(Buffer.byteLength(JSON.stringify(many)) < 100 * 1024);
});

test('does not execute configured filters/hooks, follow replace refs, or trust injected Git environment', async t => {
 const f = await fixture(t);
 const marker = join(f.dir, 'executed');
 await writeFile(join(f.dir, '.gitattributes'), '*.ts filter=evil diff=evil');
 f.git('config', 'filter.evil.smudge', `touch '${marker}'`);
 f.git('config', 'diff.evil.textconv', `touch '${marker}'`);
 f.git('config', 'core.fsmonitor', `touch '${marker}'`);
 f.git('config', 'core.hooksPath', marker);
 f.git('replace', f.git('rev-parse', 'HEAD:src/file.ts'), f.git('hash-object', '-w', '--stdin'));
 const old = process.env.GIT_DIR; process.env.GIT_DIR = '/not/a/repository';
 try { assert.equal((await f.read()).lines[0].text, 'first'); }
 finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
 await assert.rejects(access(marker));
});

test('uses fixed Git argument vectors and treats filename/query metacharacters as data', async t => {
 const f = await fixture(t);
 const path = 'src/$(touch SHOULD_NOT_EXIST);file.ts';
 await writeFile(join(f.dir, path), '--help $(touch SHOULD_NOT_EXIST)');
 f.git('add', '.'); f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'metacharacters');
 const commit = f.git('rev-parse', 'HEAD');
 assert.equal((await f.read({ commit, path })).lines[0].text, '--help $(touch SHOULD_NOT_EXIST)');
 assert.equal((await f.read({ operation: 'search', commit, path, query: '--help' })).matches.length, 1);
 await assert.rejects(access(join(f.dir, 'SHOULD_NOT_EXIST')));
 const bin = join(f.dir, 'bin'); await mkdir(bin);
 const log = join(f.dir, 'argv.jsonl');
 // Delegate to the real Git binary after capturing every argument and the scrubbed environment.
 const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
 const script = `#!${process.execPath}\nconst fs = require('node:fs');\nconst cp = require('node:child_process');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2), env:process.env})+'\\n');\nconst r=cp.spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{env:process.env});\nprocess.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status ?? 1);\n`;
 await writeFile(join(bin, 'git'), script, { mode: 0o755 });
 const oldPath = process.env.PATH, oldConfig = process.env.GIT_CONFIG_COUNT;
 process.env.PATH = bin; process.env.GIT_CONFIG_COUNT = '20';
 try { await f.read({ commit, path }); }
 finally {
  process.env.PATH = oldPath;
  if (oldConfig === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = oldConfig;
 }
 const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
 assert.equal(calls.length, 4);
 for (const call of calls) {
  assert.deepEqual(call.args.slice(0, 10), ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
   '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never']);
  assert.equal(call.args.includes(path), false);
  assert.equal(call.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(call.env.GIT_NO_LAZY_FETCH, '1');
 }
 assert.deepEqual(calls[0].args.slice(10), ['cat-file', '-t', commit]);
 assert.deepEqual(calls[1].args.slice(10), ['ls-tree', '-r', '-z', '--full-tree', commit]);
 assert.match(calls[2].args[12], /^[a-f0-9]{40}$/);
});

test('supports pre-aborted/in-flight cancellation and bounds subprocess output/deadlines', async t => {
 const f = await fixture(t);
 const pre = new AbortController(); pre.abort();
 await assert.rejects(f.read({}, pre.signal), /abort/i);
 const bin = join(f.dir, 'bin'); await mkdir(bin);
 const executable = join(bin, 'git');
 const oldPath = process.env.PATH;
 try {
  // A controlled executable exercises cancellation/maxBuffer on the actual execFile path.
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  process.env.PATH = bin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(f.read({}, controller.signal), /abort/i); } finally { clearTimeout(timer); }
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(20000));\n`, { mode: 0o755 });
  await assert.rejects(f.read(), /output\/deadline limit/);
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(f.read(), /output\/deadline limit/);
  assert.ok(Date.now() - started < 20_000, 'subprocess must not outlive the 15-second call deadline');
 } finally { process.env.PATH = oldPath; }
});
