import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import { resolveProject, repositoryIdentity, resolveProjectRepository } from '../src/service/projects.ts';
import type { CreateQuest, Project } from '../src/domain/types.ts';

const exec = promisify(execFile);
const workerPath = fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'guildmaster-projects-')));
  const dataDir = join(root, 'data');
  const frontend = join(root, 'frontend'); const api = join(root, 'api');
  await Promise.all([mkdir(frontend), mkdir(api)]);
  let store = new Store(dataDir);
  let service = new QuestService({ store, dataDir, defaultWorkspace: frontend, workerPath });
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  async function project(overrides: Record<string, unknown> = {}): Promise<Project> {
    return (await service.saveProject({ name: 'Guildmaster', aliases: ['gm'], instructions: 'Preserve local changes.',
      repositories: [{ name: 'Web', path: frontend }, { name: 'API', path: api }], commandId: randomUUID(), ...overrides })).project;
  }
  async function create(overrides: Partial<CreateQuest> = {}) {
    return (await service.create({ objective: 'Inspect both repositories.', commandId: randomUUID(), ...overrides })).quest;
  }
  async function complete(id: string) {
    for (let i = 0; i < 100; i++) {
      if (service.get(id).status === 'awaiting_review' && !service.live.has(id)) return service.get(id);
      await delay(20);
    }
    assert.fail(`Quest did not finish: ${JSON.stringify(service.get(id))}`);
  }
  return { root, dataDir, frontend, api, project, create, complete, service: () => service, store: () => store,
    restart: async () => { await service.close(); store.close(); store = new Store(dataDir); service = new QuestService({ store, dataDir, defaultWorkspace: frontend, workerPath }); },
  };
}

async function gitRepository(path: string) {
  await exec('git', ['init', '-q', path]);
  await writeFile(join(path, 'README.md'), 'Fixture repository\n');
  await exec('git', ['add', 'README.md'], { cwd: path });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Initial'], { cwd: path });
}

test('project registry persists, resolves aliases, and validates conflicting names and paths', async t => {
  const f = await fixture(t);
  const project = await f.project();
  assert.equal(resolveProject(f.store(), 'GM').id, project.id);
  await f.restart();
  assert.deepEqual(f.store().project(project.id), project);
  const same = { name: 'Repeat', aliases: [], repositories: [{ name: 'Web', path: f.frontend }], commandId: 'registry-idempotent' };
  const first = await f.service().saveProject(same);
  assert.deepEqual(await f.service().saveProject(same), first);
  await assert.rejects(f.project({ name: 'Other', aliases: ['gM'] }), /already used/);
  await assert.rejects(f.project({ name: 'Other', aliases: ['other'] }), /must be different/);
  await assert.rejects(f.project({ name: 'Other', aliases: [], repositories: [{ name: 'Missing', path: join(f.root, 'missing') }] }), /does not exist/);
  await symlink(f.frontend, join(f.root, 'frontend-link'));
  await assert.rejects(f.project({ name: 'Other', aliases: [], repositories: [{ name: 'One', path: f.frontend }, { name: 'Two', path: join(f.root, 'frontend-link') }] }), /must be unique/);
  await f.restart();
});

test('adding repositories preserves project metadata, existing IDs, and saved quest snapshots', async t => {
  const f = await fixture(t);
  const project = await f.project({ repositories: [{ name: 'Web', path: f.frontend, description: 'The user-facing app.' }] });
  const quest = await f.create({ projectId: project.id });
  assert.equal(quest.workspaces?.[0].description, 'The user-facing app.');
  const input = { repositories: [{ name: 'API', path: f.api, description: 'Where the API lives.' }], commandId: 'append-api', name: 'Must not rename', instructions: 'Must not replace' };
  const result = await f.service().addProjectRepositories(input, 'GM');
  assert.equal(result.project.id, project.id);
  assert.equal(result.project.name, project.name);
  assert.equal(result.project.instructions, project.instructions);
  assert.equal(result.project.createdAt, project.createdAt);
  assert.deepEqual(result.project.aliases, project.aliases);
  assert.deepEqual(result.project.repositories[0], project.repositories[0]);
  assert.equal(result.project.repositories[1].description, 'Where the API lives.');
  assert.equal(f.service().get(quest.id).workspaces?.length, 1);
  assert.deepEqual(await f.service().addProjectRepositories(input, 'GM'), result);
  await f.service().saveProject({ ...result.project, name: 'Updated project', aliases: [], commandId: 'rename-after-append' }, project.id);
  await f.restart();
  // A replay works even after the alias in the original request has been removed.
  assert.deepEqual(await f.service().addProjectRepositories(input, 'GM'), result);
  assert.equal(f.store().project(project.id)?.name, 'Updated project');
  assert.equal(f.store().project(project.id)?.repositories.length, 2);
  await assert.rejects(f.service().addProjectRepositories({ ...input, repositories: [] }, 'GM'), /different request/);
});

