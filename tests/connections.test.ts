import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/service/store.ts';
import { ConnectionManager } from '../src/connections/manager.ts';
import type { ClientFactory } from '../src/connections/manager.ts';
import type { ConnectionTool, CredentialStore, SlackTokens } from '../src/connections/types.ts';
import { SLACK_CLIENT_ID, SLACK_SCOPES, permittedTools } from '../src/connections/slack.ts';
import { discoverPiConnections } from '../src/connections/import-pi.ts';
import { createServer } from 'node:http';
import { connectionTools } from '../src/engine/connection-tools.ts';
import type { WorkerSpec } from '../src/engine/protocol.ts';

const read:ConnectionTool={name:'slack_read_thread',description:'Read a Slack thread.',inputSchema:{type:'object',properties:{channel_id:{type:'string'},cursor:{type:'string'}},required:['channel_id'],additionalProperties:false}};
const tools=[read,{...read,name:'slack_send_message'},{...read,name:'slack_read_unknown'},{...read,name:'slack_search_public'}];
class MemoryCredentials implements CredentialStore {
  values=new Map<string,SlackTokens>();
  async get(id:string) {return this.values.get(id);}
  async set(id:string,tokens:SlackTokens) {this.values.set(id,tokens);}
  async delete(id:string) {this.values.delete(id);}
}
async function fixture(t:any,options:{factory?:ClientFactory;fetcher?:typeof fetch;credentials?:MemoryCredentials;clientId?:string;callbackPort?:number;orphanGraceMs?:number}={}) {
  const dir=await mkdtemp(join(tmpdir(),'guildmaster-connections-')),store=new Store(dir),credentials=options.credentials ?? new MemoryCredentials();
  let reads=0,refreshes=0,team='T-example';
  const requests:Array<{url:string;body:string;authorization?:string|null}>=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);requests.push({url,body:String(init?.body ?? ''),authorization:new Headers(init?.headers).get('Authorization')});
    if(url.endsWith('auth.test'))return Response.json({ok:true,team_id:team,team:'Example workspace',user_id:'U-example',user:'Example user'});
    if(url.endsWith('auth.revoke'))return Response.json({ok:true,revoked:true});
    const body=new URLSearchParams(String(init?.body));
    if(body.get('grant_type')==='refresh_token')refreshes++;
    return Response.json({ok:true,access_token:'fixture-access-'+refreshes,refresh_token:'fixture-refresh-'+refreshes,scope:SLACK_SCOPES.join(','),expires_in:3600});
  };
  const factory:ClientFactory=options.factory ?? (async token=>({listTools:async()=>({tools}),callTool:async(_name,args)=>{await token();reads++;return {content:[{type:'text',text:'Thread page '+(args.cursor ?? 'first')+' fixture-access-0'}]};},close:async()=>{}}));
  const manager=new ConnectionManager({store,dataDir:dir,credentials,fetcher:options.fetcher ?? fetcher,clientFactory:factory,clientId:options.clientId ?? '123.456',callbackPort:options.callbackPort,orphanGraceMs:options.orphanGraceMs});manager.serviceUrl='http://127.0.0.1:4173';
  t.after(async()=>{await manager.close();store.close();await rm(dir,{recursive:true,force:true});});
  const login=async()=>{const attempt=await manager.startLogin();const url=new URL(attempt.url!);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),manager.callbackUrl());assert.ok(!url.searchParams.has('client_secret'));assert.equal(await manager.callback(url.searchParams.get('state'),'fixture-code',false),true,JSON.stringify(manager.login(attempt.id)));return attempt;};
  return {dir,store,credentials,manager,login,requests,reads:()=>reads,refreshes:()=>refreshes,setTeam:(value:string)=>{team=value;}};
}

