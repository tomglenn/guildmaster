import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { WorkerEvent, WorkerSpec } from '../src/engine/protocol.ts';

test('production lead saves its wait checkpoint, yields, and integrates results in the same conversation', {timeout:30000}, async t => {
  const root = await mkdtemp(join(tmpdir(),'guildmaster-delegation-worker-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const agentDir=join(root,'engine'); await mkdir(agentDir);
  await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{'local-fixture':{
    baseUrl:'http://fixture.invalid/v1',api:'openai-completions',apiKey:'test-only',
    models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:2048}],
  }}}));
  const requestsPath=join(root,'requests.jsonl'); const sessionPath=join(root,'lead.jsonl');
  async function run(prompt:string, runId:string, role:WorkerSpec['role']='quest') {
    const spec:WorkerSpec={questId:role==='quest'?'lead':'delegate',runId,cwd:root,sessionPath:role==='quest'?sessionPath:join(root,'delegate.jsonl'),agentDir,
      prompt,deliveries:[{id:runId,kind:'prompt',text:prompt}],model:'local-fixture/fixture',tools:[],role,
      ...(role==='quest'?{serviceUrl:'http://127.0.0.1:4173',serviceToken:'test-lead-token'}:{parentQuestId:'lead'}),
    };
    const path=join(root,runId+'.json');await writeFile(path,JSON.stringify(spec));
    const child=fork(resolve('src/worker.ts'),[path],{execArgv:['--experimental-strip-types','--import',resolve('tests/fixtures/delegation-fetch.mjs')],env:{...process.env,GUILDMASTER_TEST_REQUESTS:requestsPath},silent:true});
    const events:WorkerEvent[]=[];let stderr='';child.on('message',(event:WorkerEvent)=>events.push(event));child.stderr?.on('data',data=>{stderr+=data;});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
    const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);
    assert.equal(code,0,JSON.stringify({events,stderr}));return events;
  }
  const first=await run('DELEGATION_DEMO: inspect both repositories independently.','first');
  assert.ok(first.some(event=>event.type==='yielded'),JSON.stringify(first));
  assert.ok(!first.some(event=>event.type==='complete'));
  assert.ok(first.some(event=>event.type==='delivered'&&event.ids.includes('first')));
  const native=SessionManager.open(sessionPath,undefined,root);
  assert.ok(native.getEntries().some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='wait_for_agents'&&!entry.message.isError));
  const firstSession=native.getSessionId();
  const second=await run('Integrate saved delegate results: backend and frontend both use cedar-17.','second');
  assert.ok(second.some(event=>event.type==='complete'&&event.text.includes('both contracts agree')));
  assert.equal(SessionManager.open(sessionPath,undefined,root).getSessionId(),firstSession);
  await run('Inspect only the backend contract.','child','delegate');
  const requests=(await readFile(requestsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const services=requests.filter(request=>request.url.includes('/api/quests/'));
  assert.equal(services.length,3);
  assert.deepEqual(services.map(request=>request.body.commandId),['first:delegate-backend','first:delegate-frontend','first:wait-delegates']);
  const modelRequests=requests.filter(request=>request.url.includes('/v1/'));
  const tools=modelRequests.at(-1).body.tools.map((tool:any)=>tool.function.name);
  assert.deepEqual(tools,['request_user'],'Delegates must not receive delegation or Guildmaster tools.');
  assert.match(JSON.stringify(modelRequests.find(request=>JSON.stringify(request.body.messages).includes('Integrate saved delegate results')).body.messages),/wait_for_agents/);
  const leadModel=modelRequests.find(request=>request.body.tools?.some((tool:any)=>tool.function.name==='create_followup_quest'));
  assert.ok(leadModel,'Production leads receive the follow-up creation tool.');
  assert.match(JSON.stringify(leadModel.body.messages),/only when the user explicitly asks/);
  assert.ok(!leadModel.body.tools.some((tool:any)=>tool.function.name==='create_quest'));
  const followup=await run('FOLLOWUP_DEMO: Start a quest to fix the blockers.','followup-run');
  assert.ok(followup.some(event=>event.type==='tool_end'&&event.tool==='create_followup_quest'&&!event.isError));
  const followupCalls=(await readFile(requestsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(request=>request.url.endsWith('/followups'));
  assert.equal(followupCalls.length,1);
  assert.equal(followupCalls[0].body.commandId,'followup-run:create-followup');
  const rejected=await run('DELEGATION_ERROR: expose the service rejection in activity.','error-report');
  assert.ok(rejected.some(event=>event.type==='activity'&&event.tool==='delegate_task'&&/Tool error:.*403.*Allowed tools: read/.test(event.detail)),JSON.stringify(rejected));
});
