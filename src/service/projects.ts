import { realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../domain/types.ts';
import type { Project, ProjectRepository, RepositorySelection } from '../domain/types.ts';
import type { Store } from './store.ts';

const exec = promisify(execFile);

export function text(value: unknown, name: string, max = 40000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${name} must contain 1–${max} characters.`);
  return value.trim();
}

export function directory(value: unknown): string {
  const candidate = text(value, 'Workspace path', 4000).replace(/^~(?=\/|$)/, process.env.HOME ?? '');
  if (!candidate.startsWith('/')) throw new AppError('Use an absolute workspace path.');
  try { const path = realpathSync(candidate); if (!statSync(path).isDirectory()) throw new Error(); return path; }
  catch { throw new AppError('The workspace directory does not exist or cannot be read.'); }
}

const key = (name: string) => name.normalize('NFKC').toLowerCase();

export function resolveProject(store: Store, reference: unknown): Project {
  const value = text(reference, 'Project', 200);
  const project = store.project(value) ?? store.projects().find(p => [p.name, ...p.aliases].some(name => key(name) === key(value)));
  if (!project) throw new AppError('Project not found. Choose a registered project.', 404);
  return project;
}

export function requireActiveProject(project: Project): void {
  if (project.archivedAt) throw new AppError('This project is archived. Restore it before starting new work or changing its configuration.', 409);
}

export async function requireWorktreeSource(path: string): Promise<void> {
  try {
    const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: path, timeout: 10000 });
    if (directory(result.stdout.trim()) !== path) throw new Error('Not the repository root');
    await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: path, timeout: 10000 });
  } catch { throw new AppError('A worktree needs a Git repository root with at least one commit.'); }
}

/** Registry changes never rewrite the project or workspace snapshots on existing quests. */
export async function validateProject(store: Store, input: Record<string, unknown>, previous?: Project): Promise<Project> {
  const name = text(input.name, 'Project name', 100);
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 20)) throw new AppError('Provide up to 20 project aliases.');
  const aliases = ((input.aliases ?? []) as unknown[]).map(alias => text(alias, 'Project alias', 100));
  const names = [name, ...aliases].map(key);
  if (new Set(names).size !== names.length) throw new AppError('The project name and aliases must be different.');
  for (const existing of store.projects()) {
    if (existing.id !== previous?.id && [existing.id, existing.name, ...existing.aliases].some(value => names.includes(key(value)))) {
      throw new AppError(`A project name or alias is already used by “${existing.name}”.`, 409);
    }
  }
  if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 20000)) throw new AppError('Project instructions must contain at most 20000 characters.');
  if (!Array.isArray(input.repositories) || input.repositories.length < 1 || input.repositories.length > 20) throw new AppError('Add between 1 and 20 repositories.');
  const repositories: ProjectRepository[] = [];
  for (const raw of input.repositories) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('Each repository needs a name and path.');
    const row = raw as Record<string, unknown>;
    const id = row.id === undefined ? randomUUID() : text(row.id, 'Repository ID', 200);
    if (row.id !== undefined && !previous?.repositories.some(repository => repository.id === id)) throw new AppError('Keep existing repository IDs, or omit the ID to add a repository.');
    const repositoryName = text(row.name, 'Repository name', 100);
    if (row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 2000)) throw new AppError('Repository descriptions must contain at most 2000 characters.');
    const description = (row.description as string | undefined)?.trim();
    const path = directory(row.path);
    if (repositories.some(repository => repository.id === id || key(repository.name) === key(repositoryName) || repository.path === path)) throw new AppError('Repository names, IDs, and paths must be unique within a project.');
    repositories.push({ id, name: repositoryName, path, ...(description ? { description } : {}) });
  }
  return {
    id: previous?.id ?? randomUUID(), name, aliases, instructions: (input.instructions as string | undefined)?.trim() ?? '', repositories,
    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
  };
}

export function selectedRepositories(project: Project, selection: unknown): {repository: ProjectRepository; mode: 'existing' | 'worktree'}[] {
  if (selection === undefined) return project.repositories.map(repository => ({ repository, mode: 'existing' as const }));
  if (!Array.isArray(selection) || selection.length > 20) throw new AppError('Choose repositories from the selected project.');
  const seen = new Set<string>();
  return selection.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('Each selection needs a repository ID.');
    const { repositoryId, mode } = raw as RepositorySelection;
    const repository = project.repositories.find(repository => repository.id === repositoryId);
    if (!repository || seen.has(repository.id)) throw new AppError('Select each repository at most once, using its registered ID.');
    seen.add(repository.id);
    if (mode !== undefined && mode !== 'existing' && mode !== 'worktree') throw new AppError('Choose an existing checkout or a worktree for each repository.');
    return { repository, mode: mode ?? 'existing' };
  });
}

export function repositoryIdentity(reference: string): string | undefined {
  try {
    const scp = reference.match(/^(?:[^/@\s]+@)?([^/:\s]+):([^\s]+)$/);
    const url = new URL(scp && !reference.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : reference);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2 && !(parts.length >= 4 && parts[2] === 'pull' && /^\d+$/.test(parts[3]))) return;
    const owner = parts[0]; const repository = parts[1].replace(/\.git$/, '');
    if (!owner || !repository) return;
    return `${url.hostname.toLowerCase()}/${owner.toLowerCase()}/${repository.toLowerCase()}`;
  } catch { return; }
}

export async function resolveProjectRepository(projects: Project[], reference: string) {
  const identity = repositoryIdentity(reference);
  if (!identity) throw new AppError('Provide a repository or pull request URL.');
  const matches: { projectId: string; projectName: string; repositoryId: string; repositoryName: string }[] = [];
  const warnings: string[] = [];
  for (const project of projects.filter(project => !project.archivedAt)) {
    await Promise.all(project.repositories.map(async repository => {
      try {
        const { stdout } = await exec('git', ['config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { cwd: repository.path, timeout: 5000, maxBuffer: 64_000 });
        const identities = stdout.split('\n').map(line => repositoryIdentity(line.replace(/^\S+\s+/, '').trim()));
        if (identities.includes(identity)) matches.push({ projectId: project.id, projectName: project.name, repositoryId: repository.id, repositoryName: repository.name });
      } catch (error) {
        if ((error as {code?:number}).code !== 1) warnings.push(`Cannot inspect Git remotes for ${project.name} / ${repository.name}.`);
      }
    }));
  }
  matches.sort((a,b) => a.projectId.localeCompare(b.projectId) || a.repositoryId.localeCompare(b.repositoryId));
  return { identity, matches, warnings, resolution: matches.length === 1 ? 'matched' : matches.length ? 'ambiguous' : 'unmatched' };
}