test('standalone Slack sign-in persists only metadata, filters tools, validates arguments, and redacts credentials',async t=>{
  const f=await fixture(t);const attempt=await f.login();
  assert.equal(f.manager.login(attempt.id).status,'complete');
  const grant=f.manager.snapshot()[0];assert.equal(grant.tools.length,2);
  assert.ok(!JSON.stringify(f.manager.view()).includes('fixture-access'));
  assert.ok(!JSON.stringify(f.manager.records.list()).includes('fixture-refresh'));
  assert.equal(f.credentials.values.size,1);
  const result=await f.manager.call(grant,'slack_read_thread',{channel_id:'C-example'},new AbortController().signal);
  assert.match(JSON.stringify(result),/\[redacted\]/);assert.equal(f.reads(),1);
  await assert.rejects(f.manager.call(grant,'slack_send_message',{channel_id:'C-example'},new AbortController().signal),/not permitted/);
  await assert.rejects(f.manager.call(grant,'slack_read_unknown',{channel_id:'C-example'},new AbortController().signal),/not permitted/);
  await assert.rejects(f.manager.call(grant,'slack_read_thread',{channel_id:3},new AbortController().signal),/arguments are invalid/);
  await assert.rejects(f.manager.callback(new URL(attempt.url!).searchParams.get('state'),'again',false),/expired or was already used/);
  assert.equal(f.reads(),1);
});

test('cancelled and invalid OAuth callbacks cannot save a connection',async t=>{
  const f=await fixture(t);const attempt=await f.manager.startLogin();
  await assert.rejects(f.manager.callback('not-the-state','code',false),/expired/);
  f.manager.cancelLogin(attempt.id);
  await assert.rejects(f.manager.callback(new URL(attempt.url!).searchParams.get('state'),'code',false),/expired/);
  assert.equal(f.credentials.values.size,0);assert.equal(f.manager.snapshot().length,0);
});

test('concurrent reads refresh rotating tokens once and preserve narrower tool restrictions',async t=>{
  const f=await fixture(t);await f.login();const grant=f.manager.snapshot()[0];
  const tokens=f.credentials.values.get(grant.connectionId)!;tokens.expiresAt=Date.now()-1;
  await Promise.all([1,2,3].map(()=>f.manager.call(grant,read.name,{channel_id:'C-example'},new AbortController().signal)));
  assert.equal(f.refreshes(),1);assert.equal(f.reads(),3);
  const row=f.manager.records.current()!;f.manager.records.save({...row,restrictions:{exclude:['*thread*']}});
  await assert.rejects(f.manager.call(grant,read.name,{channel_id:'C-example'},new AbortController().signal),/not permitted/);
});

test('a replacement Slack account cannot inherit old grants and disconnect prevents dispatch',async t=>{
  const f=await fixture(t);await f.login();const old=f.manager.snapshot()[0];
  f.setTeam('T-other');await f.login();const next=f.manager.snapshot()[0];assert.notEqual(old.connectionId,next.connectionId);
  await assert.rejects(f.manager.call(old,read.name,{channel_id:'C-example'},new AbortController().signal),/disconnected/);
  assert.equal(f.credentials.values.has(old.connectionId),false);
  await f.manager.disconnect();assert.equal(f.manager.snapshot().length,0);assert.equal(f.credentials.values.size,0);
  await assert.rejects(f.manager.call(next,read.name,{channel_id:'C-example'},new AbortController().signal),/disconnected/);
});

test('cancelling one queued read does not close a shared connection or cancel another quest',async t=>{
  let active=0,max=0,closed=0;const releases:Array<()=>void>=[];
  const factory:ClientFactory=async()=>({listTools:async()=>({tools:[read]}),close:async()=>{closed++;},callTool:async(_name,_args,signal)=>{
    active++;max=Math.max(max,active);
    try {await new Promise<void>((resolve,reject)=>{releases.push(resolve);signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});return {content:[{type:'text',text:'Completed read'}]};}finally{active--;}
  }});
  const f=await fixture(t,{factory});await f.login();const grant=f.manager.snapshot()[0],controller=new AbortController();
  const first=f.manager.call(grant,read.name,{channel_id:'first'},new AbortController().signal);
  const second=f.manager.call(grant,read.name,{channel_id:'second'},new AbortController().signal);
  while(active<2)await new Promise(r=>setTimeout(r,5));
  const third=f.manager.call(grant,read.name,{channel_id:'third'},controller.signal);const rejected=assert.rejects(third,/cancelled|aborted/i);controller.abort();await rejected;
  assert.equal(active,2);assert.equal(closed,1,'Only the temporary login client has closed');assert.equal(max,2);
  releases.forEach(resolve=>resolve());await Promise.all([first,second]);assert.equal(closed,1);
});

