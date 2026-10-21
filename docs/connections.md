# Connections

Guildmaster includes a Slack MCP client for reading threads, channels, and search results. It does not expose posting, reactions, or uploads.

Quest agents use locally available tools, such as an authenticated `gh` CLI, for GitHub work. The main agent can also perform bounded GitHub reads using that existing login; no additional connection setup is needed. Slack sign-in does not grant GitHub access.

## Direct GitHub and repository lookups

Ask Guildmaster to summarize an exact `https://github.com/owner/repository/issues/123` URL, or answer a bounded factual question about one uniquely identified registered repository. Pure supported reads stay in the existing main conversation: they do not create a board card, a second executor, or an acceptance step. Request a quest explicitly when you want separately tracked work. Edits, independent PR reviews, multi-repository work and open-ended investigations still require quests.

The service exposes only fixed GitHub issue/body/comments and PR-metadata reads, plus committed repository file reads and literal search. Main still has no shell or filesystem built-ins. It cannot issue arbitrary GitHub API requests, follow redirects, download attachments, or automatically follow links found in source content. Public GitHub lookups need no local project registration. Only `github.com` is supported initially.

The transitional credential adapter retrieves the existing `gh` login server-side and verifies the account before accessing source. Credentials never enter tool arguments, worker specifications or results. The account is pinned for the request. **The underlying login may have write permissions:** these server-enforced read-only tools are not a least-privilege GitHub credential connection. Existing delegated PR creation is unchanged.

Grants come from the saved direct user request, not retrieved instructions: one GitHub target or one registered repository at an exact resolved commit. Repository reads never use mutable working-tree contents, execute repository code, or read symlink/submodule content. Sensitive paths, known credential patterns, binary and oversized files are excluded; secret detection is defense-in-depth, not a guarantee. Applicable repository guidance requires delegation in this initial release rather than silently bypassing its workflow.

Each direct request shares eight source calls, at most three pages per collection, 100 KiB of aggregate returned source receipts, two concurrent reads, a 15-second read deadline, sixty seconds from the first source read and four tool-using model rounds. Retries and system resumes retain usage. These limits are separate from the model inactivity watchdog and do not promise a total latency or dollar cap. Final-answer generation is allowed after source work stops. Coverage, commit/timestamp, pagination and truncation metadata remain in saved tool evidence; incomplete coverage must be disclosed rather than described as a complete read.

Retrieved source is untrusted data. Once an inline read starts, consequential main-agent mutations are blocked for that direct request. A fresh direct user message is needed to authorize a quest or another action; source content cannot grant that authority. Cancellation fences the run and suppresses late receipts; it does not prove a remote request never completed.

Source evidence may be sent to the model and retained in the main conversation. Starting a new conversation keeps the old transcript, tool receipts, activity and attachment context inspectable in History. This does not promise indefinite retention or automatic redaction of private source evidence. No tracked-inline promotion or inline editing lifecycle is implemented.

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