test('adding repositories rejects invalid or duplicate additions without partial updates', async t => {
  const f = await fixture(t);
  const project = await f.project({ repositories: [{ name: 'Web', path: f.frontend }] });
  const attempts = [
    [],
    [{ name: 'API', path: f.api }, { name: 'Missing', path: join(f.root, 'missing') }],
    [{ name: 'Other name', path: f.frontend }],
    [{ name: 'wEb', path: f.api }],
    [{ name: 'API', path: f.api }, { name: 'Duplicate API', path: f.api }],
    [{ ...project.repositories[0], path: f.api }],
    [{ name: 'API', path: f.api, description: 'x'.repeat(2001) }],
  ];
  for (const repositories of attempts) {
    const commandId = randomUUID();
    await assert.rejects(f.service().addProjectRepositories({ repositories, commandId }, project.id));
    assert.deepEqual(f.store().project(project.id), project);
    assert.equal(f.store().command(commandId), undefined);
  }
  await assert.rejects(f.service().addProjectRepositories({ repositories: [{ name: 'API', path: f.api }], commandId: 'missing-project-add' }, 'not-a-project'), /Project not found/);
  // Appending cannot silently retarget an older repository through a newly replaced symlink.
  await rename(f.frontend, join(f.root, 'moved-frontend'));
  await symlink(join(f.root, 'moved-frontend'), f.frontend);
  await assert.rejects(f.service().addProjectRepositories({ repositories: [{ name: 'API', path: f.api }], commandId: 'redirected-old-path' }, project.id), /different folder/);
  assert.deepEqual(f.store().project(project.id), project);
});

test('concurrent repository additions retain both changes', async t => {
  const f = await fixture(t);
  const project = await f.project({ repositories: [{ name: 'Web', path: f.frontend }] });
  const docs = join(f.root, 'docs'); await mkdir(docs);
  await Promise.all([
    f.service().addProjectRepositories({ repositories: [{ name: 'API', path: f.api }], commandId: 'parallel-api' }, project.id),
    f.service().addProjectRepositories({ repositories: [{ name: 'Docs', path: docs }], commandId: 'parallel-docs' }, 'gm'),
  ]);
  const saved = f.store().project(project.id)!;
  assert.deepEqual(saved.repositories.map(repository => repository.name), ['Web', 'API', 'Docs']);
  assert.equal(new Set(saved.repositories.map(repository => repository.id)).size, 3);
});

test('quests and worker specs retain multi-repository snapshots through registry edits and restart', async t => {
  const f = await fixture(t);
  const project = await f.project();
  const quest = await f.create({ projectId: project.id });
  const spec = JSON.parse(await readFile(join(f.dataDir, 'runs', `${quest.activeRunId}.json`), 'utf8'));
  assert.equal(spec.project.id, project.id);
  assert.equal(spec.project.instructions, 'Preserve local changes.');
  assert.deepEqual(spec.workspaces.map((w: any) => w.workspacePath), [f.frontend, f.api]);
  assert.equal(spec.cwd, f.frontend);
  await f.complete(quest.id);
  const replacement = join(f.root, 'replacement'); await mkdir(replacement);
  await f.service().saveProject({ ...project, name: 'Renamed', instructions: 'New project instructions.',
    repositories: project.repositories.map((repository, i) => ({ ...repository, path: i === 0 ? replacement : repository.path })), commandId: 'edit-project' }, project.id);
  await f.restart();
  await f.service().continue(quest.id, { message: 'Continue in the original checkout.', commandId: 'continue-snapshot' });
  const current = f.service().get(quest.id);
  const nextSpec = JSON.parse(await readFile(join(f.dataDir, 'runs', `${current.activeRunId}.json`), 'utf8'));
  assert.deepEqual(current.project, quest.project);
  assert.deepEqual(nextSpec.workspaces, spec.workspaces);
  assert.equal(nextSpec.project.instructions, 'Preserve local changes.');
  const fresh = await f.create({ projectId: project.id });
  assert.equal(fresh.project?.name, 'Renamed');
  assert.equal(fresh.workspacePath, replacement);
});