test('disconnect fences in-flight responses even when a transport ignores cancellation',async t=>{
  let release!:()=>void,started=false;
  const f=await fixture(t,{factory:async()=>({listTools:async()=>({tools:[read]}),close:async()=>{},callTool:async()=>{started=true;await new Promise<void>(r=>{release=r;});return {content:[{type:'text',text:'late result'}]};}})});
  await f.login();const call=f.manager.call(f.manager.snapshot()[0],read.name,{channel_id:'C-example'},new AbortController().signal);
  const rejected=assert.rejects(call,/cancelled|disconnected/);
  while(!started)await new Promise(r=>setTimeout(r,5));await f.manager.disconnect();release();await rejected;
});

test('catalog snapshots do not connect to the network during unrelated worker startup',async t=>{
  let connections=0;
  const f=await fixture(t,{factory:async()=>{connections++;return {listTools:async()=>({tools:[read]}),callTool:async()=>({}),close:async()=>{}};}});
  await f.login();assert.equal(connections,1);
  for(let i=0;i<5;i++)assert.equal(f.manager.snapshot().length,1);
  assert.equal(connections,1);
});

test('Pi import copies only settings and restrictions without executing commands or copying identities',async t=>{
  const f=await fixture(t),path=join(f.dir,'.config/mcp');await mkdir(path,{recursive:true});
  const value={mcpServers:{slack:{url:'https://mcp.slack.com/mcp',oauth:{clientId:'foreign-app-id',clientSecret:'fixture-only-secret'},headers:{Authorization:'fixture-only-token'},includeTools:['*read*'],excludeTools:['*write*'],command:'must-not-execute'},other:{url:'http://localhost:9999',command:'must-not-execute'}}};
  await writeFile(join(path,'mcp.json'),JSON.stringify(value));
  const preview=await discoverPiConnections(f.dir);assert.equal(preview.candidates.length,1);
  const serialized=JSON.stringify(preview);for(const secret of ['foreign-app-id','fixture-only-secret','fixture-only-token','must-not-execute'])assert.ok(!serialized.includes(secret));
  const selected=preview.candidates[0];f.manager.configure('123.456',selected.restrictions);await f.login();
  assert.deepEqual(f.manager.snapshot()[0].tools.map(t=>t.name),['slack_read_thread']);
});

test('Slack presets require scopes and deny unknown tools regardless of read-only annotations',()=>{
  assert.equal(permittedTools(tools,{scopes:[],restrictions:undefined}).length,0);
  assert.deepEqual(permittedTools(tools,{scopes:SLACK_SCOPES,restrictions:{include:['*read*']}}).map(t=>t.name),['slack_read_thread']);
  const spec={serviceUrl:'http://127.0.0.1:4173',connectionToken:'fixture-run-token',connectionGrants:[{connectionId:'c',teamId:'t',userId:'u',tools:[read]}]} as WorkerSpec;
  assert.deepEqual(connectionTools(spec).map(tool=>tool.name),['connection_status','slack_read_thread']);
  assert.deepEqual(connectionTools({} as WorkerSpec),[]);
});


test('bundled Slack preset uses a short-lived loopback callback without Pi configuration or manual app setup',async t=>{
  const f=await fixture(t,{clientId:SLACK_CLIENT_ID,callbackPort:0});
  const attempt=await f.manager.startLogin(),auth=new URL(attempt.url!);
  assert.equal(auth.searchParams.get('client_id'),SLACK_CLIENT_ID);
  assert.equal(auth.searchParams.get('resource'),'https://mcp.slack.com/');
  const callback=new URL(auth.searchParams.get('redirect_uri')!);
  assert.equal(callback.hostname,'localhost');assert.equal(callback.pathname,'/callback');
  callback.search=new URLSearchParams({state:'wrong-state',code:'never-echo-this-code'}).toString();
  const bad=await fetch(callback);assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes('never-echo-this-code'));
  assert.equal(f.manager.login(attempt.id).status,'waiting');
  callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'fixture-code'}).toString();
  const good=await fetch(callback);assert.equal(good.status,200);assert.match(await good.text(),/Slack connected/);
  assert.equal(f.manager.login(attempt.id).status,'complete');
  assert.equal(f.manager.snapshot().length,1);
  await assert.rejects(fetch(callback),'The callback listener closes after use');
});

