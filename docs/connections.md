# Connections

Guildmaster includes a Slack MCP client for reading threads, channels, and search results. It does not expose posting, reactions, or uploads.

GitHub work uses locally available tools, such as an authenticated `gh` CLI. Slack sign-in does not grant GitHub access.

## Connect Slack

1. Open **Settings → Connections**.
2. Select **Add connection**, then **Connect Slack**.
3. Complete sign-in in the Slack window.
4. Return to Guildmaster and check the workspace and account on the connection card.

If the browser blocks the sign-in window, select **Open Slack sign-in**.

The default preset uses the public client ID from Slack's official connector. Slack identifies that registered app as **Claude** during consent. Guildmaster explains this before sign-in. No Claude installation is required.

Workspace approval can be necessary. The connection cannot read channels or messages that your account cannot access. The preset depends on Slack's support for that registration.

The sign-in callback uses `http://localhost:3118/callback`. Guildmaster opens that listener only during sign-in. If another app occupies the port, finish its sign-in before retrying.

A new connection becomes available on the next agent turn. Existing workers retain their current tool catalog until the turn ends.

The preset comes from Slack's [official plugin configuration](https://github.com/slackapi/slack-skills-plugin/blob/main/.mcp.json). Its license is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Credentials and lifecycle

Slack credentials live in Guildmaster's operating-system credential-store namespace. They do not enter the application database, worker specifications, or model conversations. There is no plaintext fallback.

macOS uses Keychain. Other platforms need a compatible, unlocked credential store. Credential-store support alone does not establish full platform support.

The service refreshes credentials and permits two concurrent reads per connection. Cancellation stops that run's requests without disconnecting other readers.

Disconnect stops dispatch, cancels pending requests, removes local credentials, and attempts remote revocation. A failed remote revocation does not re-enable local access. Local removal errors appear in the interface for retry.

Slack content can appear in saved conversations and model requests. Tool-activity records retain short receipts rather than duplicate full responses.

The credential layer does not sandbox arbitrary shell commands running as the same local user.

## Import connection settings

The import preview can read these files:

- `~/.config/mcp/mcp.json`
- `~/.pi/agent/mcp.json`
- `~/.pi/agent/settings.json`

Import copies supported public settings and tool restrictions. It does not execute commands or copy OAuth tokens, secret headers, or client secrets. JSON with comments is unsupported.

After import, complete a fresh Slack sign-in. Guildmaster does not share rotating credentials with another application.

## Custom Slack app

Set `GUILDMASTER_SLACK_CLIENT_ID` to use a separately registered public-client Slack app. Register `http://localhost:<service-port>/oauth/slack/callback` with that app and enable desktop PKCE. Do not embed a confidential client secret.

This callback differs from the default preset's callback. The service port defaults to `4173`.

## Contributor checks

The service validates active run identity, connection identity, granted scopes, exact tool names, arguments, and imported restrictions. Delegates inherit a subset of their lead's grants. Reconnecting creates a new identity. Old grants cannot authorize the replacement connection.

Connection tests cover OAuth callbacks, read restrictions, refresh, cancellation, imports, and account changes with simulated endpoints. Native worker tests cover tool registration and dispatch.

For connection changes, also check live sign-in, refresh, and thread access with a test workspace. Check the credential store on each release platform. Automated fixtures do not prove live workspace approval.