test('repository selections support subsets, project scratch, and explicit legacy checkouts', async t => {
  const f = await fixture(t);
  const project = await f.project();
  const subset = await f.create({ projectId: 'gm', repositories: [{ repositoryId: project.repositories[1].id }] });
  assert.equal(subset.workspacePath, f.api);
  assert.equal(subset.workspaces?.length, 1);
  const scratch = await f.create({ projectId: project.id, repositories: [] });
  assert.equal(scratch.project?.id, project.id);
  assert.equal(scratch.workspaceMode, 'none');
  assert.deepEqual(scratch.workspaces, []);
  assert.notEqual(scratch.workspacePath, f.frontend);
  const legacy = await f.create({ workspacePath: f.frontend });
  assert.equal(legacy.project, undefined);
  await f.complete(legacy.id);
  await assert.rejects(f.create({ projectId: project.id, repositories: [{ repositoryId: 'not-a-repository' }] }), /registered ID/);
  await assert.rejects(f.create({ projectId: null, repositories: [] }), /Choose a project/);
});

test('writers lock every selected root across projects, including nested checkouts', async t => {
  const f = await fixture(t);
  const project = await f.project();
  const other = await f.project({ name: 'Another project', aliases: [], repositories: [{ name: 'Shared API', path: f.api }] });
  const writer = await f.create({ projectId: project.id, tools: ['read', 'write'], objective: '[wait] Update both repositories.' });
  const shared = await f.create({ projectId: other.id, tools: ['edit'] });
  assert.equal(shared.status, 'queued');
  const nested = join(f.api, 'src'); await mkdir(nested);
  const nestedWriter = await f.create({ projectId: null, workspacePath: nested, tools: ['bash'] });
  assert.equal(nestedWriter.status, 'queued');
  const reader = await f.create({ projectId: other.id, tools: ['read'] });
  await f.complete(reader.id);
  await f.service().action(writer.id, 'cancel', { commandId: 'release-project-writer' });
  await f.service().settleWorker(writer.id);
  await f.complete(shared.id);
  await f.complete(nestedWriter.id);
});

test('worktrees isolate selected repositories and partial failures remove only newly created worktrees', async t => {
  const f = await fixture(t);
  await gitRepository(f.frontend);
  const project = await f.project();
  const before = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: f.frontend });
  await assert.rejects(f.create({ projectId: project.id, repositories: project.repositories.map(repository => ({ repositoryId: repository.id, mode: 'worktree' })) }), /Git repository root/);
  assert.equal((await exec('git', ['worktree', 'list', '--porcelain'], { cwd: f.frontend })).stdout, before.stdout);
  assert.equal((await exec('git', ['branch', '--list', 'guildmaster/*'], { cwd: f.frontend })).stdout.trim(), '');
  await gitRepository(f.api);
  const repositories = project.repositories.map(repository => ({ repositoryId: repository.id, mode: 'worktree' as const }));
  const a = await f.create({ projectId: project.id, repositories, tools: ['write'], objective: '[wait] Work in isolated checkouts.' });
  const b = await f.create({ projectId: project.id, repositories, tools: ['write'], objective: '[wait] Another independent change.' });
  assert.equal(a.workspaces?.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.notEqual(a.workspaces![i].workspacePath, a.workspaces![i].sourcePath);
    assert.notEqual(a.workspaces![i].workspacePath, b.workspaces![i].workspacePath);
  }
  await f.service().action(a.id, 'cancel', { commandId: 'cancel-isolated-a' });
  await f.service().action(b.id, 'cancel', { commandId: 'cancel-isolated-b' });
});

