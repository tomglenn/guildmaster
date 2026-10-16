import test from 'node:test';
import assert from 'node:assert/strict';
import { delegationTools } from './delegation-tools.ts';
import type { WorkerSpec } from './protocol.ts';

const spec: WorkerSpec = { questId:'parent/one', runId:'run-one', role:'quest', cwd:'/tmp', sessionPath:'/tmp/session.jsonl', prompt:'Build it', tools:['read'], serviceUrl:'http://127.0.0.1:4173', serviceToken:'scoped-token' };

test('delegate tool schema exposes exact lower-case capability IDs available to its lead', () => {
  const allowed = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'];
  const schema = delegationTools({ ...spec, tools: allowed }, () => {}).find(tool => tool.name === 'delegate_task')!.parameters as any;
  assert.deepEqual(schema.properties.tools.items.enum, allowed);
  assert.ok(!schema.properties.tools.items.enum.some((name: string) => ['Read', 'Grep', 'Bash'].includes(name)));

  const readOnly = ['read', 'grep', 'find', 'ls'];
  const restrictedSchema = delegationTools({ ...spec, tools: readOnly }, () => {}).find(tool => tool.name === 'delegate_task')!.parameters as any;
  assert.deepEqual(restrictedSchema.properties.tools.items.enum, readOnly);
  assert.ok(!restrictedSchema.properties.tools.items.enum.includes('write'));
  assert.ok(!restrictedSchema.properties.tools.items.enum.includes('bash'));
});

test('delegation tools scope every request to the lead and preserve assignment details and retry identity', async t => {
  const requests: {url:string;method:string;body:any;token:string}[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    requests.push({url:String(url),method:init.method!,body:init.body ? JSON.parse(String(init.body)) : undefined,token:(init.headers as Record<string,string>).Authorization});
    return new Response(JSON.stringify({agent:{id:'delegate/1'},agents:[],waiting:false}));
  });
  const tools = delegationTools(spec, () => assert.fail('Completed waits must not yield.'));
  const call = (name:string,id:string,args:any) => tools.find(tool => tool.name === name)!.execute(id,args,undefined,undefined,{} as any);
  const assignment = {title:'API contract',objective:'Check the exact cedar-17 contract. Do not edit.',repositoryIds:['backend'],tools:['read','grep']};
  await call('delegate_task','assign',assignment);
  await call('delegate_task','assign',assignment);
  assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[0].url,'http://127.0.0.1:4173/api/quests/parent%2Fone/agents');
  assert.deepEqual(requests[0].body,{...assignment,commandId:'run-one:assign'});
  assert.equal(requests[0].token,'Bearer scoped-token');
  await call('continue_agent','follow',{agentId:'delegate/1',message:'Now check the response schema.'});
  assert.match(requests[2].url,/agents\/delegate%2F1\/continue$/);
  assert.deepEqual(requests[2].body,{message:'Now check the response schema.',commandId:'run-one:follow'});
  await call('inspect_agent','inspect',{agentId:'delegate/1'});
  assert.equal(requests[3].method,'GET');
  await call('list_agents','list',{});
  await call('wait_for_agents','wait',{agentIds:['delegate/1']});
  assert.deepEqual(requests[5].body,{agentIds:['delegate/1'],commandId:'run-one:wait'});
});

test('only a successful pending wait requests a worker yield; failures remain visible', async t => {
  let waiting = true; let status = 200;
  t.mock.method(globalThis,'fetch',async () => new Response(JSON.stringify(status === 200 ? {waiting} : {error:'Assignment belongs to another quest.'}),{status}));
  const yielded:string[] = [];
  const wait = delegationTools(spec,id => yielded.push(id)).find(tool => tool.name === 'wait_for_agents')!;
  await wait.execute('wait',{},undefined,undefined,{} as any);
  assert.deepEqual(yielded,['wait']);
  waiting = false;
  await wait.execute('done',{},undefined,undefined,{} as any);
  assert.deepEqual(yielded,['wait']);
  status=403;
  await assert.rejects(wait.execute('forbidden',{},undefined,undefined,{} as any),/403.*another quest/);
  assert.deepEqual(yielded,['wait']);
  assert.deepEqual(delegationTools({...spec,role:'delegate'},()=>{}),[]);
  assert.deepEqual(delegationTools({...spec,role:'guildmaster'},()=>{}),[]);
  assert.throws(()=>delegationTools({...spec,serviceUrl:'https://remote.invalid'},()=>{}),/local HTTP/);
});
