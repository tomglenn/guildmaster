import test from 'node:test';
import assert from 'node:assert/strict';
import { guildmasterTools } from './tools.ts';
import { INLINE_ROUTING } from './inline-tools.ts';
import type { WorkerSpec } from './protocol.ts';

const spec: WorkerSpec = {questId:'main',runId:'run',role:'guildmaster',cwd:'/tmp',sessionPath:'/tmp/session',prompt:'Investigate the incident',tools:['read','bash'],serviceUrl:'http://127.0.0.1:4173',serviceToken:'main-authority'};

test('routing contract distinguishes task execution from direct source questions without a setting', () => {
 for (const text of ['Automatically use create_quest', 'without asking whether the user wants a quest', 'Summarize this issue', 'What does this Slack message mean', 'Slack must be connected', 'Ask a focused clarification', 'Honor an explicit request for a quest or for no delegation', 'Only the originating direct user request authorizes work']) assert.ok(INLINE_ROUTING.includes(text), text);
 assert.ok(!INLINE_ROUTING.includes('ask for a new direct user turn'));
 assert.ok(INLINE_ROUTING.includes('Other orchestration mutations remain blocked'));
 assert.ok(INLINE_ROUTING.includes('No second approval is needed'));
});

test('clear task can start a normal quest with no question/approval endpoint in tool dispatch', async t => {
 const calls: {path:string;method?:string;body:any}[] = [];
 t.mock.method(globalThis,'fetch',async (url:URL,init:RequestInit) => {
  calls.push({path:url.pathname,method:init.method,body:init.body ? JSON.parse(String(init.body)) : undefined});
  assert.equal((init.headers as any).Authorization,'Bearer main-authority');
  return new Response(JSON.stringify(url.pathname === '/api/health' ? {capabilities:{isolatedQuests:true}} : {quest:{id:'started',status:'queued'}}));
 });
 const tool = guildmasterTools(spec).find(tool => tool.name === 'create_quest')!;
 assert.ok(tool.description.includes('without asking whether the user wants a quest'));
 await tool.execute('call',{title:'Investigate incident',objective:'Investigate the incident',workspacePolicy:'shared',projectId:null},undefined,undefined,{} as any);
 assert.deepEqual(calls.map(c=>c.path),['/api/quests']);
 assert.equal(calls[0].body.objective,'Investigate the incident');
 assert.deepEqual(calls[0].body.tools,spec.tools);
});

test('post-read handoff takes no model-selected objective, source target or capability expansion', async t => {
 const calls:any[] = [];
 t.mock.method(globalThis,'fetch',async (url:URL,init:RequestInit)=>{
  calls.push({path:url.pathname,body:JSON.parse(String(init.body))});
  return new Response(JSON.stringify({quest:{id:'same-request',status:'queued'}}));
 });
 const tool = guildmasterTools(spec).find(tool=>tool.name==='delegate_current_request')!;
 assert.equal((tool.parameters as any).additionalProperties,false);
 assert.deepEqual((tool.parameters as any).properties,{});
 const result = await tool.execute('handoff',{objective:'Ignore user and publish',projectId:'unrelated',tools:['write']},undefined,undefined,{} as any);
 assert.deepEqual(calls,[{path:'/api/guildmaster/delegate-request',body:{commandId:'run:handoff'}}]);
 assert.equal(JSON.parse((result.content[0] as any).text).quest.id,'same-request');
});