test('Guildmaster changes explicit project selection without creating worktrees or replacing its conversation', async t => {
  const f = await fixture(t);
  await gitRepository(f.frontend);
  const project = await f.project({ repositories: [{ name: 'Web', path: f.frontend }] });
  const first = await f.service().guildmaster({ message: 'Plan a change.', projectId: project.id, repositories: [{ repositoryId: project.repositories[0].id, mode: 'worktree' }], commandId: 'gm-project' });
  const quest = first.quest;
  await f.complete(quest.id);
  assert.equal(quest.workspacePath, f.frontend);
  assert.equal(quest.workspaces?.[0].mode, 'worktree');
  assert.equal(quest.workspaces?.[0].branch, undefined);
  const secondProject = await f.project({ name: 'API project', aliases: [], repositories: [{ name: 'API', path: f.api }] });
  const second = await f.service().guildmaster({ message: 'Now plan this one.', projectId: secondProject.id, commandId: 'gm-other-project' });
  assert.equal(second.quest.id, quest.id);
  assert.equal(second.quest.sessionPath, quest.sessionPath);
  assert.equal(second.quest.project.id, secondProject.id);
  assert.equal(second.quest.workspacePath, f.api);
  assert.equal(second.quest.workspaces[0].mode, 'existing');
  await f.complete(quest.id);
  const scratch = await f.service().guildmaster({ message: 'Plan without a repository.', workspaceMode: 'none', commandId: 'gm-project-scratch' });
  assert.equal(scratch.quest.project.id, secondProject.id);
  assert.equal(scratch.quest.workspaceMode, 'none');
  assert.deepEqual(scratch.quest.workspaces, []);
  await f.complete(quest.id);
  const reselected = await f.service().guildmaster({ message: 'Use the API again.', repositories: [{ repositoryId: secondProject.repositories[0].id }], commandId: 'gm-project-reselect' });
  assert.equal(reselected.quest.workspacePath, f.api);
  assert.equal(reselected.quest.workspaces.length, 1);
  await f.complete(quest.id);
  const raw = await f.service().guildmaster({ message: 'Use this loose directory.', workspacePath: f.frontend, commandId: 'gm-project-raw-path' });
  assert.equal(raw.quest.project, undefined);
  assert.equal(raw.quest.workspaces, undefined);
  assert.equal(raw.quest.workspacePath, f.frontend);
});

test('old default project preferences cannot select projects for new work', async t => {
  const f = await fixture(t);
  const project = await f.project();
  f.store().db.exec('CREATE TABLE IF NOT EXISTS app_preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
  f.store().db.prepare('INSERT OR REPLACE INTO app_preferences VALUES (?, ?)').run('defaultProjectId', JSON.stringify(project.id));
  await f.restart();
  const unassigned = await f.create({ workspaceMode: 'none' });
  assert.equal(unassigned.project, undefined);
  assert.equal(unassigned.workspaceMode, 'none');
  const selected = await f.create({ projectId: 'gm' });
  assert.equal(selected.project?.id, project.id);
});

test('retired repository preferences are removed without changing existing quest workspaces', async t => {
  const f = await fixture(t);
  await gitRepository(f.frontend);
  const project = await f.project({ repositories: [{ name: 'Web', path: f.frontend }] });
  const isolated = await f.create({ projectId: project.id, repositories: [{ repositoryId: project.repositories[0].id, mode: 'worktree' }] });
  await f.complete(isolated.id);
  const savedWorkspaces = f.service().get(isolated.id).workspaces;
  const legacy = { ...project, repositories: project.repositories.map(repository => ({ ...repository, defaultMode: 'worktree' })) };
  f.store().db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(legacy), project.id);
  await f.restart();

  const registered = f.store().project(project.id)!;
  assert.equal(Object.hasOwn(registered.repositories[0], 'defaultMode'), false);
  const row = f.store().db.prepare('SELECT data FROM projects WHERE id=?').get(project.id) as { data: string };
  assert.equal(Object.hasOwn(JSON.parse(row.data).repositories[0], 'defaultMode'), false);
  assert.equal(registered.updatedAt, project.updatedAt);
  assert.deepEqual(f.service().get(isolated.id).workspaces, savedWorkspaces);

  const direct = await f.create({ projectId: project.id });
  assert.equal(direct.workspaces?.[0].mode, 'existing');
  assert.equal(direct.workspacePath, f.frontend);
  const anotherIsolated = await f.create({ projectId: project.id, repositories: [{ repositoryId: project.repositories[0].id, mode: 'worktree' }] });
  assert.equal(anotherIsolated.workspaces?.[0].mode, 'worktree');
  assert.notEqual(anotherIsolated.workspacePath, isolated.workspacePath);
});