test('an occupied Slack callback port produces a clear error and does not terminate another application',async t=>{
  const occupied=createServer((_req,res)=>res.end('Other app'));
  await new Promise<void>(resolve=>occupied.listen(0,'localhost',resolve));
  t.after(()=>new Promise<void>(resolve=>occupied.close(()=>resolve())));
  const port=(occupied.address() as {port:number}).port;
  const f=await fixture(t,{clientId:SLACK_CLIENT_ID,callbackPort:port});
  await assert.rejects(f.manager.startLogin(),/callback port is busy/);
  assert.equal(await fetch(`http://localhost:${port}`).then(r=>r.text()),'Other app');
  assert.equal(f.manager.snapshot().length,0);
});

test('a failed credential save preserves the previous connected account and never exposes raw store errors',async t=>{
  class LockableCredentials extends MemoryCredentials {
    locked=false;
    async set(id:string,tokens:SlackTokens) {if(this.locked)throw new Error('OS store refused fixture-secret-canary');await super.set(id,tokens);}
  }
  const credentials=new LockableCredentials(),f=await fixture(t,{credentials});await f.login();
  const before=f.manager.snapshot()[0];credentials.locked=true;f.setTeam('T-replacement');
  const attempt=await f.manager.startLogin();
  assert.equal(await f.manager.callback(new URL(attempt.url!).searchParams.get('state'),'fixture-code',false),false);
  assert.equal(f.manager.snapshot()[0].connectionId,before.connectionId);
  assert.equal(credentials.values.size,1);assert.ok(!JSON.stringify(f.manager.login(attempt.id)).includes('fixture-secret-canary'));
});

test('saved Slack connections survive a service runtime restart with independent credentials',async t=>{
  const f=await fixture(t);await f.login();const original=f.manager.snapshot()[0];await f.manager.close();
  const restarted=new ConnectionManager({store:f.store,dataDir:f.dir,credentials:f.credentials,clientFactory:async token=>({listTools:async()=>({tools:[read]}),callTool:async()=>({content:[{type:'text',text:(await token()).startsWith('fixture-access')?'Restored credentials worked':'bad'}]}),close:async()=>{}})});
  restarted.serviceUrl='http://127.0.0.1:4173';t.after(()=>restarted.close());
  assert.equal(restarted.snapshot()[0].connectionId,original.connectionId);
  const result=await restarted.call(restarted.snapshot()[0],read.name,{channel_id:'C-example'},new AbortController().signal);
  assert.match(JSON.stringify(result),/Restored credentials worked/);
});


test('declining Slack authorization is cancellation, not a retry error or saved connection',async t=>{
  const f=await fixture(t,{clientId:SLACK_CLIENT_ID,callbackPort:0});
  const login=await f.manager.startLogin(),auth=new URL(login.url!);
  const callback=new URL(auth.searchParams.get('redirect_uri')!);
  callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,error:'access_denied'}).toString();
  const response=await fetch(callback);assert.equal(response.status,200);assert.match(await response.text(),/Slack sign-in cancelled/);
  assert.equal(f.manager.login(login.id).status,'cancelled');assert.equal(f.manager.snapshot().length,0);assert.equal(f.credentials.values.size,0);
});

test('Pi import identifies explicit custom client IDs and discloses the Claude app only when it will be used',async t=>{
  const f=await fixture(t,{clientId:SLACK_CLIENT_ID}),path=join(f.dir,'.config/mcp');await mkdir(path,{recursive:true});
  await writeFile(join(path,'mcp.json'),JSON.stringify({mcpServers:{custom:{url:'https://mcp.slack.com/mcp',oauth:{clientId:' 999.111 '}},preset:{url:'https://mcp.slack.com/mcp'}}}));
  assert.equal(f.manager.view().usesClaudeApp,true);
  const preview=await f.manager.importPreview(f.dir);
  const custom=preview.candidates.find(c=>c.name==='custom')!,preset=preview.candidates.find(c=>c.name==='preset')!;
  assert.equal(custom.clientId,'999.111');assert.equal(custom.usesClaudeApp,false);
  assert.equal(preset.clientId,undefined);assert.equal(preset.usesClaudeApp,true);
  const configured=await f.manager.importSettings(custom.id,undefined,f.dir);
  assert.equal(configured.connection?.clientId,'999.111');assert.equal(configured.usesClaudeApp,false);
  assert.equal(new URL((await f.manager.startLogin()).url!).searchParams.get('client_id'),'999.111');
  await assert.rejects(f.manager.importSettings('missing',undefined,f.dir),/Preview the import again/);
});

