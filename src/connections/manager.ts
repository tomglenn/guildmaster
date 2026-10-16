import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { AppError } from '../domain/types.ts';
import type { Store } from '../service/store.ts';
import { ConnectionStore } from './store.ts';
import { SystemCredentials } from './credentials.ts';
import type { ConnectionGrant, ConnectionLogin, ConnectionTool, ConnectionView, CredentialStore, SlackConnection, SlackTokens } from './types.ts';
import { SlackCallback } from './callback.ts';
import { SLACK_CLIENT_ID, SLACK_CALLBACK_PORT, permittedTools, SLACK_IDENTITY_URL, SLACK_MCP_URL, SLACK_REVOKE_URL, validateClientId } from './slack.ts';
import { exchangeSlackTokens, slackAuthorization, slackJson } from './oauth.ts';
import { discoverPiConnections } from './import-pi.ts';
import type { ImportCandidate } from './import-pi.ts';

export interface RemoteClient {
  listTools(cursor?:string):Promise<{tools:ConnectionTool[];nextCursor?:string}>;
  callTool(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>;
  close():Promise<void>;
  isClosed?():boolean;
}
export type ClientFactory=(token:()=>Promise<string>,fetcher:typeof fetch)=>Promise<RemoteClient>;
export const connectSlack:ClientFactory=async(token,fetcher)=>{
  const client=new Client({name:'guildmaster',version:'0.1.0'},{capabilities:{}});
  let closed=false;client.onclose=()=>{closed=true;};
  const transport=new StreamableHTTPClientTransport(new URL(SLACK_MCP_URL),{authProvider:{token},fetch:fetcher});
  try { await client.connect(transport,{timeout:20_000}); }
  catch(error) {await client.close().catch(()=>{});throw error;}
  return {
    async listTools(cursor) {return await client.listTools({cursor},{timeout:20_000}) as {tools:ConnectionTool[];nextCursor?:string};},
    callTool:(name,args,signal)=>client.callTool({name,arguments:args},{signal,timeout:45_000}),
    close:()=>client.close(),isClosed:()=>closed,
  };
};
type Login={view:ConnectionLogin;state:string;verifier:string;clientId:string;redirectUri:string;controller:AbortController};
type Pool={active:number;waiters:Array<()=>void>};
const validator=new Ajv({strict:false,allErrors:false,validateFormats:false});
const SIGN_IN='Slack sign-in expired. Reconnect Slack in Settings → Connections.';
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('Slack read was cancelled or timed out.'));
    if(signal.aborted){reject(new Error('Slack read was cancelled or timed out.'));return;}
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}


