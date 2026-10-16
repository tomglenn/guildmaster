// Test-only local transport for the production lead/delegate workers. No network requests.
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input.url ?? input);
  const body = init?.body ? JSON.parse(init.body) : undefined;
  appendFileSync(process.env.GUILDMASTER_TEST_REQUESTS, JSON.stringify({url,body}) + '\n');
  if (url === 'http://127.0.0.1:4173/api/health') return new Response(JSON.stringify({capabilities:{followupQuests:true}}));
  if (url.startsWith('http://127.0.0.1:4173/api/quests/lead/')) {
    if (url.endsWith('/followups')) return new Response(JSON.stringify({quest:{id:'followup',title:body.title,status:'queued'}}),{status:201});
    if (body?.title === 'Denied fixture') return new Response(JSON.stringify({error:'Delegate tools must be a subset of the lead capabilities. Allowed tools: read.'}),{status:403});
    if (url.endsWith('/agents')) return new Response(JSON.stringify({agent:{id:body.title === 'Backend' ? 'backend-agent' : 'frontend-agent',status:'queued'}}));
    if (url.endsWith('/wait')) return new Response(JSON.stringify({waiting:true,agents:[{id:'backend-agent',status:'queued'},{id:'frontend-agent',status:'queued'}]}));
    throw new Error(`Unexpected service request ${url}`);
  }
  if (!url.startsWith('http://fixture.invalid/v1/')) throw new Error(`Unexpected fixture request ${url}`);
  const lastUser = body.messages.findLast(message => message.role === 'user');
  const latest = JSON.stringify(lastUser?.content ?? '');
  let stream='';
  const send = (delta,finish_reason=null) => {
    stream += `data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
  };
  if (latest.includes('FOLLOWUP_DEMO') && body.messages.at(-1)?.role === 'user') {
    send({role:'assistant',tool_calls:[{index:0,id:'create-followup',type:'function',function:{name:'create_followup_quest',arguments:JSON.stringify({title:'Fix blockers',objective:'Fix the concrete blockers in PR 1.',userRequest:'FOLLOWUP_DEMO: Start a quest to fix the blockers.',workspacePolicy:'shared'})}}]});
    send({},'tool_calls');
  } else if (latest.includes('DELEGATION_ERROR') && body.messages.at(-1)?.role === 'user') {
    send({role:'assistant',tool_calls:[{index:0,id:'denied-delegate',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({title:'Denied fixture',objective:'Inspect startup.'})}}]});
    send({},'tool_calls');
  } else if (latest.includes('DELEGATION_DEMO') && !body.messages.some(message => message.role === 'tool')) {
    send({role:'assistant',tool_calls:[
      {index:0,id:'delegate-backend',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({title:'Backend',objective:'Inspect backend contract.',tools:[]})}},
      {index:1,id:'delegate-frontend',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({title:'Frontend',objective:'Inspect frontend usage.',tools:[]})}},
    ]});
    send({},'tool_calls');
  } else if (latest.includes('DELEGATION_DEMO') && !body.messages.some(message => message.role === 'tool' && String(message.content).includes('"waiting":true'))) {
    send({role:'assistant',tool_calls:[{index:0,id:'wait-delegates',type:'function',function:{name:'wait_for_agents',arguments:JSON.stringify({agentIds:['backend-agent','frontend-agent']})}}]});
    send({},'tool_calls');
  } else {
    send({role:'assistant',content:latest.includes('Integrate saved delegate results') ? 'Combined result: both contracts agree.' : 'Assignment complete.'});
    send({},'stop');
  }
  return new Response(stream+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