test('failed or cancelled sign-in revokes the fresh token without touching the committed connection',async t=>{
  let catalog:ConnectionTool[]=tools,hold:Promise<void>|undefined,issued=0,team='T-example';const revocations:Array<string|null>=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith('auth.test'))return Response.json({ok:true,team_id:team,user_id:'U-example'});
    if(url.endsWith('auth.revoke')){revocations.push(new Headers(init?.headers).get('Authorization'));return Response.json({ok:true,revoked:true});}
    issued++;return Response.json({ok:true,access_token:'fixture-access-'+issued,refresh_token:'fixture-refresh-'+issued,scope:SLACK_SCOPES.join(','),expires_in:3600});
  };
  const f=await fixture(t,{fetcher,factory:async()=>({listTools:async()=>{await hold;return {tools:catalog};},callTool:async()=>({content:[{type:'text',text:'ok'}]}),close:async()=>{}})});
  await f.login();const committed=f.manager.snapshot()[0],committedToken=f.credentials.values.get(committed.connectionId)!.accessToken;
  const revoked=()=>revocations;
  catalog=[];team='T-replacement';
  const failed=await f.manager.startLogin();
  assert.equal(await f.manager.callback(new URL(failed.url!).searchParams.get('state'),'fixture-code',false),false);
  assert.equal(f.manager.login(failed.id).status,'error');
  assert.deepEqual(revoked(),['Bearer fixture-access-2']);assert.notEqual(committedToken,'fixture-access-2');
  catalog=tools;let resume!:()=>void;hold=new Promise(r=>{resume=r;});
  const cancelled=await f.manager.startLogin();
  const pending=f.manager.callback(new URL(cancelled.url!).searchParams.get('state'),'fixture-code',false);
  while(f.manager.login(cancelled.id).status!=='working')await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,20));f.manager.cancelLogin(cancelled.id);resume();
  assert.equal(await pending,false);assert.equal(f.manager.login(cancelled.id).status,'cancelled');
  assert.deepEqual(revoked(),['Bearer fixture-access-2','Bearer fixture-access-3']);
  assert.equal(f.manager.snapshot()[0].connectionId,committed.connectionId);
  assert.deepEqual([...f.credentials.values.keys()],[committed.connectionId]);
  hold=undefined;team='T-third';await f.login();
  assert.equal(revoked().length,2,'A successful replacement is not revoked');
});

test('reads that ignore cancellation keep their dispatch slot until they settle or the client is recycled',async t=>{
  let active=0,max=0,clients=0,closed=0;const releases:Array<()=>void>=[];
  const factory:ClientFactory=async()=>{clients++;let open=true;return {listTools:async()=>({tools:[read]}),isClosed:()=>!open,close:async()=>{open=false;closed++;},callTool:async()=>{
    active++;max=Math.max(max,active);
    try {await new Promise<void>(resolve=>releases.push(resolve));return {content:[{type:'text',text:'late'}]};}finally{active--;}
  }};};
  const f=await fixture(t,{factory,orphanGraceMs:150});await f.login();const grant=f.manager.snapshot()[0];
  const controllers=[new AbortController(),new AbortController()];
  const stuck=controllers.map(c=>f.manager.call(grant,read.name,{channel_id:'C-example'},c.signal).catch(error=>error));
  while(active<2)await new Promise(r=>setTimeout(r,5));
  controllers[0].abort();assert.match(String(await stuck[0]),/cancelled/);
  const queued=f.manager.call(grant,read.name,{channel_id:'C-example'},new AbortController().signal);
  await new Promise(r=>setTimeout(r,30));assert.equal(active,2,'An orphaned read still occupies its slot');assert.equal(max,2);
  releases.shift()!();
  while(active<2||releases.length<2)await new Promise(r=>setTimeout(r,5));
  assert.equal(max,2);releases.splice(0).forEach(resolve=>resolve());
  assert.match(JSON.stringify(await queued),/late/);await stuck[1];
  const orphan=new AbortController(),blocked=f.manager.call(grant,read.name,{channel_id:'C-example'},orphan.signal).catch(error=>error);
  const other=f.manager.call(grant,read.name,{channel_id:'C-example'},new AbortController().signal).catch(error=>error);
  while(active<2)await new Promise(r=>setTimeout(r,5));
  orphan.abort();await blocked;const before=clients;
  const next=f.manager.call(grant,read.name,{channel_id:'C-example'},new AbortController().signal);
  while(clients===before)await new Promise(r=>setTimeout(r,10));
  assert.ok(closed>=2,'The unresponsive client was recycled');
  while(releases.length<3)await new Promise(r=>setTimeout(r,5));
  releases.splice(0).forEach(resolve=>resolve());
  assert.match(JSON.stringify(await next),/late/);await other;
});

