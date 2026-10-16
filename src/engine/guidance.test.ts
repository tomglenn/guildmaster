import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverGuidance, guidanceCatalog, scopeGuidance } from './guidance.ts';
import { guidanceTools } from './guidance-tools.ts';
import type { WorkerEvent, WorkerSpec } from './protocol.ts';

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Use this workflow for ${name} tasks.\n---\n${body}`;
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'guildmaster-guidance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, content: string) => { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, content); return full; };
  put('web/AGENTS.md', 'For every PR review, use /review. Preserve user constraints.');
  put('web/.claude/skills/review/SKILL.md', skill('review', 'Read `.cursor/skills/review/SKILL.md` and follow it exactly.'));
  put('web/.cursor/skills/review/SKILL.md', skill('review', 'Run node .cursor/skills/review/check.mjs, then return its verdict.'));
  put('web/src/AGENTS.md', 'Files in src require contract verification.');
  put('web/src/value.ts', 'export const value = 1;');
  put('api/CLAUDE.md', 'API-only instructions.');
  put('api/.agents/skills/review/SKILL.md', skill('review', 'Review the API contract.'));
  return { root, put, workspaces: ['web', 'api'].map(repositoryId => ({ repositoryId, workspacePath: join(root, repositoryId), sourcePath: join(root, repositoryId) })) };
}

test('guidance discovers all selected repositories, scoped files, pointer skills and isolated catalogs', async t => {
  const f = fixture(t);
  f.put('web/node_modules/vendor/AGENTS.md', 'Ignore this dependency.');
  f.put('web/.github/AGENTS.md', 'Workflow-specific guidance.');
  symlinkSync(join(f.root, 'web/.cursor/skills'), join(f.root, 'web/.cursor/skills/loop'));
  const manifest = discoverGuidance(f.workspaces, { shared: false });
  assert.equal(manifest.instructions.length, 4);
  assert.equal(manifest.skills.length, 3);
  assert.equal(guidanceCatalog(manifest).length, 2, 'A pointer and its target should appear once in the catalog');
  assert.ok(manifest.instructions.find(file => file.scope.endsWith('/web/src') && !file.root));
  const scoped = scopeGuidance(manifest, ['web']);
  assert.equal(scoped.instructions.length, 3);
  assert.ok(scoped.instructions.some(file => file.scope.endsWith('/.github')));
  assert.ok(scoped.skills.every(entry => entry.repositoryId === 'web'));
  const events: WorkerEvent[] = [];
  const spec = { cwd: join(f.root, 'web'), tools: ['read', 'edit'] } as WorkerSpec;
  const tools = guidanceTools(spec, scoped, event => events.push(event));
  const load = tools.find(tool => tool.name === 'load_skill')!;
  const output = await load.execute('call', { id: join(f.root, 'web/.claude/skills/review/SKILL.md') }, undefined, undefined, {} as any);
  assert.match(JSON.stringify(output), /Run node .cursor\/skills\/review\/check.mjs/);
  assert.equal(events.filter(event => event.type === 'activity' && event.tool === 'skill').length, 2);
  f.put('web/.cursor/skills/review/SKILL.md', skill('review', 'A changed checkout must not replace the pinned workflow.'));
  const read = tools.find(tool => tool.name === 'read')!;
  const pinned = await read.execute('read-skill', {path:'.cursor/skills/review/SKILL.md'}, undefined, undefined, {} as any);
  assert.match(JSON.stringify(pinned), /Run node .cursor\/skills\/review\/check.mjs/);
  assert.doesNotMatch(JSON.stringify(pinned), /changed checkout/);
  const edit = tools.find(tool => tool.name === 'edit')!;
  const edited = await edit.execute('edit', { path: 'src/value.ts', edits: [{oldText: 'value = 1', newText: 'value = 2'}] }, undefined, undefined, {} as any);
  assert.match(JSON.stringify(edited), /No file was changed/);
  assert.match(readFileSync(join(f.root, 'web/src/value.ts'), 'utf8'), /value = 1/);
  await edit.execute('edit-retry', { path: 'src/value.ts', edits: [{oldText: 'value = 1', newText: 'value = 2'}] }, undefined, undefined, {} as any);
  assert.match(readFileSync(join(f.root, 'web/src/value.ts'), 'utf8'), /value = 2/);
});

test('identical skill text in distinct scopes retains both relative resource bases', t => {
  const f = fixture(t);
  const body = skill('audit', 'Run scripts/check.mjs relative to this skill.');
  f.put('web/.agents/skills/audit/SKILL.md', body);
  f.put('web/src/.agents/skills/audit/SKILL.md', body);
  const manifest = discoverGuidance(f.workspaces, {shared:false});
  const audits = manifest.skills.filter(entry => entry.skill.name === 'audit');
  assert.equal(audits.length,2);
  assert.notEqual(audits[0].skill.baseDir,audits[1].skill.baseDir);
});

test('guidance snapshots preserve instruction versions, worktree scopes and explicit-only skills', t => {
  const f = fixture(t);
  f.put('AGENTS.md', 'Source ancestor guidance.');
  f.put('generated/AGENTS.md', 'Unrelated worktree parent policy.');
  f.put('generated/worktree/AGENTS.md', 'Actual worktree guidance.');
  f.put('generated/worktree/.pi/skills/manual/SKILL.md', '---\nname: manual\ndescription: A manual workflow.\ndisable-model-invocation: true\n---\nDo manual work.');
  const manifest = discoverGuidance([{repositoryId:'web', sourcePath: join(f.root,'web'), workspacePath: join(f.root,'generated/worktree')}], {shared:false});
  assert.ok(manifest.instructions.some(file => file.content === 'Source ancestor guidance.'));
  assert.ok(!manifest.instructions.some(file => file.content.includes('Unrelated')));
  assert.ok(guidanceCatalog(manifest)[0].explicitOnly);
  f.put('generated/worktree/AGENTS.md', 'Changed during review.');
  assert.ok(manifest.instructions.some(file => file.content === 'Actual worktree guidance.'));
});

test('guidance reports oversized instructions, missing pointer targets and ambiguous skills', async t => {
  const f = fixture(t);
  f.put('web/AGENTS.md', 'x'.repeat(100_001));
  const manifest = discoverGuidance(f.workspaces, { shared: false });
  assert.match(manifest.warnings.join('\n'), /Cannot load instructions/);
  const tools = guidanceTools({cwd:f.root,tools:['read']} as WorkerSpec, manifest, () => {});
  await assert.rejects(tools[0].execute('call', {id:'review'}, undefined, undefined, {} as any), /Several skills/);
  const pointer = manifest.skills.find(entry => entry.skill.filePath.includes('.claude'))!;
  manifest.skills = [pointer];
  await assert.rejects(tools[0].execute('call', {id:pointer.id}, undefined, undefined, {} as any), /Required skill reference is unavailable/);
});

test('shared skills use installed plugin metadata without reading disabled plugins or running hooks', t => {
  const f = fixture(t);
  const installed = f.put('plugin/skills/helper/SKILL.md', skill('helper', 'A shared helper workflow.'));
  f.put('disabled/skills/hidden/SKILL.md', skill('hidden', 'Must not appear.'));
  f.put('home/.claude/plugins/installed_plugins.json', JSON.stringify({plugins:{'helper@local':[{installPath:join(f.root,'plugin')}], 'disabled@local':[{installPath:join(f.root,'disabled')}]}}));
  f.put('home/.claude/settings.json', JSON.stringify({enabledPlugins:{'disabled@local':false}}));
  const manifest = discoverGuidance(f.workspaces, {home:join(f.root,'home')});
  assert.ok(manifest.skills.some(entry => entry.skill.filePath === installed));
  assert.ok(!manifest.skills.some(entry => entry.skill.name === 'hidden'));
});
