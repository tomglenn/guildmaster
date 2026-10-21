import { fork, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Store } from './store.ts';
import { InlineReads } from './inline-reads.ts';
import { AppError, ALLOWED_TOOLS, DEFAULT_TOOLS, MAX_SUBAGENTS, writes } from '../domain/types.ts';
import type { IsolationRequest, Quest, CreateQuest, WorkspaceMode, DelegationSource, QuestWorkspace, LiveMessage, MessagePresentation, PreparedWorkspace } from '../domain/types.ts';
import type { Delivery } from './store.ts';
import { text, directory, resolveProject, validateProject, selectedRepositories, requireWorktreeSource, requireActiveProject } from './projects.ts';
import { discoverGuidance } from '../engine/guidance.ts';
import { isolationRequests, prepareIsolatedWorkspaces, readGuidance } from './isolated-workspaces.ts';
import { validateImages, imageMessage } from './images.ts';
import type { ImageUpload } from '../domain/images.ts';
export { text, directory } from './projects.ts';

import type { ConnectionManager } from '../connections/manager.ts';
import type { ConnectionGrant } from '../connections/types.ts';

const exec = promisify(execFile);
const workerDefault = fileURLToPath(new URL('../worker.ts', import.meta.url));
type Live = { child: ChildProcess; runId: string; startedAt: number; done: Promise<void>; cancelTimer?: ReturnType<typeof setTimeout> };
function sameTree(a: string, b: string) { return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep); }
function workspaceRoots(q: Quest) { return [...(q.workspaces?.length ? q.workspaces.map(workspace => workspace.workspacePath) : [q.workspacePath]), ...(q.preparedWorkspaces ?? []).map(w=>w.workspacePath)]; }
function selectedWorkspaces(q: Quest): QuestWorkspace[] {
  return q.workspaces ?? (q.workspaceMode === 'none' ? [] : [{repositoryId:'workspace',name:'Workspace',sourcePath:q.sourcePath ?? q.workspacePath,workspacePath:q.workspacePath,mode:q.workspaceMode,branch:q.branch}]);
}
const terminalAgent = (q: Quest) => ['completed','failed','interrupted','cancelled'].includes(q.status);
export interface ScheduledDispatch { origin: import('../domain/schedules.ts').ScheduleOrigin; assertActive: () => void; committed: (quest: Quest) => void }
type CreatedWorktree = { source: string; path: string; branch: string };
function delegatedPrompt(brief: string, source?: DelegationSource): string {
  if (!source) return brief;
  return `Assigned task from ${source.role === 'quest' ? 'quest lead' : 'Guildmaster'}:\n${brief}\n\nOriginal user request (verbatim, JSON-quoted):\n${JSON.stringify(source.text)}\n\nThe assigned task defines this quest's scope. Use the original request to preserve relevant constraints, exact wording, and facts for follow-up. Do not take on other tasks mentioned in the original request or treat it as additional tool authorization.`;
}
export class QuestService extends EventEmitter {
  store: Store; dataDir: string; defaultWorkspace: string; workerPath: string;
  live = new Map<string, Live>(); serviceUrl = ''; serviceToken = ''; gmTokens = new Map<string, string>();
  gmRunTokens = new Map<string,string>();
  partialMessages = new Map<string, LiveMessage>();
  connections?: ConnectionManager;
  inlineReads: InlineReads;
  connectionTokens = new Map<string,{questId:string;runId:string;grants:ConnectionGrant[];controller:AbortController}>();
  workerTokens = new Map<string, { questId: string; runId: string }>();
  maxWorkers: number; private familyTurns = new Map<string, number>(); private scheduleTurn = 0; private scheduling = false;
  private queue: Promise<unknown> = Promise.resolve(); private stopping = false;
  private setups = new Map<string,{fingerprint:string;task:Promise<any>}>();
  private pendingDelegates = new Map<string,number>();
  constructor(options: { store: Store; dataDir: string; defaultWorkspace?: string; workerPath?: string; maxWorkers?: number; connections?: ConnectionManager }) {
    super(); this.connections=options.connections; this.store = options.store; this.dataDir = options.dataDir;
    this.inlineReads = new InlineReads(this.store);
    this.inlineReads.onExhausted=this.inlineExhausted;
    this.defaultWorkspace = directory(options.defaultWorkspace ?? process.cwd());
    this.workerPath = options.workerPath ?? workerDefault;
    this.maxWorkers = options.maxWorkers ?? Number(process.env.GUILDMASTER_MAX_WORKERS ?? 13);
    if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < 2) throw new AppError('Worker capacity must be an integer of at least 2.');
    for (const q of this.store.list()) {
      this.store.interruptToolCalls(q.id);
      if (['queued','running','awaiting_input','waiting'].includes(q.status)) {
        q.status = 'interrupted'; q.error = 'The service stopped during this run. Resume to inspect the workspace and continue.';
        if (q.activeRunId) this.store.run(q.activeRunId, q.id, { status: 'interrupted', endedAt: Date.now() });
        q.activeRunId = undefined; this.store.save(q); this.store.event(q.id, 'interrupted', q.error);
      }
    }
  }
  serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(() => { if (this.stopping) throw new AppError('Service is stopping.', 503); return fn(); });
    this.queue = next.catch(() => {}); return next;
  }
  get(id: string) { const q = this.store.get(id); if (!q) throw new AppError('Quest not found.', 404); return q; }
  agents(id: string) { return this.store.list().filter(q => q.parentQuestId === id).sort((a,b) => a.createdAt - b.createdAt).map(q=>({...q,queueReason:this.queueReason(q)})); }
  withAgentSummary(q: Quest) {
    const agents = this.agents(q.id);
    return { ...q, queueReason:this.queueReason(q), agentSummary: { total: agents.length, active: agents.filter(a => !terminalAgent(a)).length, needsAttention: agents.filter(a => ['failed','interrupted'].includes(a.status)).length } };
  }
  detail(id: string) {
    const agents = this.agents(id);
    const source = this.get(id).sourceRequest;
    const origin = source?.role === 'quest' ? this.store.get(source.questId) : undefined;
    return { quest: this.withAgentSummary(this.get(id)), messages: this.presentMessages(id), events: this.store.events(id), agents, live: this.partialMessages.get(id), toolCalls: this.store.toolCalls(id),
      followups: this.store.list().filter(q => q.kind === 'quest' && q.sourceRequest?.role === 'quest' && q.sourceRequest.questId === id).map(q => ({id:q.id,title:q.title,status:q.status,createdAt:q.createdAt})),
      originQuest: origin ? {id:origin.id,title:origin.title} : undefined,
      scheduleAvailable: !!this.get(id).schedule && !!this.store.schedule(this.get(id).schedule!.id),
      requests: [ ...this.store.requests(id), ...agents.flatMap(agent => this.store.requests(agent.id)) ] };
  }
  private presentMessages(id: string) {
    const messages = this.store.messages(id);
    const runs = this.store.runs(id);
    const quest = this.get(id);
    // Old runs lack a message ID. Require a unique prompt/time association in both directions.
    // This is presentation-only: never rewrite stored or native model conversation records.
    const links = runs.map(run => {
      if (run.data.messageId) return messages.filter(message => message.id === run.data.messageId);
      const queuedAt = run.data.queuedAt ?? run.data.startedAt;
      if (typeof queuedAt !== 'number' || typeof run.data.prompt !== 'string') return [];
      return messages.filter(message => message.role === 'user' && message.text === run.data.prompt && message.createdAt <= queuedAt && queuedAt - message.createdAt <= 1000);
    });
    const provenance = new Map<string, MessagePresentation>();
    for (let index = 0; index < runs.length; index++) {
      if (links[index].length !== 1) continue;
      const message = links[index][0];
      if (message.source !== undefined || links.filter(matches => matches.some(match => match.id === message.id)).length !== 1) continue;
      const run = runs[index].data;
      if (run.messageSource) {
        provenance.set(message.id, { source: run.messageSource, ...(run.displayText !== undefined ? { displayText: run.displayText } : {}) });
        continue;
      }
      const command = run.commandId ? this.store.command(run.commandId) : undefined;
      const resumeFingerprint = run.commandId ? createHash('sha256').update(JSON.stringify([`resume:${id}`, { commandId: run.commandId }])).digest('hex') : undefined;
      const internalHandoff = run.commandId?.startsWith('delegates:') && !command && typeof run.sourcePrompt === 'string' && run.sourcePrompt !== run.prompt;
      if (internalHandoff || (command && command.fingerprint === resumeFingerprint)) provenance.set(message.id, { source: 'system' });
      else if (index === 0 && quest.kind === 'delegate' && quest.parentQuestId) provenance.set(message.id, { source: 'quest_lead', displayText: quest.objective });
      else if (index === 0 && quest.sourceRequest && run.prompt === delegatedPrompt(quest.objective, quest.sourceRequest)) provenance.set(message.id, { source: 'guildmaster', displayText: quest.objective });
    }
    return messages.map(message => provenance.has(message.id) ? { ...message, ...provenance.get(message.id) } : message);
  }
  private clearLive(id: string) {
    if (this.partialMessages.delete(id)) this.emit('live', { questId: id, live: null });
  }
  private updateLive(id: string, runId: string, messageId: string, text: string) {
    const live = { runId, messageId, text };
    this.partialMessages.set(id, live); this.emit('live', { questId: id, live });
  }
  delegationSource(gm: Quest): DelegationSource {
    const run = gm.activeRunId ? this.store.getRun(gm.activeRunId) : undefined;
    if (!run || run.questId !== gm.id || typeof run.data.prompt !== 'string') throw new AppError('The originating Guildmaster run is no longer available.',409);
    return { questId: gm.id, runId: gm.activeRunId!, text: run.data.sourcePrompt ?? run.data.prompt };
  }
  changed(id: string) { this.emit('change', { questId: id }); const parent = this.store.get(id)?.parentQuestId; if (parent) this.emit('change', { questId: parent }); }
  async saveProject(input: Record<string, unknown>, id?: string) {
    return this.serialize(async () => {
      const command = this.checkCommand(input.commandId, id ? `edit:project:${id}` : 'create:project', input);
      if (command.cached) return command.cached;
      const previous = id ? this.store.project(id) : undefined;
      if (id && !previous) throw new AppError('Project not found.', 404);
      if (previous) requireActiveProject(previous);
      const project = await validateProject(this.store, input, previous);
      const response = { project };
      this.store.transaction(() => { this.store.saveProject(project); this.store.saveCommand(command.id, command.fingerprint, response); });
      this.emit('change', { projectId: project.id });
      return response;
    });
  }
  async addProjectRepositories(input: Record<string, unknown>, reference: string) {
    return this.serialize(async () => {
      const projectReference = text(reference, 'Project', 200);
      const command = this.checkCommand(input.commandId, `add:project-repositories:${projectReference}`, input);
      if (command.cached) return command.cached;
      const previous = resolveProject(this.store, projectReference);
      requireActiveProject(previous);
      if (!Array.isArray(input.repositories) || !input.repositories.length || input.repositories.length > 20) throw new AppError('Add between 1 and 20 repositories.');
      if (input.repositories.some(repository => repository && typeof repository === 'object' && 'id' in repository)) throw new AppError('Omit repository IDs when adding new repositories. Existing repositories stay unchanged.');
      const project = await validateProject(this.store, { ...previous, repositories: [...previous.repositories, ...input.repositories] }, previous);
      if (previous.repositories.some((repository, index) => project.repositories[index].path !== repository.path)) throw new AppError('An existing repository now points to a different folder. Update its project settings before adding repositories.', 409);
      const response = { project };
      this.store.transaction(() => { this.store.saveProject(project); this.store.saveCommand(command.id, command.fingerprint, response); });
      this.emit('change', { projectId: project.id });
      return response;
    });
  }
  async projectAction(reference: string, action: 'archive' | 'restore', input: Record<string, unknown>) {
    return this.serialize(() => {
      const projectReference = text(reference, 'Project', 200);
      const command = this.checkCommand(input.commandId, `${action}:project:${projectReference}`, input);
      if (command.cached) return command.cached;
      const project = { ...resolveProject(this.store, projectReference) };
      if (action === 'archive' && !project.archivedAt) {
        project.archivedAt = Date.now(); project.updatedAt = Date.now();
      } else if (action === 'restore' && project.archivedAt) {
        delete project.archivedAt; project.updatedAt = Date.now();
      }
      const response = { project };
      this.store.transaction(() => { this.store.saveProject(project); this.store.saveCommand(command.id, command.fingerprint, response); });
      this.emit('change', { projectId: project.id });
      return response;
    });
  }
  async settleWorker(id: string) {
    const live = this.live.get(id);
    if (live && !['running','awaiting_input'].includes(this.get(id).status)) {
      // A final result can arrive just before process exit. Keep the writer lock until exit.
      if (live.child.connected) live.child.send({ type: 'cancel' }, () => {});
      const timer = setTimeout(() => { try { process.kill(-live.child.pid!, 'SIGKILL'); } catch { live.child.kill('SIGKILL'); } }, 3000);
      await live.done; clearTimeout(timer);
    }
  }
  checkCommand(commandId: unknown, action: string, payload: unknown): { id: string; fingerprint: string; cached?: any } {
    const id = text(commandId, 'Command ID', 200);
    const fingerprint = createHash('sha256').update(JSON.stringify([action, payload])).digest('hex');
    const existing = this.store.command(id);
    if (existing && existing.fingerprint !== fingerprint) throw new AppError('This command ID already belongs to a different request.', 409);
    return { id, fingerprint, cached: existing?.response };
  }
  checkAvailable(q: Quest) {
    if (this.live.has(q.id) || q.activeRunId || q.status === 'waiting') throw new AppError('This agent already has active or queued work. Wait for its result or cancel the run.', 409);
    for (const root of workspaceRoots(q)) {
      if (directory(root) !== root) throw new AppError('A saved workspace now points to another directory. Restore its original location before resuming.', 409);
    }
  }
  private canLaunch(q: Quest) {
    if (this.live.has(q.id) || this.live.size >= this.maxWorkers) return false;
    if (q.kind !== 'guildmaster' && [...this.live.keys()].filter(id => this.get(id).kind !== 'guildmaster').length >= this.maxWorkers - 1) return false;
    return !writes(q) || ![...this.live.keys()].some(id => {
      const other = this.get(id);
      return writes(other) && workspaceRoots(other).some(left => workspaceRoots(q).some(right => sameTree(left, right)));
    });
  }
  private queueReason(q:Quest) {
    if (q.status !== 'queued') return undefined;
    if (writes(q) && [...this.live.keys()].some(id=>id!==q.id && writes(this.get(id)) && workspaceRoots(this.get(id)).some(a=>workspaceRoots(q).some(b=>sameTree(a,b))))) return 'Waiting for workspace';
    return 'Waiting for an available worker';
  }
  private setup<T>(commandId:unknown, action:string, payload:unknown, operation:()=>Promise<T>):Promise<T> {
    const command = this.checkCommand(commandId,action,payload);
    if (command.cached) return Promise.resolve(command.cached);
    const pending = this.setups.get(command.id);
    if (pending) {
      if (pending.fingerprint !== command.fingerprint) throw new AppError('This command ID already belongs to a different request.',409);
      return pending.task;
    }
    const task = operation().finally(()=>this.setups.delete(command.id));
    this.setups.set(command.id,{fingerprint:command.fingerprint,task});
    return task;
  }
  private setupGuard(parent:Quest) {
    return () => {
      const current = this.get(parent.id);
      if (this.stopping || current.archivedAt || current.activeRunId !== parent.activeRunId || current.runCount !== parent.runCount || !['running','awaiting_input','waiting'].includes(current.status)) throw new AppError('The requesting lead is no longer active. Workspace preparation stopped.',409);
    };
  }
  schedule() {
    if (this.stopping || this.scheduling) return;
    this.scheduling = true;
    try {
      while (true) {
        this.wakeParents();
        const queued = this.store.list().filter(q => q.status === 'queued' && q.activeRunId && this.canLaunch(q)).sort((a,b) => a.updatedAt - b.updatedAt);
        const next = queued.find(q => q.kind === 'guildmaster') ?? queued.sort((a,b) => (this.familyTurns.get(a.parentQuestId ?? a.id) ?? 0) - (this.familyTurns.get(b.parentQuestId ?? b.id) ?? 0))[0];
        if (!next) break;
        this.familyTurns.set(next.parentQuestId ?? next.id, ++this.scheduleTurn);
        const run = this.store.getRun(next.activeRunId!);
        try {
          for (const root of workspaceRoots(next)) if (directory(root) !== root) throw new AppError('A queued workspace now points to another directory.');
          next.status = 'running'; this.store.save(next);
          this.store.run(next.activeRunId!, next.id, { status: 'running', startedAt: Date.now() });
          this.store.event(next.id, 'run_started', `Run ${next.runCount} started.`);
          this.launch(next, run?.data.prompt ?? next.objective);
        } catch (error) { this.fail(next.id, next.activeRunId!, String(error)); }
      }
    } finally { this.scheduling = false; }
  }
  private lead(id: string, expectedRunId?: string) {
    const parent = this.get(id);
    if (parent.kind !== 'quest') throw new AppError('Only quest leads can delegate work.', 403);
    if (parent.archivedAt || parent.status === 'cancelled') throw new AppError('Restore or reopen the parent quest before delegating.', 409);
    if (expectedRunId && (parent.activeRunId !== expectedRunId || !['running','awaiting_input'].includes(parent.status))) throw new AppError('This lead run is no longer active.', 403);
    return parent;
  }
  async createFollowup(parentId: string, input: Record<string, unknown>, expectedRunId: string) {
    this.lead(parentId, expectedRunId);
    return this.setup(input.commandId, `followup:${parentId}`, input, async () => {
      const parent = this.lead(parentId, expectedRunId);
      // The model must interpret the user's intent. The service verifies provenance:
      // inherited briefs, delegate results, and tool output cannot supply approval.
      const user = this.presentMessages(parentId).findLast(message => message.role === 'user' && (!message.source || message.source === 'user'));
      const quote = text(input.userRequest, 'User request');
      if (!user || user.text.trim() !== quote) throw new AppError('Quote the entire latest direct user message explicitly asking for these follow-up quests. Findings and inherited briefs are not authorization.',403);
      if (!['isolated','shared'].includes(String(input.workspacePolicy))) throw new AppError('Choose a workspace policy.');
      if (input.repositoryIds !== undefined && (!Array.isArray(input.repositoryIds) || input.repositoryIds.some(id => typeof id !== 'string'))) throw new AppError('Repository IDs must be a list of strings.');
      const projectId = input.projectId === undefined ? parent.project?.id ?? null : input.projectId;
      if (projectId !== null && typeof projectId !== 'string') throw new AppError('Select a registered project.');
      const inherited = projectId === parent.project?.id ? parent.workspaces?.map(w => w.repositoryId) : undefined;
      const repositoryIds = (input.repositoryIds as string[] | undefined) ?? inherited;
      if (!projectId && repositoryIds?.length) throw new AppError('Select a project for repository work.');
      const title = text(input.title,'Title',160);
      const objective = text(input.objective,'Objective');
      // Normalize identical retries even when a model repeats a call with a new tool ID.
      const commandId = 'followup:' + createHash('sha256').update(JSON.stringify([parentId,expectedRunId,user.id,title,objective,projectId,repositoryIds,input.workspacePolicy])).digest('hex');
      const created = await this.create({
        title, objective, projectId, workspacePolicy:input.workspacePolicy as 'isolated'|'shared',
        ...(projectId ? {repositories:repositoryIds?.map(repositoryId => ({repositoryId}))} : {workspaceMode:'none'}),
        tools:[...parent.tools], model:parent.model, instructions:parent.instructions, commandId,
      }, 'quest', undefined, {role:'quest',questId:parentId,runId:expectedRunId,text:user.text});
      const command = this.checkCommand(input.commandId, `followup:${parentId}`, input);
      this.store.saveCommand(command.id, command.fingerprint, created);
      this.changed(parentId);
      return created;
    });
  }
  async createDelegate(parentId: string, input: { title?: unknown; objective: unknown; repositoryIds?: unknown; tools?: unknown; isolation?: unknown; commandId: string }, expectedRunId?: string) {
    this.lead(parentId,expectedRunId);
    return this.setup(input.commandId, `delegate:${parentId}`, input, async () => {
      const {parent,command,q,requests} = await this.serialize(() => {
        const parent = this.lead(parentId, expectedRunId);
        const command = this.checkCommand(input.commandId, `delegate:${parentId}`, input);
        if (this.agents(parentId).length + (this.pendingDelegates.get(parentId) ?? 0) >= MAX_SUBAGENTS) throw new AppError('This quest already has five delegates. Continue an existing delegate instead.', 409);
        if (!['running','awaiting_input','waiting'].includes(parent.status)) throw new AppError('Start or resume the quest lead before adding delegates.', 409);
        const objective = text(input.objective, 'Objective');
        const tools = input.tools ?? parent.tools;
        if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !parent.tools.includes(tool))) throw new AppError(`Delegate tools must be a subset of the lead capabilities. Use exact lowercase names. Allowed tools: ${parent.tools.join(', ') || '(none)'}. Omit tools to inherit the lead capabilities.`, 403);
        let workspaces = selectedWorkspaces(parent);
        if (input.repositoryIds !== undefined) {
          if (!Array.isArray(input.repositoryIds) || !input.repositoryIds.length || input.repositoryIds.some(id => typeof id !== 'string') || new Set(input.repositoryIds).size !== input.repositoryIds.length) throw new AppError('Select one or more distinct repository IDs.');
          const ids = input.repositoryIds as string[];
          if (ids.some(id => !workspaces.some(w => w.repositoryId === id))) throw new AppError('A delegate can only use repositories selected for its parent quest.', 403);
          workspaces = workspaces.filter(w => ids.includes(w.repositoryId));
        }
        const inherited = parent.workspacePolicy === 'isolated'
          ? parent.isolation?.filter(r => workspaces.some(w => w.repositoryId === r.repositoryId)) : undefined;
        if (parent.workspacePolicy === 'isolated' && inherited?.length !== workspaces.length) throw new AppError('The quest has no pinned revision for a selected repository.',409);
        const requests = input.isolation === undefined ? inherited : isolationRequests(input.isolation,workspaces);
        if (inherited && requests && (requests.length !== inherited.length || requests.some(r => !inherited.some(saved => saved.repositoryId === r.repositoryId && saved.commit === r.commit)))) throw new AppError('Select the repository revision on the quest before delegating. Delegates inherit that revision.',409);
        const id = randomUUID(); const first = workspaces[0];
        const q: Quest = {
          id, parentQuestId: parentId, kind: 'delegate', title: input.title ? text(input.title, 'Title', 160) : objective.split('\n')[0].slice(0,90), objective,
          status: 'queued', tools: [...new Set(tools)] as string[], model: parent.model, instructions: parent.instructions,
          workspacePolicy: parent.workspacePolicy, project: parent.project, guidanceRevision: parent.guidanceRevision, workspaces: parent.workspaces || requests ? workspaces : undefined,
          workspaceMode: first?.mode ?? parent.workspaceMode, workspacePath: first?.workspacePath ?? parent.workspacePath,
          sourcePath: first?.sourcePath ?? parent.sourcePath, branch: first ? first.branch : parent.branch,
          sessionPath: join(this.dataDir, 'sessions', id, 'session.jsonl'), createdAt: Date.now(), updatedAt: Date.now(), runCount: 0,
        };
        this.pendingDelegates.set(parentId,(this.pendingDelegates.get(parentId) ?? 0)+1);
        return {parent,command,q,requests};
      });
      let prepared: Awaited<ReturnType<typeof prepareIsolatedWorkspaces>> | undefined;
      let saved = false;
      let reserved = true;
      const releaseReservation = () => {
        if (!reserved) return;
        reserved = false;
        const remaining = (this.pendingDelegates.get(parentId) ?? 1)-1;
        if (remaining > 0) this.pendingDelegates.set(parentId,remaining); else this.pendingDelegates.delete(parentId);
      };
      try {
        const assertActive = this.setupGuard(parent);
        if (requests) {
          prepared = await prepareIsolatedWorkspaces({dataDir:this.dataDir,workspaces:selectedWorkspaces(q),requests,guidance:await readGuidance(this.dataDir,parent.guidanceRevision!),assertActive});
          Object.assign(q,{workspaces:prepared.workspaces,guidanceRevision:prepared.guidanceRevision,outputPath:prepared.outputPath,isolation:requests});
          const first = prepared.workspaces[0];
          Object.assign(q,{workspacePath:first.workspacePath,workspaceMode:first.mode,sourcePath:first.sourcePath,branch:first.branch});
        }
        return await this.serialize(() => {
          assertActive();
          const currentParent = this.lead(parentId,expectedRunId);
          if (parent.workspacePolicy === 'isolated' && requests?.some(r => !currentParent.isolation?.some(saved => saved.repositoryId === r.repositoryId && saved.commit === r.commit))) throw new AppError('The quest revision changed during assignment preparation. Retry the assignment.',409);
          const source = currentParent.activeRunId ? this.delegationSource(currentParent) : undefined;
          this.checkAvailable(q);
          this.store.transaction(() => {
            this.store.save(q); this.prepare(q, delegatedPrompt(q.objective, source), command.id, undefined, undefined, { source: 'quest_lead', displayText: q.objective });
            if (currentParent.status === 'waiting') { currentParent.waitForAgentIds = [...new Set([...(currentParent.waitForAgentIds ?? []), q.id])]; this.store.save(currentParent); }
            this.store.event(parentId, 'delegate_created', `Delegated to ${q.title}.`);
            if (requests) this.store.event(q.id,'workspace',`Isolated workspaces prepared at ${requests.map(r=>r.commit).join(', ')}. Output: ${q.outputPath}`);
            this.store.saveCommand(command.id, command.fingerprint, { agent: q });
          });
          saved = true;
          releaseReservation();
          this.schedule(); this.changed(parentId); return { agent: this.get(q.id) };
        });
      } finally {
        releaseReservation();
        if (prepared && !saved) await prepared.cleanup();
      }
    });
  }
  async createWorkspace(parentId:string, input:{repositoryId:unknown;commit:unknown;commandId:string}, expectedRunId?:string) {
    this.lead(parentId,expectedRunId);
    return this.setup(input.commandId,`workspace:${parentId}`,input,async()=>{
      const {parent,command,workspaces,requests} = await this.serialize(()=>{
        const parent = this.lead(parentId,expectedRunId);
        if (!['running','awaiting_input'].includes(parent.status)) throw new AppError('Start the lead before preparing a workspace.',409);
        const workspaces = selectedWorkspaces(parent).filter(w=>w.repositoryId===input.repositoryId);
        const requests = isolationRequests([input],workspaces);
        return {parent,command:this.checkCommand(input.commandId,`workspace:${parentId}`,input),workspaces,requests};
      });
      const assertActive = this.setupGuard(parent);
      if (parent.workspacePolicy === 'isolated' && parent.isolation?.some(r => r.repositoryId === requests[0].repositoryId && r.commit === requests[0].commit)) {
        const existing = [...(parent.preparedWorkspaces ?? [])].reverse().find(w => w.repositoryId === requests[0].repositoryId && w.commit === requests[0].commit)
          ?? workspaces.find(w => w.commit === requests[0].commit);
        if (existing) {
          const workspace:PreparedWorkspace = 'guidanceRevision' in existing ? existing as PreparedWorkspace : {...existing,id:parent.guidanceRevision!,guidanceRevision:parent.guidanceRevision!,outputPath:parent.outputPath!};
          const response = {workspace,guidance:await readGuidance(this.dataDir,workspace.guidanceRevision)};
          return this.serialize(() => {assertActive();this.store.saveCommand(command.id,command.fingerprint,response);return response;});
        }
      }
      const prepared = await prepareIsolatedWorkspaces({dataDir:this.dataDir,workspaces,requests,guidance:await readGuidance(this.dataDir,parent.guidanceRevision!),assertActive});
      let saved = false;
      try {
        return await this.serialize(()=>{
          assertActive();
          const current = this.get(parentId);
          const workspace:PreparedWorkspace = {...prepared.workspaces[0],id:prepared.guidanceRevision,guidanceRevision:prepared.guidanceRevision,outputPath:prepared.outputPath};
          if (current.workspacePolicy === 'isolated') {
            const before = parent.isolation?.find(r => r.repositoryId === workspace.repositoryId)?.commit;
            const now = current.isolation?.find(r => r.repositoryId === workspace.repositoryId)?.commit;
            if (before !== now) throw new AppError('The repository revision changed during preparation. Retry with the intended revision.',409);
            current.isolation = [...(current.isolation ?? []).filter(r => r.repositoryId !== workspace.repositoryId), {repositoryId:workspace.repositoryId,commit:workspace.commit!}];
          }
          current.preparedWorkspaces = [...(current.preparedWorkspaces ?? []),workspace];
          const response = {workspace,guidance:prepared.guidance};
          this.store.transaction(()=>{
            this.store.save(current); this.store.event(parentId,'workspace',`Prepared ${workspace.workspacePath} at ${workspace.commit}. Current working directory is unchanged.`);
            this.store.saveCommand(command.id,command.fingerprint,response);
          });
          saved = true; this.changed(parentId); return response;
        });
      } finally { if (!saved) await prepared.cleanup(); }
    });
  }
  async continueDelegate(parentId: string, id: string, input: { message?: unknown; freshContext?: unknown; isolation?: unknown; commandId: string }, expectedRunId?: string) {
    this.lead(parentId,expectedRunId);
    if (this.get(id).parentQuestId !== parentId) throw new AppError('This delegate belongs to another quest.',403);
    return this.setup(input.commandId,`continue:${id}`,input,async()=>{
      const snapshot = await this.serialize(()=>{
        const parent = this.lead(parentId,expectedRunId); const child = this.get(id);
        if (child.parentQuestId !== parentId) throw new AppError('This delegate belongs to another quest.',403);
        const inherited = parent.workspacePolicy === 'isolated'
          ? parent.isolation?.filter(r => selectedWorkspaces(child).some(w => w.repositoryId === r.repositoryId)) : undefined;
        const changedRevision = inherited?.some(r => !child.isolation?.some(old => old.repositoryId === r.repositoryId && old.commit === r.commit));
        if (changedRevision && input.freshContext !== true) throw new AppError('The quest revision has changed. Use freshContext=true to start this assignment at the current revision.',409);
        if (input.isolation !== undefined && input.freshContext !== true) throw new AppError('Choose freshContext=true when replacing an assignment workspace.');
        const raw = input.isolation ?? (input.freshContext === true ? inherited ?? child.isolation : undefined);
        if (inherited && raw) {
          const requested = isolationRequests(raw,selectedWorkspaces(child));
          if (requested.length !== inherited.length || requested.some(r => !inherited.some(saved => saved.repositoryId === r.repositoryId && saved.commit === r.commit))) throw new AppError('Delegates must use the quest’s selected repository revisions.',409);
        }
        if (!raw) return undefined;
        this.checkAvailable(child);
        return {parent,child,requests:isolationRequests(raw,selectedWorkspaces(child))};
      });
      if (!snapshot) return this.continue(id,input,false,undefined,{parentId,expectedRunId});
      const guard = () => {
        if (this.stopping) throw new AppError('Service is stopping.',503);
        this.lead(parentId,expectedRunId);
        if (snapshot.parent.workspacePolicy === 'isolated' && snapshot.requests.some(r => !this.get(parentId).isolation?.some(saved => saved.repositoryId === r.repositoryId && saved.commit === r.commit))) throw new AppError('The quest revision changed during assignment preparation. Retry.',409);
        if (this.get(parentId).runCount !== snapshot.parent.runCount) throw new AppError('The requesting lead changed during workspace preparation.',409);
        const child = this.get(id);
        if (child.runCount !== snapshot.child.runCount || child.status !== snapshot.child.status || child.archivedAt || this.live.has(id) || child.activeRunId) throw new AppError('The assignment changed during workspace preparation.',409);
      };
      const replacement = await prepareIsolatedWorkspaces({dataDir:this.dataDir,workspaces:selectedWorkspaces(snapshot.child),requests:snapshot.requests,guidance:await readGuidance(this.dataDir,snapshot.child.guidanceRevision!),assertActive:guard});
      try {
        return await this.continue(id,input,false,undefined,{parentId,expectedRunId,replacement:{...replacement,isolation:snapshot.requests,guard}});
      } finally { if (this.get(id).guidanceRevision !== replacement.guidanceRevision) await replacement.cleanup(); }
    });
  }
  async waitForAgents(parentId: string, input: { agentIds?: unknown; commandId: string }, expectedRunId?: string) {
    return this.serialize(() => {
      const parent = this.lead(parentId, expectedRunId);
      const command = this.checkCommand(input.commandId, `wait:${parentId}`, input);
      if (command.cached) return command.cached;
      const all = this.agents(parentId);
      if (!all.length) throw new AppError('No delegates have been created. Call delegate_task successfully before waiting.');
      const ids = input.agentIds ?? all.map(agent => agent.id);
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !all.some(agent => agent.id === id)) || new Set(ids).size !== ids.length) throw new AppError('Choose one or more delegates belonging to this quest.');
      const agents = all.filter(agent => ids.includes(agent.id)); const waiting = agents.some(agent => !terminalAgent(agent));
      const questions = agents.flatMap(agent => this.store.requests(agent.id).filter(r => r.status === 'pending'));
      const response = { waiting: waiting && !questions.length, agents, questions };
      this.store.transaction(() => {
        if (waiting && !questions.length) parent.waitForAgentIds = ids as string[];
        else {
          parent.consumedDelegateRuns ??= {};
          for (const agent of agents.filter(terminalAgent)) parent.consumedDelegateRuns[agent.id] = agent.runCount;
          delete parent.waitForAgentIds;
        }
        this.store.save(parent); this.store.saveCommand(command.id, command.fingerprint, response);
      });
      return response;
    });
  }
  private suspendLead(q: Quest, runId: string, ids: string[]) {
    this.clearLive(q.id); this.store.interruptToolCalls(q.id, runId);
    q.waitForAgentIds = ids; q.status = 'waiting'; q.activeRunId = undefined;
    this.store.save(q); this.store.run(runId, q.id, { status: 'waiting', endedAt: Date.now() });
    this.store.event(q.id, 'waiting', 'Waiting for delegated work.');
    // The writer lock remains held until the yielding process actually exits.
    this.stopWorker(q.id);
  }
  private wakeParents() {
    if (this.stopping) return;
    for (const parent of this.store.list().filter(q => q.kind === 'quest' && q.status === 'waiting' && !this.live.has(q.id))) {
      const selected = this.agents(parent.id).filter(agent => parent.waitForAgentIds?.includes(agent.id));
      const questions = selected.flatMap(agent => this.store.requests(agent.id).filter(r => r.status === 'pending'));
      const newQuestions = questions.filter(r => !parent.routedQuestionIds?.includes(r.id));
      if (!selected.length || (!newQuestions.length && (questions.length || selected.some(agent => !terminalAgent(agent) || this.live.has(agent.id))))) continue;
      // Do not restart the lead until asking delegates have released their worker locks.
      if (newQuestions.some(r => this.live.has(r.questId))) continue;
      const prompt = `${questions.length ? 'Delegates need your input. Resolve their questions with answer_agent. Ask the user yourself only for a genuine user decision or approval. Questions: ' + JSON.stringify(questions) + '\n\n' : ''}Your delegated work has returned. Continue the same quest, assess these reports, and inspect actual work before declaring the result ready. Resume or correct a delegate when useful; do not repeat completed work unnecessarily.\n\n${selected.map(agent => JSON.stringify({ id: agent.id, title: agent.title, status: agent.status, run: agent.runCount, result: agent.status === 'completed' ? agent.result : undefined, error: agent.error })).join('\n\n')}`;
      this.store.transaction(() => {
        parent.consumedDelegateRuns ??= {};
        for (const agent of selected.filter(terminalAgent)) parent.consumedDelegateRuns[agent.id] = agent.runCount;
        parent.routedQuestionIds = [...new Set([...(parent.routedQuestionIds ?? []), ...newQuestions.map(r => r.id)])];
        delete parent.waitForAgentIds;
        this.prepare(parent, prompt, `delegates:${randomUUID()}`, undefined, this.store.lastRun(parent.id)?.data.sourcePrompt ?? parent.objective, { source: 'system' });
        this.store.event(parent.id, 'delegates_returned', 'Delegates returned; the lead will review their work.');
      });
      this.changed(parent.id);
    }
  }
  private async addWorktree(source: string, id: string, repositoryId: string | undefined, created: CreatedWorktree[]) {
    await requireWorktreeSource(source);
    const branch = `guildmaster/${id.slice(0, 8)}${repositoryId ? `/${repositoryId.slice(0, 8)}` : ''}`;
    const path = repositoryId ? join(this.dataDir, 'worktrees', id, repositoryId) : join(this.dataDir, 'worktrees', id);
    if (existsSync(path)) throw new AppError('The new worktree location already exists.', 409);
    const branches = await exec('git', ['branch', '--list', branch], { cwd: source, timeout: 10000 });
    if (branches.stdout.trim()) throw new AppError('The new worktree branch already exists.', 409);
    mkdirSync(dirname(path), { recursive: true });
    // Track our generated path before Git runs: a failed add can still create its branch.
    created.push({ source, path, branch });
    try { await exec('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd: source, timeout: 30000 }); }
    catch (error) { throw new AppError(`Could not create the worktree: ${error instanceof Error ? error.message : String(error)}`); }
    return { workspacePath: directory(path), branch };
  }
  private async rollbackWorktrees(created: CreatedWorktree[]) {
    for (const item of [...created].reverse()) {
      try { await exec('git', ['worktree', 'remove', '--force', item.path], { cwd: item.source, timeout: 10000 }); } catch {}
      try { await exec('git', ['branch', '-D', item.branch], { cwd: item.source, timeout: 10000 }); } catch {}
    }
  }
  private async workspaceSelection(input: Pick<CreateQuest, 'projectId' | 'repositories' | 'workspaceMode' | 'workspacePath'>, id: string, kind: Quest['kind'], created: CreatedWorktree[]) {
    const mode = input.workspaceMode ?? 'existing';
    if (!['existing', 'worktree', 'none'].includes(mode)) throw new AppError('Unknown workspace mode.');
    const reference = input.projectId;
    if (reference !== undefined && reference !== null) {
      const project = resolveProject(this.store, reference);
      requireActiveProject(project);
      if (mode === 'none' && Array.isArray(input.repositories) && input.repositories.length) throw new AppError('Choose repository workspaces or no workspace, not both.');
      const selected = selectedRepositories(project, input.repositories === undefined ? (mode === 'none' ? [] : undefined) : input.repositories);
      const workspaces: QuestWorkspace[] = [];
      for (const { repository, mode: selectedMode } of selected) {
        const sourcePath = directory(repository.path);
        if (sourcePath !== repository.path) throw new AppError('A registered repository now points to another directory. Update the project before starting work.', 409);
        const workspace = kind === 'quest' && selectedMode === 'worktree'
          ? await this.addWorktree(sourcePath, id, repository.id, created) : { workspacePath: sourcePath };
        workspaces.push({ repositoryId: repository.id, name: repository.name, ...(repository.description ? { description: repository.description } : {}), sourcePath, mode: selectedMode, ...workspace });
      }
      const first = workspaces[0];
      const scratch = join(this.dataDir, 'workspaces', id);
      if (!first) mkdirSync(scratch, { recursive: true });
      return {
        project: { id: project.id, name: project.name, instructions: project.instructions }, workspaces,
        workspaceMode: first?.mode ?? 'none', workspacePath: first?.workspacePath ?? directory(scratch),
        sourcePath: first?.sourcePath ?? directory(scratch), branch: first?.branch,
      };
    }
    if (input.repositories !== undefined) throw new AppError('Choose a project before selecting repositories.');
    const source = mode === 'none' ? join(this.dataDir, 'workspaces', id) : directory(input.workspacePath ?? this.defaultWorkspace);
    if (mode === 'none') mkdirSync(source, { recursive: true });
    const workspace = mode === 'worktree' && kind === 'quest' ? await this.addWorktree(source, id, undefined, created) : { workspacePath: directory(source) };
    return { project: undefined, workspaces: undefined, workspaceMode: mode as WorkspaceMode, sourcePath: directory(source), branch: undefined, ...workspace };
  }
  private async createIsolated(input: CreateQuest, originalInput?: Record<string, unknown>, sourceRequest?: DelegationSource, images: ImageUpload[] = [], dispatch?: ScheduledDispatch) {
    const payload = sourceRequest ? {input,source:sourceRequest} : originalInput ?? input;
    return this.setup(input.commandId,'create:quest',payload,async () => {
      const snapshot = await this.serialize(async () => {
        dispatch?.assertActive();
        const objective = imageMessage(input.objective,images,'Objective');
        const tools = input.tools ?? DEFAULT_TOOLS;
        if (!Array.isArray(tools) || tools.some(t => !ALLOWED_TOOLS.includes(t))) throw new AppError('Unknown tool capability.');
        if (input.workspaceMode === 'none' || input.repositories?.some(r => r.mode === 'worktree')) throw new AppError('Isolated quests select repository sources; omit individual workspace modes.');
        const id = randomUUID();
        // Select trusted source folders without creating or locking a shared execution workspace.
        const selected = await this.workspaceSelection({...input,workspaceMode:'existing'},id,'quest',[]);
        const workspaces = selectedWorkspaces({...selected} as Quest);
        if (!workspaces.length) throw new AppError('Choose at least one repository for an isolated quest.');
        const overrides = input.revisions === undefined ? [] : isolationRequests(input.revisions,workspaces);
        const requests:IsolationRequest[] = [];
        for (const workspace of workspaces) {
          const supplied = overrides.find(r => r.repositoryId === workspace.repositoryId)?.commit;
          const commit = supplied ?? (await exec('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:workspace.sourcePath,timeout:10000})).stdout.trim();
          requests.push({repositoryId:workspace.repositoryId,commit});
        }
        const guidance = discoverGuidance(workspaces,{agentDir:join(this.dataDir,'engine')});
        return {id,objective,tools,selected,workspaces,requests,guidance};
      });
      const assertActive = () => {
        if (this.stopping) throw new AppError('Service is stopping.',503);
        dispatch?.assertActive();
        if (sourceRequest) {
          const gm = this.get(sourceRequest.questId);
          if (gm.activeRunId !== sourceRequest.runId || !['running','awaiting_input'].includes(gm.status)) throw new AppError('The originating request stopped during workspace preparation.',409);
        }
      };
      const prepared = await prepareIsolatedWorkspaces({dataDir:this.dataDir,workspaces:snapshot.workspaces,requests:snapshot.requests,guidance:snapshot.guidance,assertActive});
      let saved = false;
      try {
        return await this.serialize(() => {
          assertActive();
          if (snapshot.selected.project) requireActiveProject(resolveProject(this.store,snapshot.selected.project.id));
          const first = prepared.workspaces[0];
          const q:Quest = {
            ...snapshot.selected,id:snapshot.id,title:input.title ? text(input.title,'Title',160) : snapshot.objective.split('\n')[0].slice(0,90),
            objective:snapshot.objective,kind:'quest',workspacePolicy:'isolated',workspaces:prepared.workspaces,
            workspacePath:first.workspacePath,workspaceMode:'worktree',sourcePath:first.sourcePath,branch:undefined,
            guidanceRevision:prepared.guidanceRevision,outputPath:prepared.outputPath,isolation:snapshot.requests,
            model:typeof input.model === 'string' ? input.model.trim().slice(0,250) : '',tools:[...new Set(snapshot.tools)],
            instructions:typeof input.instructions === 'string' ? input.instructions.slice(0,20000) : '',
            createdAt:Date.now(),updatedAt:Date.now(),status:'queued',runCount:0,
            sessionPath:join(this.dataDir,'sessions',snapshot.id,'session.jsonl'),...(dispatch ? {schedule:dispatch.origin} : {}),...(sourceRequest ? {sourceRequest} : {}),
          };
          this.checkAvailable(q);
          const command = this.checkCommand(input.commandId,'create:quest',payload);
          this.store.transaction(() => {
            this.store.save(q);
            this.store.event(q.id,'created','Private workspaces prepared. Delegates inherit isolated workspaces at the selected revisions.');
            this.prepare(q,delegatedPrompt(q.objective,sourceRequest),command.id,undefined,undefined,dispatch ? {source:'schedule',displayText:q.objective} : sourceRequest ? {source:sourceRequest.role === 'quest' ? 'quest_lead' : 'guildmaster',displayText:q.objective} : undefined, images.length ? images : undefined);
            this.store.saveCommand(command.id,command.fingerprint,{quest:q});
            dispatch?.committed(q);
          });
          saved = true; this.schedule(); this.changed(q.id);
          return {quest:this.get(q.id)};
        });
      } finally {if (!saved) await prepared.cleanup();}
    });
  }
  async create(input: CreateQuest, kind: Quest['kind'] = 'quest', originalInput?: Record<string, any>, sourceRequest?: DelegationSource, dispatch?: ScheduledDispatch) {
    const images = validateImages(input.images);
    if (input.workspacePolicy !== undefined && !['shared','isolated'].includes(input.workspacePolicy)) throw new AppError('Unknown workspace policy.');
    if (kind === 'quest' && input.workspacePolicy === 'isolated') return this.createIsolated(input,originalInput,sourceRequest,images,dispatch);
    if (input.revisions !== undefined) throw new AppError('Pinned revisions require isolated workspaces.');
    return this.serialize(async () => {
      const command = this.checkCommand(input.commandId, kind === 'guildmaster' ? 'guildmaster' : 'create:quest', sourceRequest ? {input,source:sourceRequest} : originalInput ?? input);
      if (command.cached) return command.cached;
      dispatch?.assertActive();
      if (kind === 'guildmaster' && this.store.list().some(q => q.kind === 'guildmaster' && !q.archivedAt)) throw new AppError('Guildmaster already started in another request. Retry this message.', 409);
      const objective = imageMessage(input.objective, images, 'Objective');
      const tools = input.tools ?? DEFAULT_TOOLS;
      if (!Array.isArray(tools) || tools.some(t => !ALLOWED_TOOLS.includes(t))) throw new AppError('Unknown tool capability.');
      const id = randomUUID();
      const created: CreatedWorktree[] = [];
      try {
        const workspace = await this.workspaceSelection(input, id, kind, created);
        const q: Quest = {
          id, title: kind === 'guildmaster' ? 'Guildmaster' : input.title ? text(input.title, 'Title', 160) : objective.split('\n')[0].slice(0, 90), objective, kind,
          ...workspace, workspacePolicy:input.workspacePolicy,
          model: typeof input.model === 'string' ? input.model.trim().slice(0, 250) : '', tools: [...new Set(tools)],
          instructions: typeof input.instructions === 'string' ? input.instructions.slice(0, 20000) : '',
          createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', runCount: 0,
          sessionPath: join(this.dataDir, 'sessions', id, 'session.jsonl'),
          ...(sourceRequest ? {sourceRequest} : {}), ...(dispatch ? {schedule:dispatch.origin} : {}),
        };
        if (sourceRequest) {
          const origin = this.get(sourceRequest.questId);
          if (origin.activeRunId !== sourceRequest.runId || !['running','awaiting_input'].includes(origin.status)) throw new AppError('The originating request is no longer active.',409);
        }
        dispatch?.assertActive();
        this.checkAvailable(q);
        const prompt = delegatedPrompt(objective, sourceRequest);
        this.store.transaction(() => {
          this.store.save(q); this.store.event(q.id, 'created', `${q.project ? `Project: ${q.project.name}. ` : ''}Workspace${q.workspaces && q.workspaces.length > 1 ? 's' : ''}: ${workspaceRoots(q).join(', ')}`);
          this.prepare(q, prompt, command.id, undefined, undefined, dispatch ? {source:'schedule',displayText:objective} : sourceRequest ? { source: sourceRequest.role === 'quest' ? 'quest_lead' : 'guildmaster', displayText: objective } : undefined, images.length ? images : undefined);
          this.store.saveCommand(command.id, command.fingerprint, { quest: q });
          dispatch?.committed(q);
        });
        // Once committed, these workspaces belong to a saved quest, even if launching its worker fails.
        created.length = 0;
        this.schedule(); return { quest: this.get(q.id) };
      } catch (error) {
        await this.rollbackWorktrees(created);
        throw error;
      }
    });
  }
  private runImages(runId?: string): ImageUpload[] {
    if (!runId) return [];
    const run = this.store.getRun(runId);
    const messages = run ? this.store.messages(run.questId) : [];
    const index = messages.findIndex(message => message.id === run?.data.messageId);
    // Later requests can refer back to the most recent reference images.
    const message = messages.slice(0,index + 1).findLast(message => !!message.attachments?.length);
    return (message?.attachments ?? []).map(attachment => {
      const image = this.store.image(run!.questId, attachment.id);
      if (!image) throw new AppError('A saved reference image is missing. Attach it again before continuing.',409);
      return { name: image.name, mimeType: image.mimeType, data: Buffer.from(image.data).toString('base64') };
    });
  }
  prepare(q: Quest, prompt: string, commandId: string, delivery?: Delivery, sourcePrompt = prompt, presentation?: MessagePresentation, images?: ImageUpload[]) {
    const inheritedRun = presentation?.source === 'quest_lead' ? (q.parentQuestId ? this.get(q.parentQuestId).activeRunId : q.sourceRequest?.runId)
      : presentation?.source === 'guildmaster' ? q.sourceRequest?.runId : undefined;
    const attachments = this.store.saveImages(q.id, images ?? this.runImages(inheritedRun));
    if (q.kind !== 'guildmaster' && !q.guidanceRevision) {
      const manifest = discoverGuidance(q.workspaces ?? (q.workspaceMode === 'none' ? [] : [{ repositoryId: 'workspace', workspacePath: q.workspacePath, sourcePath: q.sourcePath ?? q.workspacePath }]), { agentDir: join(this.dataDir, 'engine') });
      const revision = randomUUID();
      const folder = join(this.dataDir, 'guidance'); mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, `${revision}.json`), JSON.stringify(manifest), { mode: 0o600 });
      q.guidanceRevision = revision;
    }
    this.clearLive(q.id);
    const previousInlineOrigin=q.activeRunId ? this.inlineReads.origin(q.activeRunId) : this.store.lastRun(q.id)?.id ? this.inlineReads.origin(this.store.lastRun(q.id)!.id) : undefined;
    q.runCount++; q.status = 'queued'; q.error = undefined; q.activeRunId = randomUUID();
    this.store.saveDelivery({ ...(delivery ?? { id: randomUUID(), questId: q.id, commandId, kind: 'prompt', text: prompt, createdAt: Date.now() }), ...(attachments.length ? { attachments } : {}) });
    const message = this.store.message(q.id, 'user', prompt, undefined, { ...presentation, ...(attachments.length ? { attachments } : {}) }); this.store.save(q);
    if(q.kind==='guildmaster')this.inlineReads.bind(q.activeRunId, presentation?.source==='system'&&previousInlineOrigin ? previousInlineOrigin : message.id);
    const available=this.connections?.snapshot() ?? [];
    const inherited=q.parentQuestId ? this.store.lastRun(q.parentQuestId)?.data.connectionGrants ?? [] : available;
    const connectionGrants=inherited.flatMap(grant=>{const current=available.find(c=>c.connectionId===grant.connectionId&&c.teamId===grant.teamId&&c.userId===grant.userId);return current?[{...current,tools:current.tools.filter(t=>grant.tools.some(old=>old.name===t.name))}]:[];});
    this.store.run(q.activeRunId, q.id, { connectionGrants, status: 'queued', prompt, sourcePrompt, commandId, messageId: message.id, messageSource: message.source, displayText: message.displayText, deliveryIds: this.store.pendingDeliveries(q.id).map(delivery => delivery.id), queuedAt: Date.now() });
    this.store.event(q.id, 'queued', `Run ${q.runCount} queued.`);
    return message;
  }
  private questBoardSnapshot() {
    const quests = this.store.list().filter(quest => quest.kind === 'quest').sort((a,b) => b.updatedAt - a.updatedAt);
    return { capturedAt: Date.now(), omitted: Math.max(0, quests.length - 30), quests: quests.slice(0,30).map(quest => ({
      id: quest.id, title: quest.title.slice(0,160), status: quest.status, archivedAt: quest.archivedAt, projectName: quest.project?.name,
    })) };
  }
  private inlineExhausted = (id:string,runId:string,reason:string) => {
    const q=this.store.get(id);if(q?.activeRunId!==runId)return;
    const live=this.live.get(id);
    if(live?.runId===runId&&live.child.connected)live.child.send({type:'inline_exhausted',reason},()=>{});
    this.store.event(id,'inline_budget',`Inline tools exhausted (${reason}). Return partial coverage without further tools.`);
  };
  launch(q: Quest, prompt: string) {
    const runId = q.activeRunId!;
    const token = randomUUID();
    const connectionToken=randomUUID();
    const connectionGrants=this.store.getRun(runId)?.data.connectionGrants ?? [];
    this.inlineReads.onExhausted=this.inlineExhausted;
    const inline=this.inlineReads.attach(q,runId);
    this.connectionTokens.set(connectionToken,{questId:q.id,runId,grants:connectionGrants,controller:new AbortController()});
    try {
      const specDir = join(this.dataDir, 'runs'); mkdirSync(specDir, { recursive: true });
      const path = join(specDir, `${runId}.json`);
      if (q.kind === 'guildmaster') {this.gmTokens.set(token, q.id);this.gmRunTokens.set(token,runId);}
      if (q.kind === 'quest') this.workerTokens.set(token, { questId: q.id, runId });
      writeFileSync(path, JSON.stringify({ questId: q.id, runId, cwd: q.workspacePath, prompt,
        deliveries: this.store.pendingDeliveries(q.id).map(delivery => ({ ...delivery, images: delivery.attachments?.map(attachment => {
          const image = this.store.image(q.id, attachment.id);
          if (!image) throw new AppError('A saved reference image is missing. Attach it again before continuing.',409);
          return { type: 'image', mimeType: image.mimeType, data: Buffer.from(image.data).toString('base64') };
        }) })),
        requireExistingSession: q.sessionStartRun
          ? q.sessionEstablished === true
          : !!q.result || this.store.deliveries(q.id).some(delivery => !!delivery.deliveredAt),
        sessionPath: q.sessionPath, model: q.model, tools: q.tools, instructions: q.instructions,
        ...inline, connectionToken, connectionGrants, role: q.kind, parentQuestId: q.parentQuestId, questBoard: q.kind === 'guildmaster' ? this.questBoardSnapshot() : undefined, serviceUrl: this.serviceUrl, serviceToken: token, workspaceMode: q.workspaceMode,
        sourcePath: q.sourcePath, guidancePath: q.guidanceRevision ? join(this.dataDir, 'guidance', `${q.guidanceRevision}.json`) : undefined,
        agentDir: join(this.dataDir, 'engine'), project: q.project, workspaces: q.workspaces, workspacePolicy:q.workspacePolicy, isolation:q.isolation, preparedWorkspaces:q.preparedWorkspaces, outputPath:q.outputPath,
      }), { mode: 0o600 });
      const child = fork(this.workerPath, [path], {
        execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
        env: { ...process.env, GUILDMASTER_WORKER: '1', GUILDMASTER_INLINE_TOKEN: inline?.inlineToken ?? '' },
      });
      let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
      const live: Live = { child, runId, startedAt: Date.now(), done }; this.live.set(q.id, live);
      // A system resume inherits the original human request's exhausted budget.
      if(q.kind==='guildmaster')try {this.inlineReads.toolBudget(q.id);} catch { /* callback moves worker to final-answer-only */ }
      let stderr = ''; child.stdout?.on('data', () => {});
      child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
      child.on('message', message => { try { this.workerEvent(q.id, runId, message); } catch (error) { this.fail(q.id,runId,`Invalid worker event: ${error}`); this.stopWorker(q.id); } });
      child.on('error', error => this.fail(q.id, runId, error.message));
      // 'close' also fires when spawn fails before a PID exists; 'exit' does not.
      child.on('close', (code, signal) => {
        this.inlineReads.revoke(q.id,runId);
        this.clearLive(q.id); this.store.interruptToolCalls(q.id, runId);
        this.connectionTokens.get(connectionToken)?.controller.abort();this.connectionTokens.delete(connectionToken);
        clearTimeout(live.cancelTimer); this.live.delete(q.id); this.gmRunTokens.delete(token); this.gmTokens.delete(token); this.workerTokens.delete(token);
        const current = this.get(q.id);
        if (current.activeRunId === runId && ['running','awaiting_input'].includes(current.status)) {
          this.fail(q.id, runId, `Worker stopped before returning a result (${signal ?? code}). ${stderr.slice(-1200)}`, true);
        }
        finish(); this.changed(q.id); this.wakeParents(); this.schedule();
      });
      this.changed(q.id);
    } catch (error) { this.inlineReads.revoke(q.id,runId);this.connectionTokens.get(connectionToken)?.controller.abort();this.connectionTokens.delete(connectionToken);this.gmRunTokens.delete(token);this.gmTokens.delete(token); this.workerTokens.delete(token); this.fail(q.id, runId, String(error)); }
  }
  workerEvent(id: string, runId: string, raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as Record<string, any>; const q = this.get(id);
    if (q.activeRunId !== runId || !['running','awaiting_input'].includes(q.status)) return;
    if (m.type === 'ready' && q.kind==='guildmaster') {
      // Re-send after worker initialization: an already-exhausted system resume
      // must not depend on receiving an IPC command during process bootstrap.
      try {this.inlineReads.toolBudget(id);} catch {this.inlineExhausted(id,runId,'budget_exhausted');}
    } else if (m.type === 'inline_round') {
      if(q.kind==='guildmaster')this.inlineReads.round(id,runId,m.roundId);
    } else if (m.type === 'inline_round_end') {
      if(q.kind==='guildmaster')this.inlineReads.roundEnd(id,runId,m.roundId);
    } else if (m.type === 'delivered') {
      const allowed = new Set(this.store.getRun(runId)?.data.deliveryIds ?? []);
      if (!Array.isArray(m.ids) || m.ids.some((deliveryId: unknown) => typeof deliveryId !== 'string' || !allowed.has(deliveryId))) throw new AppError('Invalid delivery acknowledgment.');
      const ids = new Set<string>(m.ids);
      if (ids.size && q.sessionStartRun) { q.sessionEstablished = true; this.store.save(q); }
      this.store.transaction(() => {
        for (const delivery of this.store.pendingDeliveries(id)) {
          if (ids.has(delivery.id)) this.store.saveDelivery({ ...delivery, deliveredAt: Date.now() });
        }
      });
    } else if (m.type === 'context') {
      const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (!nonnegative(m.contextWindow) || m.contextWindow <= 0 || (m.tokens !== null && !nonnegative(m.tokens)) || (m.percent !== null && !nonnegative(m.percent))) throw new AppError('Invalid context usage.');
      q.contextUsage = { tokens: m.tokens, contextWindow: m.contextWindow, percent: m.percent, model: typeof m.model === 'string' ? m.model : q.model, updatedAt: Date.now() };
      this.store.save(q);
    } else if (m.type === 'session') {
      // Never accept an arbitrary session path from an engine event.
      if (typeof m.model === 'string') q.model = m.model;
      this.store.save(q); this.store.event(id, 'session', q.sessionStartRun === q.runCount ? 'Fresh conversation started for this assignment.' : q.runCount > 1 ? 'Saved conversation resumed.' : 'Conversation saved.');
    } else if (m.type === 'message_start') {
      this.updateLive(id, runId, text(m.messageId, 'Message ID', 200), ''); return;
    } else if (m.type === 'message' && typeof m.text === 'string') {
      const messageId = typeof m.messageId === 'string' ? text(m.messageId, 'Message ID', 200) : this.partialMessages.get(id)?.messageId ?? randomUUID();
      if (m.text.trim()) this.store.message(id, 'assistant', m.text, messageId);
      this.changed(id); this.clearLive(id); return;
    } else if (m.type === 'delta') {
      const previous = this.partialMessages.get(id);
      const messageId = typeof m.messageId === 'string' ? text(m.messageId, 'Message ID', 200) : previous?.messageId ?? randomUUID();
      const delta = String(m.text ?? '');
      this.updateLive(id, runId, messageId, (previous?.messageId === messageId ? previous.text : '') + delta);
      this.emit('delta', { questId: id, text: delta, messageId }); return;
    } else if (m.type === 'tool_start' || m.type === 'tool_end') {
      const toolCallId = text(m.toolCallId, 'Tool call ID', 200);
      const callId = `${runId}:${toolCallId}`;
      const previous = this.store.toolCalls(id).find(call => call.id === callId);
      const tool = text(m.tool, 'Tool name', 200);
      if (m.type === 'tool_start') {
        if(q.kind==='guildmaster')try {this.inlineReads.toolBudget(id);} catch {return;}
        if (!previous) this.store.saveToolCall({ id: callId, questId: id, runId, tool, detail: String(m.detail ?? '').slice(0,4000), status: 'running', startedAt: Date.now() });
      } else {
        this.store.saveToolCall({ id: callId, questId: id, runId, tool, detail: previous?.detail ?? '', startedAt: previous?.startedAt ?? Date.now(),
          status: m.isError ? 'failed' : 'completed', endedAt: Date.now(), output: String(m.output ?? '').slice(0,['read_github_issue','read_github_comments','read_github_pull_metadata','read_repository','search_repository'].includes(tool)?110*1024:20000) });
      }
      // Deliver each persisted transition directly; snapshots remain the reconnect fallback.
      this.emit('tool', { questId: id, call: this.store.toolCalls(id).find(call => call.id === callId) });
    } else if (m.type === 'activity') {
      this.store.event(id, String(m.tool ?? 'activity'), String(m.detail ?? '').slice(0, 4000));
    } else if (m.type === 'question') {
      if(q.kind==='guildmaster')try {this.inlineReads.toolBudget(id);} catch {return;}
      const toolCallId = text(m.id, 'Request ID', 200);
      const requestId = `${runId}:${toolCallId}`;
      if (this.store.getRequest(requestId)) return;
      this.store.request({ id: requestId, questId: id, runId, toolCallId, question: text(m.question, 'Question'), status: 'pending', createdAt: Date.now() });
      q.status = 'awaiting_input';
      if (q.kind === 'delegate') {
        // Keep the question durable, but release the process so its lead can acquire
        // the same checkout. The answer resumes the saved native conversation.
        q.activeRunId = undefined;
        this.store.run(runId, id, { status: 'awaiting_input', endedAt: Date.now() });
        this.clearLive(id); this.store.interruptToolCalls(id, runId);
      }
      this.store.save(q); this.store.event(id, 'question', m.question);
      if (q.kind === 'delegate') this.stopWorker(id);
    } else if (m.type === 'yielded') {
      if (q.kind !== 'quest' || !q.waitForAgentIds?.length) throw new AppError('The lead has no saved wait request.');
      if (this.store.pendingDeliveries(id).length) throw new AppError('Instruction delivery must be confirmed before yielding.');
      this.suspendLead(q, runId, q.waitForAgentIds);
    } else if (m.type === 'complete') {
      this.clearLive(id); this.store.interruptToolCalls(id, runId);
      if (this.store.pendingDeliveries(id).length) {
        this.fail(id, runId, 'The agent returned before instruction delivery could be confirmed. Resume to reconcile the saved conversation.', true);
        return;
      }
      const result = typeof m.text === 'string' ? m.text.trim() : '';
      if (!result) { this.fail(id, runId, 'The agent ended without a result. Resume to continue.'); return; }
      const messages = this.store.messages(id);
      if (messages.at(-1)?.text !== result || messages.at(-1)?.role !== 'assistant') this.store.message(id, 'assistant', result);
      const pendingQuestions = this.agents(id).flatMap(agent => this.store.requests(agent.id).filter(r => r.status === 'pending'));
      if (q.kind === 'quest' && pendingQuestions.length && pendingQuestions.every(r => q.routedQuestionIds?.includes(r.id))) {
        this.fail(id,runId,'The quest lead stopped before resolving its agents’ questions. Resume the quest to continue coordination.',true);
        return;
      }
      const unconsumed = this.agents(id).filter(agent => !terminalAgent(agent) || (q.consumedDelegateRuns?.[agent.id] ?? 0) < agent.runCount);
      if (q.kind === 'quest' && unconsumed.length) {
        this.suspendLead(q, runId, unconsumed.map(agent => agent.id));
      } else {
        q.status = q.kind === 'delegate' ? 'completed' : 'awaiting_review'; q.result = result; q.activeRunId = undefined; this.store.save(q);
        this.store.run(runId, id, { status: 'completed', endedAt: Date.now() }); this.store.event(id, 'result', q.kind === 'delegate' ? 'Delegate report returned to the quest lead.' : 'Result ready for review.');
      }
    } else if (m.type === 'error') { this.fail(id, runId, String(m.error ?? 'Agent error')); }
    this.changed(id);
  }
  fail(id: string, runId: string, error: string, interrupted = false) {
    const q = this.get(id); if (q.activeRunId !== runId) return;
    this.clearLive(id); this.store.interruptToolCalls(id, runId);
    q.status = interrupted ? 'interrupted' : 'failed'; q.error = error; q.activeRunId = undefined;
    this.store.save(q); this.store.event(id, q.status, error);
    this.store.run(runId, id, { status: q.status, error, endedAt: Date.now() }); this.changed(id);
  }
  async continue(id: string, input: { message?: unknown; images?: unknown; freshContext?: unknown; isolation?: unknown; commandId: string }, resume = false, source?: DelegationSource, delegated?: { parentId: string; expectedRunId?: string; replacement?: {workspaces:QuestWorkspace[];guidanceRevision:string;outputPath:string;isolation:import('../domain/types.ts').IsolationRequest[];guard:()=>void} }) {
    const images = validateImages(input.images);
    return this.serialize(async () => {
      if (delegated) { this.lead(delegated.parentId, delegated.expectedRunId); if (this.get(id).parentQuestId !== delegated.parentId) throw new AppError('This delegate belongs to another quest.',403); }
      const command = this.checkCommand(input.commandId, `${resume ? 'resume' : 'continue'}:${id}`, source ? {input,source} : input);
      if (command.cached) return command.cached;
      await this.settleWorker(id);
      if (delegated) this.lead(delegated.parentId, delegated.expectedRunId);
      const q = this.get(id);
      if (q.archivedAt !== undefined) throw new AppError('Restore this quest before continuing it.', 409);
      const parent = q.parentQuestId ? this.lead(q.parentQuestId) : undefined;
      this.checkAvailable(q);
      if (this.store.requests(id).some(r => r.status === 'pending')) throw new AppError('Answer the pending question before continuing.', 409);
      const legacyInstruction = resume && ['failed', 'interrupted'].includes(q.status) && !this.store.deliveries(id).length
        ? this.store.messages(id).findLast(message => message.role === 'user')?.text : undefined;
      const previousRun = resume ? this.store.lastRun(id) : undefined;
      let message = resume
        ? `Resume this quest from its saved conversation. The previous run was ${q.status}. Inspect actual files and tool effects before repeating any operation. Continue the latest user instructions in the saved conversation and any recovered instructions supplied with this message. Original objective for context: ${q.objective}${legacyInstruction ? `\n\nThe previous app version did not record instruction delivery. The latest saved user instruction was: ${JSON.stringify(legacyInstruction)}. Check the saved conversation and actual effects before acting on it; it may already have been received.` : ''}`
        : delegatedPrompt(imageMessage(input.message, images, 'Feedback'), source);
      const questions = this.agents(id).flatMap(agent => this.store.requests(agent.id).filter(r => r.status === 'pending'));
      if (questions.length) message += '\n\nYour delegates need your input. Answer with answer_agent; ask the user yourself only for required user decisions or approvals. ' + JSON.stringify(questions);
      if (q.status === 'cancelled' && resume) throw new AppError('Send a new instruction to reopen a canceled quest.', 409);
      if (input.freshContext !== undefined && typeof input.freshContext !== 'boolean') throw new AppError('freshContext must be a boolean.');
      if (input.isolation !== undefined && !delegated?.replacement) throw new AppError('Workspace replacement requires a fresh delegated assignment.');
      if (input.freshContext && (!delegated || resume)) throw new AppError('Fresh assignment context is only available when continuing a delegate.');
      if (input.freshContext) {
        if (this.store.pendingDeliveries(id).length) throw new AppError('Resume or cancel undelivered work before starting fresh context.', 409);
        q.objective = text(input.message, 'Assignment');
        q.sessionPath = join(this.dataDir, 'sessions', q.id, `${randomUUID()}.jsonl`);
        q.sessionStartRun = q.runCount + 1;
        q.sessionEstablished = false;
        delete q.contextUsage;
      }
      if (!resume && q.kind === 'quest' && q.workspacePolicy !== 'isolated') delete q.guidanceRevision;
      if (delegated?.replacement) {
        const replacement = delegated.replacement; replacement.guard();
        const first = replacement.workspaces[0];
        Object.assign(q,{workspaces:replacement.workspaces,guidanceRevision:replacement.guidanceRevision,outputPath:replacement.outputPath,isolation:replacement.isolation,workspacePath:first.workspacePath,workspaceMode:first.mode,sourcePath:first.sourcePath,branch:first.branch});
      }
      if (!resume && parent && !q.isolation) q.guidanceRevision = parent.guidanceRevision;
      const sourcePrompt = resume ? previousRun?.data.sourcePrompt ?? previousRun?.data.prompt ?? legacyInstruction ?? q.objective : message;
      this.store.transaction(() => {
        if (input.freshContext) this.store.event(id, 'assignment', 'Started an independent assignment. Earlier conversation files are retained.');
        this.prepare(q, message, command.id, undefined, sourcePrompt, resume ? { source: 'system' } : source ? { source: 'guildmaster', displayText: text(input.message, 'Feedback') } : delegated ? { source: 'quest_lead', displayText: text(input.message, 'Feedback') } : undefined, images.length ? images : source ? this.runImages(source.runId) : undefined);
        if (parent && !['running','awaiting_input','queued'].includes(parent.status)) {
          parent.status = 'waiting'; parent.waitForAgentIds = [...new Set([...(parent.waitForAgentIds ?? []), id])]; this.store.save(parent);
        }
        this.store.saveCommand(command.id, command.fingerprint, delegated ? { agent: q } : { quest: q });
      });
      this.schedule(); return delegated ? { agent: this.get(id) } : { quest: this.get(id) };
    });
  }
  async action(id: string, action: 'accept' | 'cancel' | 'archive' | 'restore', input: { commandId: string }) {
    return this.serialize(async () => {
      const command = this.checkCommand(input.commandId, `${action}:${id}`, input); if (command.cached) return command.cached;
      const q = this.get(id);
      if (action === 'archive' || action === 'restore') {
        if (q.kind !== 'quest') throw new AppError('Only quests can be archived or restored.', 409);
        if (action === 'archive' && !['accepted', 'cancelled'].includes(q.status)) throw new AppError('Accept or cancel this quest before archiving it.', 409);
        // Accepted results and canceled runs may still be releasing their worker and workspace lock.
        if (action === 'archive') await this.settleWorker(id);
        const changed = action === 'archive' ? q.archivedAt === undefined : q.archivedAt !== undefined;
        this.store.transaction(() => {
          if (changed) {
            if (action === 'archive') q.archivedAt = Date.now(); else delete q.archivedAt;
            this.store.save(q);
            this.store.event(id, action === 'archive' ? 'archived' : 'restored', action === 'archive' ? 'You archived this quest. Files and conversation remain saved.' : 'You restored this quest to the board.');
          }
          this.store.saveCommand(command.id, command.fingerprint, { quest: q });
        });
        if (changed) this.changed(id);
        return { quest: q };
      }
      if (q.archivedAt !== undefined) throw new AppError('Restore this quest before changing its status.', 409);
      if (action === 'accept' && this.detail(id).requests.some(request => request.status === 'pending')) throw new AppError('Answer the pending questions before accepting this quest.',409);
      if (action === 'accept' && q.kind === 'delegate') throw new AppError('Delegate reports are reviewed by their quest lead.',409);
      if (action === 'accept' && q.status !== 'awaiting_review') throw new AppError('Only a result awaiting review can be accepted.', 409);
      q.status = action === 'accept' ? 'accepted' : 'cancelled'; const runId = q.activeRunId; q.activeRunId = undefined;
      this.store.transaction(() => {
        this.store.save(q); this.store.event(id, q.status, action === 'accept' ? 'You accepted this result.' : 'You canceled this quest. Files and conversations remain saved.');
        if (runId) this.store.run(runId, id, { status: 'cancelled', endedAt: Date.now() });
        if (action === 'cancel') for (const r of this.store.requests(id).filter(r => r.status === 'pending')) this.store.request({ ...r, status: 'answered', answer: 'Quest canceled by the user.' });
        if (action === 'cancel') for (const delivery of this.store.pendingDeliveries(id)) this.store.saveDelivery({ ...delivery, cancelledAt: Date.now() });
        if (action === 'cancel') {
          this.store.interruptToolCalls(id);
          for (const child of this.agents(id)) {
          const childRun = child.activeRunId; child.status = 'cancelled'; child.activeRunId = undefined; delete child.waitForAgentIds;
          this.store.interruptToolCalls(child.id);
          this.store.save(child); if (childRun) this.store.run(childRun, child.id, { status: 'cancelled', endedAt: Date.now() });
          for (const request of this.store.requests(child.id).filter(r => r.status === 'pending')) this.store.request({ ...request, status: 'answered', answer: 'Parent quest canceled by the user.' });
          for (const delivery of this.store.pendingDeliveries(child.id)) this.store.saveDelivery({ ...delivery, cancelledAt: Date.now() });
          this.store.event(child.id, 'cancelled', 'Parent quest canceled by the user.');
        }
        }
        this.store.saveCommand(command.id, command.fingerprint, { quest: q });
      });
      if (action === 'cancel') {
        for (const child of this.agents(id)) { this.clearLive(child.id); this.stopWorker(child.id); this.changed(child.id); }
        this.clearLive(id); this.stopWorker(id); this.wakeParents(); this.schedule();
      }
      this.changed(id); return { quest: q };
    });
  }
  async answer(id: string, input: { answer: unknown; images?: unknown; commandId: string }, delegated?: {parentId:string;agentId:string;expectedRunId?:string}) {
    const images = validateImages(input.images);
    return this.serialize(async () => {
      const r = this.store.getRequest(id); if (!r) throw new AppError('Question not found.', 404);
      if (delegated) {
        this.lead(delegated.parentId,delegated.expectedRunId);
        if (r.questId !== delegated.agentId || this.get(r.questId).parentQuestId !== delegated.parentId) throw new AppError('This question belongs to another assignment.',403);
      } else if (this.get(r.questId).kind === 'delegate') throw new AppError('The quest lead answers delegate questions.',403);
      const command = this.checkCommand(input.commandId, `answer:${id}`, delegated ? {input,delegated} : input); if (command.cached) return command.cached;
      if (r.status !== 'pending') throw new AppError('This question already has a response.', 409);
      await this.settleWorker(r.questId);
      const previous = this.live.get(r.questId);
      if (previous && (images.length || delegated || !previous.child.connected || previous.runId !== r.runId)) {
        this.stopWorker(r.questId);
        await previous.done;
      }
      if (delegated) this.lead(delegated.parentId,delegated.expectedRunId);
      const answer = imageMessage(input.answer, images, 'Answer'); const q = this.get(r.questId); const parent = q.parentQuestId ? this.lead(q.parentQuestId) : undefined; const live = this.live.get(q.id);
      if (!live) this.checkAvailable(q);
      r.status = 'answered'; r.answer = answer;
      const prompt = `The saved question was: ${r.question}\nThe ${delegated ? 'quest lead' : 'user'} answered: ${answer}\nResume the same quest. Inspect the current workspace before retrying interrupted actions.`;
      const delivery: Delivery = { id: randomUUID(), questId: q.id, commandId: command.id, kind: 'answer', text: prompt, answer, toolCallId: r.toolCallId ?? id, createdAt: Date.now() };
      this.store.transaction(() => {
        if (live && live.runId === r.runId && live.child.connected) {
          this.store.saveDelivery(delivery);
          const run = this.store.getRun(live.runId)?.data;
          this.store.run(live.runId, q.id, {
            deliveryIds: [...(run?.deliveryIds ?? []), delivery.id],
            sourcePrompt: `${run?.sourcePrompt ?? run?.prompt ?? q.objective}\n\nSaved question: ${r.question}\nUser answer: ${answer}`,
          });
          q.status = 'running'; this.store.save(q); r.answerMessageId = this.store.message(q.id, 'user', answer).id;
        }
        else r.answerMessageId = this.prepare(q, prompt, command.id, delivery, undefined, { source: delegated ? 'quest_lead' : 'user', displayText: answer }, images).id;
        this.store.request(r);
        if (parent && !['running','awaiting_input','queued'].includes(parent.status)) {
          parent.status = 'waiting'; parent.waitForAgentIds = [...new Set([...(parent.waitForAgentIds ?? []), q.id])]; this.store.save(parent);
        }
        this.store.event(q.id, 'answer', answer); this.store.saveCommand(command.id, command.fingerprint, { quest: q });
      });
      if (live && live.runId === r.runId && live.child.connected) live.child.send({ type: 'answer', id: r.toolCallId ?? id, answer, delivery }, error => { if (error) this.fail(q.id, r.runId, 'Answer saved, but delivery was interrupted. Resume to continue.', true); });
      else this.schedule();
      this.changed(q.id); return { quest: q };
    });
  }
  stopWorker(id: string) {
    this.inlineReads.revoke(id);
    for(const [token,run] of this.connectionTokens)if(run.questId===id){run.controller.abort();this.connectionTokens.delete(token);}
    const live = this.live.get(id); if (!live) return;
    if (live.child.connected) live.child.send({ type: 'cancel' }, () => {});
    live.cancelTimer = setTimeout(() => { try { process.kill(-live.child.pid!, 'SIGKILL'); } catch { live.child.kill('SIGKILL'); } }, 3000);
    live.cancelTimer.unref();
  }
  async newGuildmaster(input: { commandId: string; questId: string }) {
    return this.serialize(async () => {
      const command = this.checkCommand(input.commandId, 'new:guildmaster', input);
      if (command.cached) return command.cached;
      const current = this.store.list().find(q => q.kind === 'guildmaster' && !q.archivedAt);
      if (!current || current.id !== input.questId) throw new AppError('The active conversation changed. Refresh before starting a new conversation.', 409);
      await this.settleWorker(current.id);
      if (['queued','running','waiting','awaiting_input'].includes(current.status) || current.activeRunId || this.store.requests(current.id).some(request => request.status === 'pending')) throw new AppError('Finish or cancel the current turn before starting a new conversation.', 409);
      const response = { quest: null };
      this.store.transaction(() => {
        current.archivedAt = Date.now(); this.store.save(current);
        this.store.saveCommand(command.id, command.fingerprint, response);
      });
      this.changed(current.id);
      return response;
    });
  }
  async guildmaster(input: Record<string, any>) {
    const images = validateImages(input.images);
    const existing = this.store.list().find(q => q.kind === 'guildmaster' && !q.archivedAt);
    if (!existing) return this.create({ objective: imageMessage(input.message, images), images, workspacePath: input.workspacePath,
      workspaceMode: input.workspaceMode, model: input.model, tools: input.tools, commandId: input.commandId,
      projectId: input.projectId, repositories: input.repositories }, 'guildmaster', input);
    // Changing defaults is explicit, and only applies between Guildmaster turns.
    return this.serialize(async () => {
      const command = this.checkCommand(input.commandId, 'guildmaster', input); if (command.cached) return command.cached;
      await this.settleWorker(existing.id);
      if (this.get(existing.id).archivedAt) throw new AppError('This conversation was moved to history. Refresh before sending a new message.',409);
      if (this.store.requests(existing.id).some(r => r.status === 'pending')) throw new AppError('Answer the pending question before continuing.',409);
      if (input.projectId !== undefined || input.repositories !== undefined || input.workspacePath !== undefined || input.workspaceMode !== undefined) {
        const inheritProject = input.projectId === undefined && input.workspacePath === undefined;
        Object.assign(existing, await this.workspaceSelection({
          projectId: input.projectId === undefined ? (inheritProject ? existing.project?.id ?? null : null) : input.projectId,
          repositories: input.repositories === undefined && inheritProject && existing.project && input.workspaceMode !== 'none'
            ? existing.workspaces?.map(w => ({ repositoryId: w.repositoryId, mode: w.mode })) : input.repositories,
          workspacePath: input.workspacePath ?? existing.workspacePath,
          workspaceMode: input.workspaceMode ?? ((input.projectId !== undefined && input.projectId !== null) || input.workspacePath !== undefined || input.repositories !== undefined ? 'existing' : existing.workspaceMode),
        }, existing.id, 'guildmaster', []));
      }
      if (input.model !== undefined) existing.model = String(input.model);
      if (input.tools) {
        if (!Array.isArray(input.tools) || input.tools.some((t: string) => !ALLOWED_TOOLS.includes(t))) throw new AppError('Unknown tool capability.');
        existing.tools = input.tools;
      }
      this.checkAvailable(existing);
      const message = imageMessage(input.message, images);
      this.store.transaction(() => { this.prepare(existing, message, command.id, undefined, undefined, undefined, images); this.store.saveCommand(command.id, command.fingerprint, { quest: existing }); });
      this.schedule(); return { quest: this.get(existing.id) };
    });
  }
  async close() {
    await this.queue; this.stopping = true;
    const entries = [...this.live.entries()];
    for (const [id, live] of entries) { this.fail(id, live.runId, 'The service stopped. Your conversation and workspace are saved.', true); this.stopWorker(id); }
    await Promise.all(entries.map(([, live]) => live.done));
    await Promise.allSettled([...this.setups.values()].map(setup=>setup.task));
  }
}