test('an in-flight refresh fenced by a same-account reconnect does not revoke tokens for the live replacement',async t=>{
  class BlockingCredentials extends MemoryCredentials {
    blockId='';blocked?:()=>void;release?:()=>void;
    async set(id:string,tokens:SlackTokens) {if(id===this.blockId){await new Promise<void>(resolve=>{this.release=resolve;this.blocked?.();});}await super.set(id,tokens);}
  }
  const credentials=new BlockingCredentials(),f=await fixture(t,{credentials});await f.login();
  const old=f.manager.snapshot()[0];credentials.values.get(old.connectionId)!.expiresAt=Date.now()-1;
  credentials.blockId=old.connectionId;const blocked=new Promise<void>(resolve=>{credentials.blocked=resolve;});
  const read$=f.manager.call(old,read.name,{channel_id:'C-example'},new AbortController().signal).catch(error=>error);
  await blocked;assert.equal(f.refreshes(),1);
  await f.login();const next=f.manager.snapshot()[0];assert.notEqual(next.connectionId,old.connectionId);
  credentials.release!();assert.match(String(await read$),/cancelled|disconnected/);
  assert.equal(f.requests.filter(r=>r.url.endsWith('auth.revoke')).length,0);
  assert.ok(credentials.values.has(next.connectionId));
  assert.match(JSON.stringify(await f.manager.call(next,read.name,{channel_id:'C-example'},new AbortController().signal)),/Thread page/);
  await f.manager.disconnect();
  assert.equal(f.requests.filter(r=>r.url.endsWith('auth.revoke')).length,1,'Disconnect still revokes');
});

test('shutdown while secure storage finishes a refresh keeps the refreshed credentials for the next start',async t=>{
  class BlockingCredentials extends MemoryCredentials {
    block=false;blocked?:()=>void;release?:()=>void;
    async set(id:string,tokens:SlackTokens) {if(this.block){this.block=false;await new Promise<void>(resolve=>{this.release=resolve;this.blocked?.();});}await super.set(id,tokens);}
  }
  const credentials=new BlockingCredentials(),f=await fixture(t,{credentials});await f.login();
  const grant=f.manager.snapshot()[0];credentials.values.get(grant.connectionId)!.expiresAt=Date.now()-1;
  credentials.block=true;const blocked=new Promise<void>(resolve=>{credentials.blocked=resolve;});
  const pending=f.manager.call(grant,read.name,{channel_id:'C-example'},new AbortController().signal).catch(error=>error);
  await blocked;assert.equal(f.refreshes(),1);
  await f.manager.close();credentials.release!();await pending;
  assert.equal(credentials.values.get(grant.connectionId)?.accessToken,'fixture-access-1');
  const restarted=new ConnectionManager({store:f.store,dataDir:f.dir,credentials,fetcher:async()=>{throw new Error('No network expected');},clientFactory:async token=>({listTools:async()=>({tools:[read]}),callTool:async()=>({content:[{type:'text',text:'Used '+(await token()).replace('fixture-access-','token ')}]}),close:async()=>{}})});
  t.after(()=>restarted.close());
  assert.match(JSON.stringify(await restarted.call(restarted.snapshot()[0],read.name,{channel_id:'C-example'},new AbortController().signal)),/Used token 1/);
});
