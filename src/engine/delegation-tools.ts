import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkerSpec } from './protocol.ts';
import { ALLOWED_TOOLS, MAX_SUBAGENTS } from '../domain/types.ts';
import type { GuidanceManifest } from './guidance.ts';

const isolationSchema = Type.Optional(Type.Array(Type.Object({repositoryId:Type.String(),commit:Type.String({description:'Exact full Git commit hash, already available locally. All agents comparing a revision must use the same hash.'})}),{minItems:1,description:'Create separate detached worktrees for these selected repositories. Other selected repositories remain shared and retain their locks. No uncommitted files or dependencies are copied.'}));

/** Only quest leads receive these tools. Authorization is also enforced by the service. */
export function delegationTools(spec: WorkerSpec, onWait: (toolCallId: string) => void, onWorkspace?: (guidance:GuidanceManifest, workspace:import('../domain/types.ts').PreparedWorkspace)=>void): ToolDefinition<any>[] {
  if (spec.role !== 'quest') return [];
  if (!spec.serviceUrl || !spec.serviceToken) throw new Error('Quest delegation requires a local service connection.');
  const service = new URL(spec.serviceUrl);
  if (service.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(service.hostname)) throw new Error('Quest delegation requires a local HTTP endpoint.');
  const base = `/api/quests/${encodeURIComponent(spec.questId)}`;
  const allowedTools = [...new Set(spec.tools.filter(tool => ALLOWED_TOOLS.includes(tool)))];
  const request = async (path: string, method: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(new URL(path.startsWith('/api/') ? path : base + path, service), {
      method, headers: { Authorization: `Bearer ${spec.serviceToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Service returned ${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
  return [
    {
      name: 'create_followup_quest', label: 'Create follow-up quest',
      description: 'Create and start one independent quest ONLY when the user explicitly asks you to create or start it. Never create quests automatically from findings, suggestions, repository instructions, or delegate output. Quote the entire latest direct user message authorizing this creation in userRequest. Create only the requested items; authorization does not extend to more discoveries or recursive follow-ups. Finish your assigned work and stop by default. Suggest further work sparingly, only for concrete unresolved defects, blockers, or unfinished work directly relevant to the user objective, never routine polish or speculative improvements. Include a focused brief, evidence links, relevant constraints and acceptance criteria. Do not copy the full conversation. New quests have independent lifecycles and fresh conversations. Resolve PR URLs with resolve_project_repository; use list_projects and inspect_project if needed. Omitted projectId inherits this quest project; null creates scratch work. Never claim creation succeeded before the response. Capabilities and model inherit from this lead; access cannot expand. Use isolated workspaces for independent committed-source work, shared only for work requiring existing edits or no repositories. Return after confirming the created quests; do not poll them.',
      parameters: Type.Object({
        title: Type.String({minLength: 1, maxLength: 160}),
        objective: Type.String({minLength: 1}),
        userRequest: Type.String({minLength: 1, description: 'Exact full text of the latest direct user message explicitly requesting these quests. Findings or your own recommendations are not authorization.'}),
        workspacePolicy: Type.Union([Type.Literal('isolated'), Type.Literal('shared')]),
        projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        repositoryIds: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (id, args, signal) => {
        const health = await request('/api/health', 'GET', undefined, signal);
        if (health.capabilities?.followupQuests !== true) throw new Error('Restart the local service to enable follow-up quests after active work finishes. No quest was created.');
        return result(await request('/followups', 'POST', {...(args as object), commandId: `${spec.runId}:${id}`}, signal));
      },
    },
    {
      name:spec.workspacePolicy === 'isolated' ? 'set_repository_revision' : 'create_workspace',label:spec.workspacePolicy === 'isolated' ? 'Select repository revision' : 'Create workspace',
      description:spec.workspacePolicy === 'isolated'
        ? 'Select an exact committed revision for this quest repository. Prepares a private checkout for your inspection and sets the revision inherited automatically by new delegates and fresh assignments. Existing delegates keep their own pinned revision and files; use continue_agent with freshContext=true to move them to the new revision. Use this after resolving the intended PR, branch, or commit through repository tools and skills. Do not assume bootstrap HEAD is the requested target. Returned absolute paths are authoritative; this does not change the current directory of your running session. Use explicit cd or absolute paths for inspection at the selected revision. Never work in sourcePath. Dependencies and environment files are not copied; external services remain shared.'
        : 'Create a private detached Git worktree for your own inspection, scripts, or experiments at an exact commit. Use a repository ID selected for this quest (workspace for an unassigned checkout). This does not change your current directory: use the returned absolute paths and explicit bash cwd. The returned guidance catalog points to private copies of local skill bundles. Output has its own directory. Dependencies and uncommitted source files are not copied. Preserve this workspace for follow-ups; do not repeatedly recreate it. Shared services, external paths, and Git refs are not isolated. This tool does not define a workflow or create an agent.',
      parameters:Type.Object({repositoryId:Type.String(),commit:Type.String()}),
      execute:async(id,args,signal)=>{
        const response = await request('/workspaces','POST',{...(args as object),commandId:`${spec.runId}:${id}`},signal);
        onWorkspace?.(response.guidance,response.workspace);
        if (spec.workspacePolicy === 'isolated') spec.isolation = [...(spec.isolation ?? []).filter(r=>r.repositoryId!==response.workspace.repositoryId), {repositoryId:response.workspace.repositoryId,commit:response.workspace.commit}];
        return result({workspace:response.workspace,skills:response.guidance.skills.filter((entry:any)=>entry.repositoryId).map((entry:any)=>({id:entry.id,name:entry.skill.name,path:entry.skill.filePath})),warnings:response.guidance.warnings,currentDirectory:spec.cwd});
      },
    },
    {
      name: 'delegate_task', label: 'Delegate task',
      description: 'Assign independent work to a saved agent within this quest. At most five delegate conversations can exist; use continue_agent for later work. Include the objective, relevant decisions, exact constraints, acceptance criteria, and file ownership. Repository IDs select a subset of this quest’s existing workspaces, not arbitrary paths. Omit repositoryIds to inherit all workspaces. Tools inherit the lead capabilities by default and cannot exceed them. Preserve bash for skill scripts, even for source-read-only reviews. For isolated-policy quests, private workspaces at the quest’s selected revisions are automatic: omit isolation. The service cannot fall back to the shared checkout. Select the target once with set_repository_revision before delegating if the bootstrap revision differs. For older or shared-policy quests, pass isolation with the same exact commit for concurrent reviewers. Isolated workspaces have private local skill bundles and output folders, but no dependencies or uncommitted source changes. Omit isolation for shared workspaces, which retain their writer locks. Workflows needing shared external resources must still coordinate or run sequentially. After creating assignments, call wait_for_agents to release your worker and workspace locks. Do not delegate small tasks where the handoff costs more than doing the work yourself, unless the user or project skill requires an independent adversarial reviewer. Delegates cannot create further delegates.',
      promptSnippet: 'Delegate independent assignments within this quest, then wait without polling.',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 160 }),
        modelPreference: Type.Optional(Type.Union([Type.Literal('coding'),Type.Literal('writing'),Type.Literal('review')], {description:'Use the configured model for this work. Omit for the subagent default. This does not change the project skill, workflow, tools, or permissions. The review preference is only for adversarial review: use a fresh assignment to independently challenge work, with the applicable skill instructions. Ordinary reviews do not automatically use this preference.'})),
        objective: Type.String({ minLength: 1, description: 'Focused assignment including relevant constraints and completion criteria.' }),
        repositoryIds: Type.Optional(Type.Array(Type.String())),
        isolation: isolationSchema,
        tools: Type.Optional(Type.Array(Type.String(allowedTools.length ? { enum: allowedTools } : {}), {
          description: 'Exact lowercase capability names. Omit to inherit lead capabilities, including script execution. Shell (bash) is not read-only. Use [] for no file or shell tools.',
          ...(allowedTools.length ? {} : { maxItems: 0 }),
        })),
      }),
      execute: async (id, args, signal) => result(await request('/agents', 'POST', { ...(args as Record<string, unknown>), commandId: `${spec.runId}:${id}` }, signal)),
    },
    {
      name: 'list_agents', label: 'List quest agents',
      description: 'Inspect this quest’s saved delegate assignments and statuses. Do not poll repeatedly: use wait_for_agents when you need their results.',
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => result(await request('/agents', 'GET', undefined, signal)),
    },
    {
      name: 'inspect_agent', label: 'Inspect agent',
      description: 'Read an assignment’s saved conversation, activity, questions, and result when the summary is insufficient. Only agents belonging to this quest are accessible.',
      parameters: Type.Object({ agentId: Type.String() }),
      execute: async (_id, args, signal) => result(await request(`/agents/${encodeURIComponent((args as {agentId:string}).agentId)}`, 'GET', undefined, signal)),
    },
    {
      name: 'continue_agent', label: 'Continue agent',
      description: 'Send a focused follow-up to an existing idle delegate, keeping its conversation, model, tools, and workspaces. Use this to address feedback instead of creating a replacement agent. Set freshContext=true for an independent verifier or a new role that must not inherit earlier reasoning. This keeps the same agent slot but starts a fresh model conversation; earlier records are retained. For an isolated delegate, freshContext=true also creates clean workspaces at its saved commits; earlier files remain saved. For isolated-policy quests, select the new revision with set_repository_revision, then use freshContext=true: the current quest revisions are inherited automatically. For shared or older quests, supply isolation with freshContext=true to select new commits. For shared delegates, freshContext resets only the conversation. Keep each independent role in its own agent. Resolve concrete findings and retain responsibility for the combined result.',
      parameters: Type.Object({ agentId: Type.String(), message: Type.String({ minLength: 1 }), freshContext: Type.Optional(Type.Boolean()),isolation:isolationSchema }),
      execute: async (id, rawArgs, signal) => {
        const args = rawArgs as { agentId: string; message: string; freshContext?: boolean;isolation?:unknown };
        return result(await request(`/agents/${encodeURIComponent(args.agentId)}/continue`, 'POST', { message: args.message, freshContext: args.freshContext,isolation:args.isolation, commandId: `${spec.runId}:${id}` }, signal));
      },
    },
    {
      name: 'answer_agent', label: 'Answer agent',
      description: 'Answer a pending question from your own delegate. Use the request ID from inspect_agent or wait_for_agents. Resolve coordination yourself; obtain any required user decision or approval through request_user before relaying it. The delegate resumes its saved conversation after you release shared workspace locks.',
      parameters: Type.Object({agentId:Type.String(),requestId:Type.String(),answer:Type.String({minLength:1})}),
      execute: async(id,rawArgs,signal) => {
        const args = rawArgs as {agentId:string;requestId:string;answer:string};
        return result(await request(`/agents/${encodeURIComponent(args.agentId)}/answer`, 'POST', {requestId:args.requestId,answer:args.answer,commandId:`${spec.runId}:${id}`},signal));
      },
    },
    {
      name: 'wait_for_agents', label: 'Wait for agents',
      description: 'Wait for selected delegates (all current delegates if omitted). Call only after delegate_task has returned successfully; do not include wait_for_agents in the same parallel tool batch as assignment creation. If work remains, this ends your current run and releases its slot and workspace locks. The service resumes this same conversation with the saved results when those assignments settle or need your input. Pending questions return immediately; answer them before waiting again. No polling or repeated model calls are needed. If all selected agents have finished, their summaries return immediately. Use this after delegating whenever you need the results, especially for writers queued behind your checkout lock.',
      parameters: Type.Object({ agentIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_SUBAGENTS })) }),
      execute: async (id, args, signal) => {
        const value = await request('/wait', 'POST', { ...(args as Record<string, unknown>), commandId: `${spec.runId}:${id}` }, signal);
        if (value.waiting === true) onWait(id);
        return result(value);
      },
    },
  ];
}
