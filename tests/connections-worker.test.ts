import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/service/server.ts';
import type { SlackTokens } from '../src/connections/types.ts';
import { SLACK_SCOPES } from '../src/connections/slack.ts';

test('native Guildmaster, quest lead, and resumed delegate sessions use service-owned Slack tools', {timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'guildmaster-slack-workers-')),dataDir=join(root,'data'),engine=join(dataDir,'engine');
  await mkdir(engine,{recursive:true});
  await writeFile(join(engine,'models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:'http://fixture.invalid/v1',api:'openai-completions',apiKey:'test-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:2048}]}}}));
  const workerPath=join(root,'worker.mjs');
  await writeFile(workerPath,`await import(${JSON.stringify(pathToFileURL(resolve('tests/fixtures/connections-fetch.mjs')).href)});\nawait import(${JSON.stringify(pathToFileURL(resolve('src/worker.ts')).href)});\n`);
  const credentials=new Map<string,SlackTokens>();let reads=0;
  const app=createApp({dataDir,port:0,workerPath,connectionOptions:{clientId:'123.456',credentials:{get:async id=>credentials.get(id),set:async(id,value)=>{credentials.set(id,value);},delete:async id=>{credentials.delete(id);}},fetcher:async(input)=>String(input).endsWith('auth.test')?Response.json({ok:true,team_id:'T-example',user_id:'U-example'}):Response.json({ok:true,access_token:'fixture-worker-secret',scope:SLACK_SCOPES.join(',')}),clientFactory:async()=>({listTools:async()=>({tools:[{name:'slack_read_thread',description:'Read a Slack thread.',inputSchema:{type:'object',properties:{channel_id:{type:'string'}},required:['channel_id']}}]}),callTool:async()=>{reads++;return {content:[{type:'text',text:'SLACK_FIXTURE_EVIDENCE: The owner will publish the release notes tomorrow. https://example.slack.com/archives/C-example/p1000000000000000'}]};},close:async()=>{}})}});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  await app.listen();app.service.modelDefaults.initialize('local-fixture/fixture');const login=await app.connections.startLogin();assert.equal(await app.connections.callback(new URL(login.url!).searchParams.get('state'),'fixture-code',false),true);
  const gm=(await app.service.guildmaster({message:'Read this release discussion and investigate its action item.',workspaceMode:'none',model:'local-fixture/fixture',commandId:'slack-workers'})).quest;
  for(let attempt=0;attempt<500;attempt++) {
    const quests=app.store.list();const failed=quests.find(q=>['failed','interrupted','awaiting_input'].includes(q.status));assert.ok(!failed,JSON.stringify(failed));
    if(quests.some(q=>q.kind==='quest'&&q.status==='awaiting_review')&&!app.service.live.size)break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  const quest=app.store.list().find(q=>q.kind==='quest');assert.equal(quest?.status,'awaiting_review',JSON.stringify(app.store.list()));
  const delegate=app.service.agents(quest!.id)[0];assert.equal(delegate?.status,'completed');assert.ok(reads>=3);
  for(const q of [app.service.get(gm.id),quest!,delegate]) {
    assert.match(q.result!,/SLACK_FIXTURE_EVIDENCE/);
    assert.ok(app.store.toolCalls(q.id).some(call=>call.tool==='slack_read_thread'&&call.status==='completed'));
    assert.ok(!JSON.stringify(app.store.toolCalls(q.id)).includes('SLACK_FIXTURE_EVIDENCE'),'Full Slack responses are not duplicated into tool activity storage');
    const session=await readFile(q.sessionPath,'utf8');assert.ok(!session.includes('fixture-worker-secret'));
  }
  assert.equal(quest!.runCount,2,'Lead resumes after the delegate completes');
});
