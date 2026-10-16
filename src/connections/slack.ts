import type { ConnectionTool, SlackConnection } from './types.ts';
// Public OAuth preset from Slack's MIT-licensed slack-skills-plugin. See THIRD_PARTY_NOTICES.md.
export const SLACK_CLIENT_ID='1601185624273.8899143856786';
export const SLACK_CALLBACK_PORT=3118;
export const SLACK_MCP_URL='https://mcp.slack.com/mcp';
export const SLACK_AUTHORIZE_URL='https://slack.com/oauth/v2_user/authorize';
export const SLACK_TOKEN_URL='https://slack.com/api/oauth.v2.user.access';
export const SLACK_IDENTITY_URL='https://slack.com/api/auth.test';
export const SLACK_REVOKE_URL='https://slack.com/api/auth.revoke';
export const SLACK_SCOPES=['channels:history','groups:history','channels:read','groups:read','users:read','search:read.public','search:read.private','search:read.users'];
// Exact names are authorization. Server annotations and names containing "read" are not.
const required:Record<string,string[][]>={
  slack_read_thread:[['channels:history','groups:history']],
  slack_read_channel:[['channels:history','groups:history']],
  slack_search_public:[['search:read.public']],
  slack_search_public_and_private:[['search:read.public'],['search:read.private']],
  slack_search_channels:[['search:read.public','search:read.private']],
  slack_search_users:[['search:read.users']],
  slack_read_user_profile:[['users:read']],
  slack_list_channel_members:[['channels:read','groups:read']],
  slack_list_user_channels:[['channels:read','groups:read']],
};
export function matchesTool(pattern:string,name:string) {
  const escaped=pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
  return new RegExp('^'+escaped+'$').test(name);
}
export function permittedTools(tools:ConnectionTool[],connection:Pick<SlackConnection,'scopes'|'restrictions'>):ConnectionTool[] {
  return tools.filter(tool=>required[tool.name]?.every(alternatives=>alternatives.some(scope=>connection.scopes.includes(scope))) &&
    (!connection.restrictions?.include || connection.restrictions.include.some(p=>matchesTool(p,tool.name))) &&
    !connection.restrictions?.exclude?.some(p=>matchesTool(p,tool.name)));
}
export function validateClientId(value:unknown):string {
  if(typeof value!=='string' || !/^\d{1,30}\.\d{1,30}$/.test(value.trim()))throw new Error('Enter the client ID of your approved Slack app.');
  return value.trim();
}
