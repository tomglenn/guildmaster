import { createHash, randomBytes } from 'node:crypto';
import type { SlackTokens } from './types.ts';
import { SLACK_AUTHORIZE_URL, SLACK_SCOPES, SLACK_TOKEN_URL } from './slack.ts';

export function slackAuthorization(clientId:string,redirectUri:string) {
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
  const url=new URL(SLACK_AUTHORIZE_URL);
  url.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',resource:'https://mcp.slack.com/',state,
    scope:SLACK_SCOPES.join(','),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  return {state,verifier,url:url.href};
}
export async function slackJson(url:string,init:RequestInit,fetcher:typeof fetch=fetch):Promise<Record<string,any>> {
  const response=await fetcher(url,{...init,redirect:'error',signal:init.signal ?? AbortSignal.timeout(20_000)});
  const text=await response.text();
  if(text.length>200_000)throw new Error('Slack returned an oversized response.');
  if(!response.ok)throw new Error(response.status===429 ? 'Slack is rate limited. Try again later.' : 'Slack could not complete the connection request.');
  let data:Record<string,any>;
  try { data=JSON.parse(text); } catch { throw new Error('Slack returned an invalid response.'); }
  if(data.ok===false || data.error) {
    const error=String(data.error);
    if(['invalid_grant','invalid_refresh_token','token_revoked','invalid_auth','token_expired'].includes(error))throw new Error('Slack sign-in expired. Reconnect Slack in Settings → Connections.');
    if(['invalid_client','bad_client_secret','invalid_client_id','bad_redirect_uri','invalid_redirect_uri'].includes(error))throw new Error('Slack app sign-in could not be completed. Check the app client ID, desktop PKCE setting, and registered callback URL.');
    throw new Error('Slack could not complete the request. Check app approval and account access.');
  }
  return data;
}
export async function exchangeSlackTokens(parameters:Record<string,string>,fetcher:typeof fetch=fetch):Promise<SlackTokens> {
  const data=await slackJson(SLACK_TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...parameters,resource:'https://mcp.slack.com/'})},fetcher);
  const token=data.authed_user?.access_token ? data.authed_user : data;
  if(typeof token.access_token!=='string' || !token.access_token || token.access_token.length>16000)throw new Error('Slack did not return user credentials.');
  return {accessToken:token.access_token,refreshToken:typeof token.refresh_token==='string' ? token.refresh_token : undefined,
    expiresAt:typeof token.expires_in==='number' && token.expires_in>0 ? Date.now()+token.expires_in*1000 : undefined,
    scopes:typeof token.scope==='string' ? token.scope.split(/[ ,]+/).filter(Boolean) : []};
}
