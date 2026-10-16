# Architecture

Guildmaster is one TypeScript package with a React frontend, a local HTTP service, and separate Pi agent workers.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/cli.ts` | Start, stop, status, and development commands. |
| `src/service/main.ts` | Service entry point, data-directory lock, and shutdown. |
| `src/service/server.ts` | HTTP routes, browser authentication, and server-sent events. |
| `src/service/quests.ts` | Quest commands, worker supervision, delegation, and execution queues. |
| `src/service/store.ts` | SQLite records and transactions. |
| `src/service/projects.ts`, `isolated-workspaces.ts` | Repository registration, revision selection, and workspace preparation. |
| `src/service/schedules.ts` | Recurring tasks, saved occurrences, and dispatch. |
| `src/service/archive-storage.ts`, `quest-files.ts` | Archived quest deletion and access to report files. |
| `src/domain/` | Shared records, image limits, and timezone recurrence calculations. |
| `src/worker.ts` | Agent process entry point and engine event handling. |
| `src/engine/` | Pi sessions, instruction delivery, model settings, guidance, and agent tools. |
| `src/connections/` | Slack MCP access, OAuth, credential storage, and tool restrictions. |
| `src/web/` | React views, conversation rendering, drafts, and styles. |
| `tests/`, `src/engine/*.test.ts` | Service, HTTP, storage, engine, and rendering tests. |

## Processes and persistence

The CLI starts a detached service. Closing the frontend does not stop quests. Each active agent turn runs in a separate worker process.

SQLite stores quests, messages, questions, tool activity, commands, runs, deliveries, projects, schedules, and image attachments. Pi session files retain agent conversations. Workspace files remain on disk.

The frontend loads snapshots through HTTP and receives live changes through server-sent events. Streaming text is transient. Saved messages and engine sessions provide recovery state.

The service holds a lock for its data directory. Shutdown stops scheduled dispatch and workers before closing the store. A restart marks unfinished work as interrupted.

## Quests and delegates

The main Guildmaster conversation coordinates independent quests. Each quest has one lead and up to five saved delegates. Delegates cannot delegate further.

A delegate uses a quest record with `kind: delegate` and `parentQuestId`. It has its own session, runs, messages, and workspace references.

Feedback normally continues the same lead or delegate conversation. Fresh delegate context creates a new session while retaining earlier records. For isolated delegates, it also creates fresh workspaces.

A lead can yield through `wait_for_agents`. The service saves its wait targets, stops the worker, and releases its execution slot and workspace locks. Delegate results then queue the lead for another turn.

Delegate questions go to their lead. Human questions appear in the quest conversation and use the main composer for answers. Pending questions survive service restarts.

A completed lead turn produces a result for review. Only the user accepts the quest. Outstanding delegate work can delay the lead's final result.

Follow-up quest creation requires an explicit direct user request. Inherited briefs, tool results, and scheduled instructions cannot supply that authorization. The service checks message provenance before creation.

## Commands and recovery

Mutating commands carry stable command IDs. The service checks each command's fingerprint before it returns a cached result or applies a mutation.

Prompts and answers have saved delivery records. The worker reconciles these records with the Pi session before replay and acknowledges them after persistence.

Stale worker events cannot update a newer run. A missing or damaged established session stops recovery with an error.

These checks do not guarantee exactly-once external actions. After interruption, an agent must inspect external effects before repeating a command.

## Workspaces and execution queues

A project names one or more local repositories. Each quest saves its selected repositories, instructions, and actual workspace paths.

Shared work uses existing files. Isolated work uses private Git worktrees at selected commits. Scratch work uses an application-owned directory without a project.

The queue limits concurrent workers. One slot is reserved for Guildmaster. Among eligible background tasks, it favors the least recently served quest family.

Agents with write, edit, or shell capabilities count as writers. Canonical overlapping workspace paths prevent concurrent Guildmaster writers. Locks remain until the worker exits.

Read-only agents, human editors, and external processes remain outside those writer locks. Worktrees share Git metadata and the host environment.

Workspace preparation runs outside the main command queue. Managed Git mutations serialize per source repository. Failed isolation does not fall back to shared files.

## Repository guidance

Agents load instructions from selected repositories and their ancestors. Within a directory, `AGENTS.override.md` takes precedence over `AGENTS.md`, with `CLAUDE.md` as a fallback.

The engine discovers repository, user, and installed-plugin skills. It reads selected skills through `load_skill`. Discovery does not install plugins or run hooks.

Guidance snapshots preserve the instructions for a run. User follow-ups refresh repository guidance. Automatic handoffs retain the existing snapshot.

Isolated workspaces receive private copies of local skill bundles. Required tools and dependencies still need local installation. Submodules and unsupported skill symlinks require shared workspaces.

## Recurring tasks

Schedules store instructions for future quests. Each occurrence saves a settings snapshot and a stable identity before quest creation.

Dispatch runs at startup and every 15 seconds. A schedule cannot overlap an active, queued, waiting, awaiting-input, or interrupted occurrence. Results awaiting review do not block the next run.

The default missed-run policy starts only the latest missed occurrence. The skip policy ignores occurrences more than one minute late. Pausing does not accumulate missed work.

Timezone calculations preserve local times across daylight-saving changes. Repeated times run once. Missing local times use the first valid minute afterward.

Editing a schedule affects future runs. Deleting it retains existing quests and saved occurrences. Guildmaster can prepare a draft. The user must save it to enable execution.

## Access boundaries

The service binds to loopback and checks Host and Origin headers. The browser receives an HTTP-only session cookie. Agent management tokens are scoped to their roles and active runs.

Workers receive separate connection grants for Slack. The service checks current run authority and allowed tools before dispatch and before returning results.

Tool capabilities restrict available tools. Workspace paths are working directories, not filesystem sandboxes. Shell-capable agents run with the local user's authority.

The Markdown renderer treats agent text as untrusted content. Quest file links require browser authentication and resolve within canonical quest workspace or output paths. HTML reports use a restrictive sandbox policy.

Provider credentials use private local files. Slack credentials use the operating-system credential store. See [Connections](connections.md) and [Storage](storage.md).
