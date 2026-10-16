import type { WorkerSpec } from './protocol.ts';

/** This context is assembled from the saved quest snapshot, never the live registry. */
export function projectContext(spec: WorkerSpec): string {
  if (!spec.project && spec.role === 'guildmaster') return '';
  const repositories = (spec.workspaces ?? (spec.workspaceMode && spec.workspaceMode !== 'none' ? [{repositoryId:'workspace',name:'Workspace',workspacePath:spec.cwd,sourcePath:spec.sourcePath ?? spec.cwd,mode:spec.workspaceMode}] : []) as import('../domain/types.ts').QuestWorkspace[]).map(workspace => ({
    repositoryId: workspace.repositoryId,
    name: workspace.name,
    ...(workspace.description ? { description: workspace.description } : {}),
    path: workspace.workspacePath,
    sourcePath: workspace.sourcePath,
    mode: workspace.mode,
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.commit ? {commit:workspace.commit} : {}),
  }));
  const purpose = spec.role === 'guildmaster'
    ? 'This is saved context from an earlier Guildmaster project selection, not a default for new quests. Use the conversation to identify the intended project. Use list_projects and inspect_project to resolve names and repository IDs. Choose workspaces for the current task explicitly. Existing quests retain their original project context.'
    : 'This is the saved project context for this quest. Use the actual repository paths below, including worktree paths. Before investigating or changing a repository, apply its loaded agent instructions and use any workflow they route this task to. Keep commands scoped to the intended repository. Treat repositories outside this selection as outside the assigned scope. These paths describe coordination scope, not a filesystem sandbox. Project registry changes do not change this quest snapshot.';
  return [purpose,
    spec.project ? `Project: ${JSON.stringify({ id: spec.project.id, name: spec.project.name })}` : '',
    `Repositories: ${JSON.stringify(repositories)}`,
    repositories.length ? '' : 'No repository is selected. Use the private scratch workspace for this task.',
    spec.project?.instructions ? `Project instructions:\n${spec.project.instructions}` : '',
    spec.workspacePolicy === 'isolated' ? `Workspace policy: isolated. Use only assigned private execution paths, not sourcePath (the original repository). Delegates inherit separate checkouts at these selected revisions: ${JSON.stringify(spec.isolation)}. The initial checkout may be a bootstrap at source HEAD, not the requested PR revision. Resolve the intended target with repository tools and skills; quest leads use set_repository_revision before delegating a different revision. Older running assignments retain their original revision. Changing revisions does not change the current directory; use the returned explicit paths.` : '',
    spec.outputPath ? `Assignment output directory: ${spec.outputPath}. Keep generated reports and packets separate from other agents.` : '',
    spec.preparedWorkspaces?.length ? `Additional saved workspaces for your own work (current directory is unchanged; use explicit absolute paths): ${JSON.stringify(spec.preparedWorkspaces)}` : '',
  ].filter(Boolean).join('\n\n');
}
