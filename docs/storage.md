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

1. Finish or cancel active quests.
2. Run `npm run stop` with the correct `GUILDMASTER_HOME` setting.
3. Run `npm run status` until the service reports that it is stopped.
4. Copy the complete data directory to a private location.

For a move, preserve `connections.namespace`. Saved quests and Git worktrees contain absolute paths. Keep their original paths available, or migrate those references before resuming work.

Restoring the directory does not restore credentials from another computer's credential store. Slack can require a new sign-in.

## Archive and delete quests

Archiving removes accepted or canceled quests from the current board. It retains conversations, sessions, activity, and workspace files. Restoring a quest does not start an agent.

To delete a quest, open **Quest board → Archived** and select **Delete permanently**. Bulk deletion supports up to 100 selected quests. Both actions require confirmation.

Deletion removes the quest and its delegates, saved messages, sessions, run files, and eligible application-owned workspaces. This includes uncommitted files in those workspaces. Save any work you need before deletion.

Source repositories, Git branches, published work, provider credentials, connections, and projects remain. References from other saved quests or projects protect shared workspace assets.

Cleanup checks ownership before removing files. It rejects symlinked storage paths and unrecognized worktrees. A cleanup error retains the archived record for retry, but earlier cleanup steps can already have removed files.

SQLite reuses deleted pages. Deletion does not guarantee secure erasure or immediate reduction of the database file size. Quoted results in other conversations remain there.

## Automatic deletion

Automatic deletion is off by default. Enable it in **Settings → Storage** and choose an archive age from 1 to 3650 days.

The age starts at archival. Enabling cleanup also applies to quests already older than the selected age. Cleanup runs at startup and hourly while the service runs.

Restoring a quest excludes it from cleanup. Archiving it again starts a new archive age. Turning cleanup off stops future checks. A deletion already in progress can finish.

The policy covers archived quests and their delegates. It does not remove Guildmaster conversation history or archived projects.
