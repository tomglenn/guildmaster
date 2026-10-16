# Third-party notices

## Slack connector configuration

The public Slack MCP client ID and callback-port preset in `src/connections/slack.ts`
come from Slack's official `slackapi/slack-skills-plugin` configuration:
https://github.com/slackapi/slack-skills-plugin/blob/main/.mcp.json

Guildmaster uses its own MCP client, read-only tool policy, OAuth implementation,
and credential storage. It does not require the Slack plugin, Pi, or Claude.
The source configuration is distributed under the following license.

The MIT License (MIT)

Copyright (c) 2020- Slack Technologies, LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
