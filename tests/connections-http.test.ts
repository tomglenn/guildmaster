import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/service/server.ts';
import type { CredentialStore, SlackTokens } from '../src/connections/types.ts';
import { SLACK_SCOPES } from '../src/connections/slack.ts';
import { connectionTools } from '../src/engine/connection-tools.ts';
import type { WorkerSpec } from '../src/engine/protocol.ts';

const read={name:'slack_read_thread',description:'Read a complete thread with pagination.',inputSchema:{type:'object',properties:{channel_id:{type:'string'},cursor:{type:'string'}},required:['channel_id']}};

test('real MCP client and HTTP service expose read tools to Guildmaster, leads, and delegates without sharing credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'guildmaster-slack-http-'));
  const values=new Map<string,SlackTokens>();
  const credentials:CredentialStore={get:async id=>values.get(id),set:async(id,value)=>{values.set(id,value);},delete:async id=>{values.delete(id);}};
  let remoteReads=0,refreshes=0,denyNext=false;
  const externalRequests:Array<{url:string;method:string;body:any}>=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input instanceof Request?input.url:input),method=init?.method ?? 'GET';
    if(url.endsWith('oauth.v2.user.access')) {
      if(new URLSearchParams(String(init?.body)).get('grant_type')==='refresh_token')refreshes++;
      return Response.json({ok:true,access_token:'fixture-secret-access-'+refreshes,refresh_token:'fixture-secret-refresh-'+refreshes,scope:SLACK_SCOPES.join(','),expires_in:3600});
    }
    if(url.endsWith('auth.test'))return Response.json({ok:true,team_id:'T-example',user_id:'U-example',team:'Example',user:'Reviewer'});
    if(url.endsWith('auth.revoke'))return Response.json({ok:true});
    assert.equal(url,'https://mcp.slack.com/mcp');
    if(method==='GET')return new Response(null,{status:405});
    const body=JSON.parse(String(init?.body));externalRequests.push({url,method,body});
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture-slack',version:'1'}}});
    if(body.method.startsWith('notifications/'))return new Response(null,{status:202});
    if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id:body.id,result:{tools:[read,{...read,name:'slack_send_message'}]}});
    if(body.method==='tools/call') {
      if(denyNext){denyNext=false;return new Response(null,{status:401});}
      remoteReads++;assert.equal(body.params.name,'slack_read_thread');
      return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({messages:[{text:'A decision and action item.',user:'Example',url:'https://example.slack.com/archives/C-example/p1000000000000000'}],next_cursor:body.params.arguments.cursor?'':'next-page'})}]}});
    }
    throw new Error('Unexpected fixture MCP method '+body.method);
  };
  const app=createApp({dataDir:dir,port:0,models:[],workerPath:fileURLToPath(new URL('./fixtures/worker.ts',import.meta.url)),connectionOptions:{credentials,fetcher,clientId:'123.456'}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const {url}=await app.listen();
  const bootstrap=await fetch(url+'/api/bootstrap');const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0];
  const request=async(path:string,body?:unknown,token?:string,method=body?'POST':'GET')=>{
    const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{Cookie:cookie})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  };
  const login=(await request('/api/settings/connections/login',{})).data;
  const state=new URL(login.url).searchParams.get('state')!;
  assert.equal(await app.connections.callback(state,'fixture-code',false),true,JSON.stringify(app.connections.login(login.id)));
  const view=await request('/api/settings/connections');assert.equal(view.status,200);assert.equal(view.data.connection.toolCount,1);
  assert.ok(!JSON.stringify(view).includes('fixture-secret'));
  const gm=(await app.service.guildmaster({message:'[wait] Read a Slack thread.',workspaceMode:'none',commandId:'slack-gm'})).quest;
  const lead=(await app.service.create({objective:'[wait] Investigate Slack context.',workspaceMode:'none',tools:['read'],commandId:'slack-lead'})).quest;
  const delegate=(await app.service.createDelegate(lead.id,{objective:'[wait] Read assigned thread.',commandId:'slack-delegate'})).agent;
  for(const quest of [gm,lead,delegate]) {
    const spec=JSON.parse(await readFile(join(dir,'runs',quest.activeRunId+'.json'),'utf8')) as WorkerSpec;
    assert.ok(!JSON.stringify(spec).includes('fixture-secret'));
    assert.equal(spec.connectionGrants?.[0].tools[0].name,'slack_read_thread');
    const auth=spec.connectionToken!;
    const status=await request('/api/agent/connections',undefined,auth);assert.equal(status.status,200);assert.deepEqual(status.data.availableTools,['slack_read_thread']);
    const tool=connectionTools(spec).find(t=>t.name==='slack_read_thread')!;
    const first=await tool.execute('read-one',{channel_id:'C-example'},new AbortController().signal,()=>{},{} as any);
    assert.match(JSON.stringify(first),/next-page/);
    const second=await tool.execute('read-next',{channel_id:'C-example',cursor:'next-page'},new AbortController().signal,()=>{},{} as any);
    assert.match(JSON.stringify(second),/A decision and action item/);
    assert.equal((await request('/api/settings/connections',undefined,auth)).status,401,'Connection credentials cannot configure settings');
    assert.equal((await request('/api/agent/connections/call',{connectionId:spec.connectionGrants![0].connectionId,tool:'slack_send_message',arguments:{}},auth)).status,403);
    assert.equal((await request('/api/agent/connections/call',{connectionId:'unrelated',tool:'slack_read_thread',arguments:{channel_id:'C-example'}},auth)).status,403);
  }
  denyNext=true;
  const scope=[...app.service.connectionTokens.values()].find(r=>r.questId===gm.id)!;
  await app.connections.call(scope.grants[0],'slack_read_thread',{channel_id:'C-example'},new AbortController().signal);
  assert.equal(refreshes,1,'401 triggers one coordinated refresh and retry');
  assert.equal(remoteReads,7);
  // A delegate cannot obtain connections absent from its parent's run grant.
  app.store.run(lead.activeRunId!,lead.id,{connectionGrants:[]});
  const restricted=(await app.service.createDelegate(lead.id,{objective:'[wait] No external access.',commandId:'restricted'})).agent;
  const restrictedSpec=JSON.parse(await readFile(join(dir,'runs',restricted.activeRunId+'.json'),'utf8')) as WorkerSpec;
  assert.deepEqual(restrictedSpec.connectionGrants,[]);
  const oldSpec=JSON.parse(await readFile(join(dir,'runs',delegate.activeRunId+'.json'),'utf8')) as WorkerSpec;
  await app.service.action(lead.id,'cancel',{commandId:'cancel-slack-lead'});
  assert.equal((await request('/api/agent/connections',undefined,oldSpec.connectionToken)).status,403);
  assert.ok(externalRequests.every(r=>!['slack_send_message','slack_create_canvas'].includes(r.body?.params?.name)));
});