export class ConnectionManager {
  readonly records:ConnectionStore;
  private credentials:CredentialStore; private fetcher:typeof fetch; private factory:ClientFactory;
  private logins=new Map<string,Login>(); private clients=new Map<string,Promise<RemoteClient>>();
  private refreshing=new Map<string,Promise<SlackTokens>>(); private tokens=new Map<string,SlackTokens>();
  private lifetimes=new Map<string,AbortController>(); private pools=new Map<string,Pool>();
  private validators=new Map<string,ValidateFunction>(); private redactions=new Set<string>();
  private closed=false; private cleanupTimer:ReturnType<typeof setInterval>;
  serviceUrl='';
  private callbackServer:SlackCallback;
  private startingLogin=false;
  private orphanGraceMs:number;
  constructor(options:{store:Store;dataDir:string;credentials?:CredentialStore;fetcher?:typeof fetch;clientFactory?:ClientFactory;clientId?:string;callbackPort?:number;orphanGraceMs?:number}) {
    this.records=new ConnectionStore(options.store);this.credentials=options.credentials ?? new SystemCredentials(options.dataDir);
    this.fetcher=options.fetcher ?? fetch;this.factory=options.clientFactory ?? connectSlack;this.defaultClientId=options.clientId ?? process.env.GUILDMASTER_SLACK_CLIENT_ID ?? SLACK_CLIENT_ID;
    this.callbackServer=new SlackCallback(options.callbackPort ?? SLACK_CALLBACK_PORT);this.orphanGraceMs=options.orphanGraceMs ?? 10_000;
    this.cleanupTimer=setInterval(()=>this.expireLogins(),30_000);this.cleanupTimer.unref();
  }
  readonly defaultClientId:string;
  private expireLogins() {
    for(const [id,login] of this.logins) {
      if(login.view.expiresAt<Date.now() && ['waiting','working'].includes(login.view.status))this.cancelLogin(id);
      if(login.view.expiresAt<Date.now()-600_000)this.logins.delete(id);
    }
  }
  callbackUrl(clientId=this.records.current()?.clientId ?? this.defaultClientId) {if(clientId===SLACK_CLIENT_ID)return this.callbackServer.url();const url=new URL(this.serviceUrl);return `http://localhost:${url.port}/oauth/slack/callback`;}
  view():ConnectionView {
    const row=this.records.current();
    const login=[...this.logins.values()].find(l=>['waiting','working'].includes(l.view.status))?.view;
    return {login:login?{...login}:undefined,connection:row ? (({tools,...rest})=>({...rest,toolCount:tools.length}))(row) : undefined,defaultClientId:this.defaultClientId,callbackUrl:this.callbackUrl(),usesClaudeApp:(row?.clientId ?? this.defaultClientId)===SLACK_CLIENT_ID};
  }
  private importClientId(candidate:ImportCandidate) {return candidate.clientId ?? this.records.current()?.clientId ?? this.defaultClientId;}
  async importPreview(home?:string) {
    const preview=await discoverPiConnections(home);
    return {...preview,candidates:preview.candidates.map(c=>({...c,usesClaudeApp:this.importClientId(c)===SLACK_CLIENT_ID}))};
  }
  async importSettings(candidateId:unknown,clientId?:unknown,home?:string) {
    const candidate=(await discoverPiConnections(home)).candidates.find(c=>c.id===candidateId);
    if(!candidate)throw new AppError('The connection settings changed. Preview the import again.',409);
    return this.configure(clientId ?? this.importClientId(candidate),candidate.restrictions);
  }
  snapshot():ConnectionGrant[] {
    return this.records.list().filter(c=>c.enabled&&!c.retired&&c.teamId&&c.userId).map(c=>({connectionId:c.id,teamId:c.teamId!,userId:c.userId!,tools:permittedTools(c.tools,c)}));
  }
  statuses() {return this.records.list().filter(c=>!c.retired).map(c=>({id:c.id,provider:c.provider,status:c.status,enabled:c.enabled,workspace:c.teamName,account:c.userName}));}
  configure(clientId:unknown,restrictions?:SlackConnection['restrictions']) {
    if(this.startingLogin||[...this.logins.values()].some(l=>['waiting','working'].includes(l.view.status)))throw new AppError('Finish or cancel Slack sign-in before importing settings.',409);
    const id=validateClientId(clientId),existing=this.records.current();
    if(existing?.enabled)throw new AppError('Disconnect Slack before replacing its settings.',409);
    if(restrictions && [restrictions.include,restrictions.exclude].some(list=>list && (!Array.isArray(list)||list.length>100||list.some(p=>typeof p!=='string'||p.length>150))))throw new AppError('Unsupported tool restrictions.');
    const row:SlackConnection={version:1,id:randomUUID(),provider:'slack',clientId:id,enabled:false,status:'disconnected',tools:[],restrictions,scopes:[],createdAt:Date.now(),updatedAt:Date.now()};
    if(existing)this.records.save({...existing,retired:true});this.records.save(row);return this.view();
  }
  async startLogin(clientId?:unknown):Promise<ConnectionLogin> {
    if(this.closed)throw new AppError('The service is stopping.',503);
    this.expireLogins();
    if(this.logins.size>=40)for(const [id,login] of this.logins){if(!['working','waiting'].includes(login.view.status)){this.logins.delete(id);break;}}
    const current=this.records.current();const selected=validateClientId(clientId ?? current?.clientId ?? this.defaultClientId);
    if(current?.enabled && selected!==current.clientId)throw new AppError('Disconnect Slack before changing its app.',409);
    if(this.startingLogin)throw new AppError('Slack sign-in is starting. Try again shortly.',409);
    for(const login of this.logins.values())if(['working','waiting'].includes(login.view.status))throw new AppError('A Slack sign-in is already open. Finish or cancel it first.',409);
    this.startingLogin=true;
    try {
      if(selected===SLACK_CLIENT_ID)await this.callbackServer.start((state,code,denied)=>this.callback(state,code,denied));
      if(this.closed)throw new AppError('The service is stopping.',503);
    }catch(error){this.callbackServer.stop();throw error;}finally{this.startingLogin=false;}
    const redirectUri=this.callbackUrl(selected),auth=slackAuthorization(selected,redirectUri);
    const view:ConnectionLogin={id:randomUUID(),status:'waiting',url:auth.url,expiresAt:Date.now()+600_000};
    this.logins.set(view.id,{view,state:auth.state,verifier:auth.verifier,clientId:selected,redirectUri,controller:new AbortController()});return {...view};
  }
  login(id:string) {const login=this.logins.get(id);if(!login)throw new AppError('Slack sign-in was not found. Start again.',404);return {...login.view};}
  cancelLogin(id:string) {const login=this.logins.get(id);if(login && ['working','waiting'].includes(login.view.status)){login.controller.abort();this.callbackServer.stop();login.state='';login.verifier='';login.view={...login.view,url:undefined,status:'cancelled'};}return this.login(id);}
  async callback(state:string|null,code:string|null,denied:boolean):Promise<boolean> {
    const login=[...this.logins.values()].find(l=>l.state && l.state===state);
    if(!login || login.view.status!=='waiting' || login.view.expiresAt<Date.now())throw new AppError('Slack sign-in expired or was already used. Start again in Settings → Connections.');
    login.state='';login.view={...login.view,url:undefined,status:'working'};
    const active=()=>{if(this.closed||login.controller.signal.aborted||login.view.expiresAt<Date.now())throw new Error('Slack sign-in was cancelled.');};
    let tokens:SlackTokens|undefined,committed=false;
    try {
      if(denied){login.view={...login.view,status:'cancelled'};return false;}
      if(typeof code!=='string'||!code||code.length>10000)throw new Error('Slack did not return a sign-in code.');
      active();tokens=await exchangeSlackTokens({grant_type:'authorization_code',client_id:login.clientId,redirect_uri:login.redirectUri,code,code_verifier:login.verifier},this.authFetch(login.controller.signal));
      const issued=tokens;this.remember(issued);
      const who=await slackJson(SLACK_IDENTITY_URL,{method:'POST',headers:{Authorization:`Bearer ${issued.accessToken}`},signal:AbortSignal.any([login.controller.signal,AbortSignal.timeout(20_000)])},this.fetcher);
      if(typeof who.team_id!=='string'||typeof who.user_id!=='string')throw new Error('Slack did not identify the connected workspace and account.');
      const previous=this.records.current();
      // Each authorization has independent credentials and fresh grants, even for the same account.
      const row:SlackConnection={version:1,id:randomUUID(),provider:'slack',clientId:login.clientId,teamId:who.team_id,userId:who.user_id,
        teamName:typeof who.team==='string'?who.team:who.team_id,userName:typeof who.user==='string'?who.user:who.user_id,
        enabled:true,status:'connected',tools:[],scopes:issued.scopes,restrictions:previous?.restrictions,createdAt:Date.now(),updatedAt:Date.now()};
      let client:RemoteClient|undefined;
      try {client=await this.factory(async()=>issued.accessToken,this.networkFetch(login.controller.signal));row.tools=await this.discover(client,row);}
      finally {await client?.close().catch(()=>{});}
      if(!row.tools.length)throw new Error('Slack connected, but no permitted read tools are available. Check the approved scopes.');
      active();await this.credentials.set(row.id,issued);
      try {active();}catch(error){await this.credentials.delete(row.id).catch(()=>{});throw error;}
      // Account changes get a fresh ID, so outstanding run grants cannot transfer.
      if(previous)this.fence(previous.id);
      if(previous)this.records.save({...previous,retired:true,enabled:false,status:'disconnected'});
      this.records.save(row);committed=true;this.tokens.set(row.id,issued);
      if(previous)await this.credentials.delete(previous.id).catch(()=>{});
      login.view={...login.view,status:'complete'};return true;
    } catch(error) {
      if(login.view.status!=='cancelled')login.view={...login.view,status:'error',error:this.safeError(error,'Slack could not be connected. Check app approval and try again.')};
      if(tokens&&!committed)await this.revoke(tokens);
      return false;
    } finally {login.verifier='';this.callbackServer.stop();}
  }
  private async revoke(tokens:SlackTokens) {await slackJson(SLACK_REVOKE_URL,{method:'POST',headers:{Authorization:`Bearer ${tokens.accessToken}`},signal:AbortSignal.timeout(5000)},this.fetcher).catch(()=>{});}
  private authFetch(signal?:AbortSignal):typeof fetch {return (input,init)=>this.fetcher(input,{...init,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20_000)]):AbortSignal.timeout(20_000),redirect:'error'});}
  private remember(tokens:SlackTokens) {this.redactions.add(tokens.accessToken);if(tokens.refreshToken)this.redactions.add(tokens.refreshToken);}
  private redact(value:string) {for(const secret of this.redactions)if(secret)value=value.split(secret).join('[redacted]');return value;}
  private safeError(error:unknown,fallback:string) {
    if(error instanceof Error && /^(Slack |The secure credential store|Slack credentials)/.test(error.message))return this.redact(error.message);
    return fallback;
  }
  private networkFetch(lifetime:AbortSignal,id?:string):typeof fetch {
    return async(input,init)=>{
      const url=String(input instanceof Request ? input.url : input);
      if(new URL(url).origin!==new URL(SLACK_MCP_URL).origin || new URL(url).pathname!=='/mcp')throw new Error('Unsupported Slack endpoint.');
      const signal=AbortSignal.any([lifetime,...(init?.signal?[init.signal]:[]),AbortSignal.timeout(50_000)]);
      let response=await this.fetcher(input,{...init,redirect:'error',signal});
      if(response.status===401&&id) {
        await response.body?.cancel();signal.throwIfAborted();
        const row=this.records.get(id);if(!row)throw new Error(SIGN_IN);this.assertEnabled(row);
        const previous=this.tokens.get(id) ?? await this.credentials.get(id);
        if(!previous?.refreshToken)throw new Error(SIGN_IN);
        let refreshed=this.tokens.get(id);
        if(!refreshed || new Headers(init?.headers).get('Authorization')===`Bearer ${refreshed.accessToken}`)refreshed=await this.refreshOnce(id,row,previous);
        signal.throwIfAborted();this.assertEnabled(row);
        const headers=new Headers(init?.headers);headers.set('Authorization',`Bearer ${refreshed.accessToken}`);
        response=await this.fetcher(input,{...init,headers,redirect:'error',signal});
      }
      if(response.status===401)throw new Error(SIGN_IN);
      if(response.status===429) {const seconds=Number(response.headers.get('retry-after'));throw new AppError(`Slack is rate limited. Try again${Number.isFinite(seconds)&&seconds>0?` in ${Math.ceil(seconds)} seconds`: ' later'}.`,429);}
      if(!response.body)return response;
      let size=0;
      const bounded=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){size+=chunk.byteLength;if(size>4_000_000)throw new Error('Slack response exceeded the supported size.');controller.enqueue(chunk);}}));
      return new Response(bounded,{status:response.status,statusText:response.statusText,headers:response.headers});
    };
  }
  private async discover(client:RemoteClient,row:SlackConnection) {
    const found:ConnectionTool[]=[];let cursor:string|undefined;
    const seen=new Set<string>();
    for(let page=0;page<10;page++) {
      const result=await client.listTools(cursor);
      if(!Array.isArray(result.tools)||result.tools.length>500)throw new Error('Slack returned an invalid tool catalog.');
      for(const raw of permittedTools(result.tools,row)) {
        const tool=JSON.parse(this.redact(JSON.stringify(raw))) as ConnectionTool;
        if(seen.has(tool.name)||JSON.stringify(tool).length>60000||tool.inputSchema?.type!=='object')continue;
        this.compile(tool);seen.add(tool.name);found.push({name:tool.name,description:tool.description?.slice(0,5000),inputSchema:tool.inputSchema});
      }
      if(!result.nextCursor)return found; if(result.nextCursor===cursor)throw new Error('Slack tool discovery did not finish.');cursor=result.nextCursor;
    }
    throw new Error('Slack tool discovery exceeded the page limit.');
  }
  private compile(tool:ConnectionTool) {
    const key=JSON.stringify(tool.inputSchema);let fn=this.validators.get(key);
    if(!fn) {fn=validator.compile(tool.inputSchema);this.validators.set(key,fn);}return fn;
  }
  private async token(id:string):Promise<string> {
    const row=this.records.get(id);if(!row?.enabled||row.retired)throw new Error('Slack is disconnected. Connect Slack in Settings → Connections.');
    let tokens=this.tokens.get(id) ?? await this.credentials.get(id);
    tokens=this.tokens.get(id) ?? tokens;
    if(!tokens)throw new Error(SIGN_IN);this.remember(tokens);
    if(tokens.expiresAt && tokens.expiresAt<Date.now()+60_000) {
      tokens=await this.refreshOnce(id,row,tokens);
    }
    this.tokens.set(id,tokens);return tokens.accessToken;
  }
  private refreshOnce(id:string,row:SlackConnection,tokens:SlackTokens) {
    let task=this.refreshing.get(id);
    if(!task){task=this.refresh(id,row,tokens);this.refreshing.set(id,task);task.finally(()=>this.refreshing.delete(id)).catch(()=>{});}
    return task;
  }
  private async refresh(id:string,row:SlackConnection,old:SlackTokens) {
    if(!old.refreshToken)throw new Error(SIGN_IN);
    const lifetime=this.lifetime(id);
    const next=await exchangeSlackTokens({grant_type:'refresh_token',refresh_token:old.refreshToken,client_id:row.clientId},this.authFetch(lifetime.signal));
    if(!next.scopes.length)next.scopes=old.scopes;
    if(!next.refreshToken)next.refreshToken=old.refreshToken;
    this.remember(next);
    try {
      this.assertEnabled(row);if(lifetime.signal.aborted)throw new Error('Slack is disconnected.');
      await this.credentials.set(id,next);
      if(lifetime.signal.aborted){if(!this.closed)await this.credentials.delete(id).catch(()=>{});throw new Error('Slack is disconnected.');}
    } catch(error) {if(!this.closed&&!this.records.get(id)?.retired)await this.revoke(next);throw error;}
    this.tokens.set(id,next);this.records.save({...this.records.get(id)!,scopes:next.scopes,status:'connected'});return next;
  }
  private lifetime(id:string) {let controller=this.lifetimes.get(id);if(!controller){controller=new AbortController();this.lifetimes.set(id,controller);}return controller;}
  private assertEnabled(row:SlackConnection) {const current=this.records.get(row.id);if(this.closed||!current?.enabled||current.retired||current.teamId!==row.teamId||current.userId!==row.userId)throw new AppError('Slack is disconnected. Connect Slack in Settings → Connections.',403);return current;}
  private async client(row:SlackConnection,retried=false):Promise<RemoteClient> {
    let client=this.clients.get(row.id);
    if(!client) {
      client=this.factory(()=>this.token(row.id),this.networkFetch(this.lifetime(row.id).signal,row.id));this.clients.set(row.id,client);
      client.catch(()=>{if(this.clients.get(row.id)===client)this.clients.delete(row.id);});
    }
    const ready=await client;
    if(ready.isClosed?.()){if(this.clients.get(row.id)===client)this.clients.delete(row.id);if(retried)throw new Error('Slack connection closed. Try again shortly.');return this.client(row,true);}
    return ready;
  }
  private async acquire(id:string,signal:AbortSignal) {
    let pool=this.pools.get(id);if(!pool){pool={active:0,waiters:[]};this.pools.set(id,pool);}
    while(pool.active>=2) {
      if(pool.waiters.length>=30)throw new AppError('Slack has too many pending reads. Try again shortly.',429);
      await new Promise<void>((resolve,reject)=>{
        const done=()=>{signal.removeEventListener('abort',abort);const index=pool!.waiters.indexOf(done);if(index>=0)pool!.waiters.splice(index,1);resolve();};
        const abort=()=>{const index=pool!.waiters.indexOf(done);if(index>=0)pool!.waiters.splice(index,1);signal.removeEventListener('abort',abort);reject(new Error('Slack read was cancelled.'));};
        pool!.waiters.push(done);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      });
    }
    signal.throwIfAborted();pool.active++;
    return ()=>{pool!.active--;pool!.waiters.shift()?.();};
  }
  async call(grant:ConnectionGrant,name:unknown,args:unknown,signal:AbortSignal):Promise<unknown> {
    const row=this.records.get(grant.connectionId);
    if(!row||row.teamId!==grant.teamId||row.userId!==grant.userId)throw new AppError('This run does not have access to the connected Slack account.',403);
    this.assertEnabled(row);
    const tool=typeof name==='string' && grant.tools.find(t=>t.name===name);
    const permitted=permittedTools(row.tools,row).find(t=>t.name===name);
    if(!tool||!permitted)throw new AppError('This Slack tool is not permitted.',403);
    if(!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args).length>100_000||!this.compile(permitted)(args))throw new AppError('The Slack tool arguments are invalid.');
    const combined=AbortSignal.any([signal,this.lifetime(row.id).signal,AbortSignal.timeout(60_000)]);
    const release=await this.acquire(row.id,combined);
    let client:RemoteClient|undefined,pending:Promise<unknown>|undefined;
    try {
      combined.throwIfAborted();this.assertEnabled(row);
      client=await abortable(this.client(row),combined);combined.throwIfAborted();
      pending=client.callTool(permitted.name,args as Record<string,unknown>,combined);
      const result=await abortable(pending,combined);
      combined.throwIfAborted();this.assertEnabled(row);
      // Return source text only. No automatic resource downloads or binary content.
      const parts=(result as any)?.content;
      const content:Array<{type:'text';text:string}>=[];let remaining=60_000,truncated=false;
      if(Array.isArray(parts))for(const part of parts)if(part.type==='text'&&typeof part.text==='string') {
        const value=this.redact(part.text);const text=value.slice(0,remaining);if(text.length<value.length)truncated=true;
        if(text)content.push({type:'text',text});remaining-=text.length;
      }
      if(!content.length && (result as any)?.structuredContent) {const value=this.redact(JSON.stringify((result as any).structuredContent));content.push({type:'text',text:value.slice(0,remaining)});truncated=value.length>remaining;}
      if(truncated)content.push({type:'text',text:'This Slack response was truncated. Do not treat it as complete. Request a smaller page or narrower query.'});
      if(!content.length)content.push({type:'text',text:'Slack returned no readable text. Linked files and binary content were not fetched.'});
      return {content,isError:!!(result as any)?.isError,truncated};
    } catch(error) {
      if(error instanceof Error && error.message===SIGN_IN){const current=this.records.get(row.id);if(current?.enabled)this.records.save({...current,status:'sign_in_required'});}
      if(error instanceof AppError)throw new AppError(this.redact(error.message),error.status);
      throw new AppError(combined.aborted?'Slack read was cancelled or timed out.':this.safeError(error,'Slack could not be read. Check the connection and try again.'),502);
    } finally {if(client&&pending)void this.settle(row.id,client,pending).finally(release);else release();}
  }
  // Bounded tradeoff: closing the shared client after the grace period also fails healthy reads still in flight on it.
  private async settle(id:string,client:RemoteClient,pending:Promise<unknown>) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const settled=await Promise.race([pending.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),this.orphanGraceMs);})]);
    clearTimeout(timer);if(settled)return;
    const current=this.clients.get(id);
    if(current&&await current.then(c=>c===client,()=>false)&&this.clients.get(id)===current)this.clients.delete(id);
    await client.close().catch(()=>{});
  }
  private fence(id:string) {this.lifetimes.get(id)?.abort();this.lifetimes.delete(id);const client=this.clients.get(id);this.clients.delete(id);void client?.then(c=>c.close()).catch(()=>{});this.tokens.delete(id);}
  async disconnect() {
    for(const login of this.logins.values())if(['working','waiting'].includes(login.view.status))this.cancelLogin(login.view.id);
    const row=this.records.current();if(!row)return this.view();
    this.records.save({...row,enabled:false,status:'disconnected'});this.fence(row.id);
    let tokens:SlackTokens|undefined;let removalError:unknown;
    try {tokens=await this.credentials.get(row.id);}catch(error){removalError=error;}
    try {await this.credentials.delete(row.id);}catch(error){removalError=error;}
    if(tokens)await this.revoke(tokens);
    if(removalError)throw removalError;return this.view();
  }
  async close() {this.closed=true;this.callbackServer.stop();clearInterval(this.cleanupTimer);for(const login of this.logins.values())login.controller.abort();const clients=[...this.clients.values()];for(const id of this.lifetimes.keys())this.fence(id);await Promise.allSettled(clients.map(async c=>(await c).close()));this.tokens.clear();}
}
