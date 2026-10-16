# Development

The frontend uses React and Vite. The service and agent workers run TypeScript directly through Node.js. There is no backend compilation step.

## Local setup

Use Node.js 22.13 or later. The test baseline is Node.js 22. Install dependencies from the lockfile:

```sh
npm ci
```

For development, use a separate data directory and ports. Run these commands in the same terminal:

```sh
export GUILDMASTER_HOME="$HOME/.guildmaster-dev"
export GUILDMASTER_PORT=4273
export GUILDMASTER_DEV_PORT=5273
npm run dev
```

Open the URL printed by Vite. The command starts the service if necessary and connects the frontend to it. Configure a provider in this instance to run real agent tasks.

Without these overrides, development uses the normal data directory and ports. It can connect to your existing service and real quests.

Frontend edits update automatically. Ctrl+C stops Vite but leaves the service running. Backend edits require a service restart.

If quests are active, wait for them to finish before restarting the service. To stop the development service, use the same environment:

```sh
npm run stop
npm run status
```

Wait until status reports that Guildmaster is stopped. Then run `npm run dev` again. Interrupted quests retain their saved conversations and require manual resumption.

For service logs in the terminal, run `npm run serve`. This starts the service in the foreground and requires a free port and data directory.

## Check a change

```sh
npm run typecheck
npm test
npm run build
```

Tests use temporary directories, fixture workers, and simulated model responses. They do not require a paid provider account. Some integration tests open local sockets.

For UI changes, also inspect the affected view in the browser. Check light and dark themes, keyboard interaction, and narrow windows.

For provider or Slack changes, use a separate test account for live checks. Simulated responses cannot establish that an external sign-in flow works.

## Update an existing installation

If quests are active, finish or cancel them first. From the checkout that runs Guildmaster:

```sh
npm run stop
npm run status
```

Wait until the service is stopped. Then update the checkout and dependencies:

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

`npm start` builds only when `dist/index.html` is missing. The explicit build above updates an existing production interface.

Updates retain the application data directory. Back up important data before changes to storage formats. See [Storage](storage.md).

## Settings for local execution

| Variable | Purpose |
| --- | --- |
| `GUILDMASTER_HOME` | Data directory. Default: `~/.guildmaster`. |
| `GUILDMASTER_PORT` | Service port. Default: `4173`. |
| `GUILDMASTER_DEV_PORT` | Vite port. Default: `5173`. |
| `GUILDMASTER_NO_OPEN=1` | Start without opening a browser. |
| `GUILDMASTER_MAX_WORKERS` | Worker capacity. Default: `13`, including one reserved Guildmaster slot. Minimum: `2`. |
| `GUILDMASTER_SKILL_PATHS` | Additional skill files or directories, separated by the platform path delimiter. |
| `GUILDMASTER_SLACK_CLIENT_ID` | A separately registered Slack app. See [Connections](connections.md#custom-slack-app). |

Use the same data-directory setting for start, status, and stop commands. Only one service can own a data directory.

## Troubleshooting

- **The interface shows old code:** run `npm run build`, then reload. Restart the service for backend changes.
- **Startup fails:** inspect `service.log` in the selected data directory. Check the Node.js version and port availability.
- **No models appear:** open Settings and connect a provider. Provider settings belong to each data directory.
- **A quest stops after a restart:** open it and select Resume, or answer its pending question.
- **A schedule does not run:** check that the service is running and the computer is awake. Check for an active or interrupted previous occurrence.
- **A report link fails:** check that the file still exists in the quest workspace. File-link support requires the current service code.

Before sharing logs or test fixtures, remove credentials, private source material, and personal paths.