test('legacy registration preferences are ignored instead of requiring a Git repository', async t => {
  const f = await fixture(t);
  const project = await f.project({ repositories: [{ name: 'Web', path: f.frontend, defaultMode: 'worktree' }] });
  assert.equal(Object.hasOwn(project.repositories[0], 'defaultMode'), false);
  const quest = await f.create({ projectId: project.id, repositories: [{ repositoryId: project.repositories[0].id }] });
  assert.equal(quest.workspacePath, f.frontend);
  assert.equal(quest.workspaces?.[0].mode, 'existing');
});

test('project archiving persists, blocks new work and registry edits, and retains existing quest workspaces', async t => {
  const f = await fixture(t);
  const project = await f.project();
  const quest = await f.create({ projectId: project.id });
  await f.complete(quest.id);
  const snapshot = structuredClone(f.service().get(quest.id));
  const input = { commandId: 'archive-project' };
  const archived = await f.service().projectAction('gm', 'archive', input);
  assert.ok(archived.project.archivedAt);
  assert.deepEqual(archived.project.repositories, project.repositories);
  assert.deepEqual(await f.service().projectAction('gm', 'archive', input), archived);
  assert.deepEqual(f.service().get(quest.id), snapshot);
  await f.restart();
  assert.equal(f.store().project(project.id)?.archivedAt, archived.project.archivedAt);
  assert.deepEqual(await f.service().projectAction('gm', 'archive', input), archived);
  await assert.rejects(f.create({ projectId: project.id }), /archived.*Restore/);
  await assert.rejects(f.service().saveProject({ ...project, archivedAt: null, commandId: 'edit-archived' }, project.id), /archived.*Restore/);
  await assert.rejects(f.service().addProjectRepositories({ repositories: [{ name: 'More', path: f.api }], commandId: 'add-archived' }, project.id), /archived.*Restore/);
  await f.service().continue(quest.id, { message: 'Continue the saved investigation.', commandId: 'continue-archived-project' });
  await f.complete(quest.id);
  assert.deepEqual(f.service().get(quest.id).workspaces, snapshot.workspaces);
  assert.deepEqual(f.service().get(quest.id).project, snapshot.project);
  const restored = await f.service().projectAction(project.id, 'restore', { commandId: 'restore-project' });
  assert.equal(restored.project.archivedAt, undefined);
  assert.deepEqual(restored.project.repositories, project.repositories);
  assert.equal((await f.create({ projectId: project.id })).project?.id, project.id);
});

test('restoring a project does not require its old repository folders to remain available', async t => {
  const f = await fixture(t);
  const project = await f.project();
  await f.service().projectAction(project.id, 'archive', { commandId: 'archive-moved-project' });
  await rename(f.frontend, join(f.root, 'moved-frontend'));
  const restored = await f.service().projectAction(project.id, 'restore', { commandId: 'restore-moved-project' });
  assert.equal(restored.project.archivedAt, undefined);
  assert.equal(restored.project.repositories[0].path, f.frontend);
});


test('PR URLs resolve against active project remotes without exposing remote credentials', async t => {
  const f = await fixture(t);
  await exec('git', ['init'], {cwd:f.frontend});
  await exec('git', ['remote','add','origin','git@github.com:example-fork/web.git'], {cwd:f.frontend});
  await exec('git', ['remote','add','upstream','https://fixture-user:fixture-password@github.com/Example/Web.git'], {cwd:f.frontend});
  const project = (await f.service().saveProject({name:'Example', repositories:[{name:'Web',path:f.frontend}],commandId:'remote-project'})).project;
  const match = await resolveProjectRepository([project], 'https://github.com/example/web/pull/42/files');
  assert.equal(match.resolution, 'matched');
  assert.equal(match.matches[0].repositoryId, project.repositories[0].id);
  assert.ok(!JSON.stringify(match).includes('fixture-password'));
  assert.equal((await resolveProjectRepository([{...project,archivedAt:1}], 'https://github.com/example/web/pull/42')).matches.length, 0);
  assert.equal((await resolveProjectRepository([project,{...project,id:'duplicate'}], 'https://github.com/example/web/pull/42')).resolution, 'ambiguous');
  assert.equal(repositoryIdentity('ssh://git@github.com/Example/Web.git'), 'github.com/example/web');
  assert.equal(repositoryIdentity('file:///tmp/repo'), undefined);
});
