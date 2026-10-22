# Storage

Guildmaster stores application data outside the repository, in `~/.guildmaster` by default. `GUILDMASTER_HOME` selects another directory.

## Saved data

| Location | Contents |
| --- | --- |
| `state.sqlite` | Quests, messages, images, activity, questions, projects, schedules, and command records. |
| `sessions/` | Pi agent conversations. |
| `engine/` | Provider credentials, model settings, and preferences. |
| `connections.namespace` | Identity for Slack credentials in the operating-system credential store. |
| `workspaces/`, `worktrees/`, `isolated/` | Quest files, worktrees, prepared outputs, and copied skill assets. |
| `guidance/`, `runs/` | Instruction snapshots and worker run specifications. |
| `service.log` | Service output and startup errors. |

Unsent drafts and their images live in browser storage. A data-directory backup does not include drafts or Slack credentials from the operating-system credential store.

Conversations and workspaces can contain private source material. Provider credentials and worker run files contain sensitive data. Keep this directory out of Git and public bug reports.

## Back up or move data

1. Finish or close active quests and wait for their workers to stop.
2. Run `npm run stop` with the correct `GUILDMASTER_HOME` setting.
3. Run `npm run status` until the service reports that it is stopped.
4. Copy the complete data directory to a private location.

For a move, preserve `connections.namespace`. Saved quests and Git worktrees contain absolute paths. Keep their original paths available, or migrate those references before resuming work.

Restoring the directory does not restore credentials from another computer's credential store. Slack can require a new sign-in.

## Close, reopen, and delete quests

**Accept & close** records human acceptance of the current result and moves the quest to **Quest board → History**. **Close** moves it to History without endorsing success. History labels these outcomes **Accepted** and **Closed**. Closing active work cancels the lead and delegates and dismisses outstanding questions after explicit confirmation; dismissal is not an answer or approval. Conversations, results, sessions, activity, and files remain.

**Reopen** (or **Undo** after closing) returns a retained quest to the attention inbox. It starts no worker, replays no deliveries, and does not revive dismissed questions. Its label is **Reopened** until follow-up execution begins. Previous acceptance remains historical, not approval of a later result.

Closing and acceptance do not merge or publish work, verify correctness, delete files, or guarantee that worker processes have exited.

To delete a closed quest, open **Quest board → History** and select **Delete permanently**. Bulk deletion supports up to 100 selected quests. Both actions require confirmation. Deletion requires the entire family to have no active or queued work, pending questions or instructions, live workers, or workspace preparation. Safely closed failed and interrupted quests are eligible too.

Deletion removes the quest and its delegates, saved messages, sessions, run files, and eligible application-owned workspaces. This includes uncommitted files in those workspaces. Save any work you need before deletion.

Source repositories, Git branches, published work, provider credentials, connections, and projects remain. References from other saved quests or projects protect shared workspace assets.

Cleanup checks ownership before removing files. It rejects symlinked storage paths and unrecognized worktrees. A cleanup error retains the record for retry, but earlier cleanup steps can already have removed files. Reopen and deletion serialize: reopening first blocks deletion; once deletion wins, reopening cannot restore deleted files.

SQLite reuses deleted pages. Deletion does not guarantee secure erasure or immediate reduction of the database file size. Quoted results in other conversations remain there.

## Automatic deletion

Automatic deletion is off by default. **Settings → Storage** accepts a closed age from 1 to 3650 days. Both **Close** and **Accept & close** start the retention clock at `closedAt`, including failed or interrupted quests that are safely closed.

An already enabled policy stays enabled with its existing retention period. It applies immediately to all closed quests, including those already older than the selected age. Cleanup runs at startup and hourly while the service runs, with the same full-family safety checks as explicit deletion.

Reopening clears `closedAt` and excludes the quest from cleanup. Closing it again starts a new retention clock. Turning cleanup off stops future checks. A deletion already in progress can finish.

The policy covers closed quests and their delegates only. It does not remove open quests, Guildmaster conversation history, or projects.
