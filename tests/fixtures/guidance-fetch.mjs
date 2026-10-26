// Deterministic model responses; local service calls and worker shell tools remain real.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input.url ?? input);
  if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
  if (!url.startsWith('http://fixture.invalid/v1/')) throw new Error('Unexpected external request in guidance test.');
  const body = JSON.parse(init.body);
  appendFileSync(process.env.GUILDMASTER_TEST_REQUESTS, JSON.stringify(body) + '\n');
  const history = JSON.stringify(body.messages);
  const system = body.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  const completed = new Set(body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
  const toolOutputs = body.messages.filter(message => message.role === 'tool');
  let call;
  let response;
  if (system.includes('You are Guildmaster, the user')) {
    if (!completed.has('resolve-project')) call = ['resolve-project', 'resolve_project_repository', {repositoryUrl:'https://github.com/example/review-app/pull/7'}];
    else if (!completed.has('create-review')) {
      const match = JSON.parse(toolOutputs.find(message => message.tool_call_id === 'resolve-project').content).matches[0];
      call = ['create-review', 'create_quest', {title:'Independent PR review', workspacePolicy:'isolated', objective:'Review https://github.com/example/review-app/pull/7 using the repository review workflow. Return a verdict without publishing.',projectId:match.projectId,repositories:[{repositoryId:match.repositoryId}]}];
    } else response = 'Started an independent review quest.';
  } else {
    if (!system.includes('For PR reviews use /review') || !system.includes('load_skill')) throw new Error('Repository guidance did not reach the model.');
    if (!completed.has('load-review')) call = ['load-review', 'load_skill', {id:join(process.env.GUILDMASTER_TEST_REPO,'.claude/skills/review/SKILL.md')}];
    else if (process.env.GUILDMASTER_TEST_SPECIALIST==='1' && !system.includes('You are a delegate working on one assignment')) {
      if (!history.includes('RUN_THE_REVIEW_SCRIPT')) throw new Error('The lead must discover the project skill before delegation.');
      if (!completed.has('delegate-verification')) call = ['delegate-verification','delegate_task',{title:'Review with project skill',modelPreference:'review',objective:'Independently run the repository review script and return its verdict. Use the review skill at .cursor/skills/review/SKILL.md; do not publish.'}];
      else if (!completed.has('wait-verification')) call = ['wait-verification','wait_for_agents',{}];
      else if (history.includes('Independent script check: APPROVE.')) response='APPROVE. The specialist completed the repository review skill. No review was published.';
      else throw new Error('Lead resumed without specialist evidence.');
    } else if (!completed.has('run-script')) {
      if (!history.includes('RUN_THE_REVIEW_SCRIPT')) throw new Error('The canonical skill body was not loaded.');
      const loaded = toolOutputs.find(message=>message.tool_call_id==='load-review').content;
      const base = [...loaded.matchAll(/Relative file base: ([^\n]+)/g)].find(match=>match[1].includes('.cursor'))?.[1];
      if (!base) throw Error('Private skill script path is missing.');
      const script=join(base,'check.mjs');
      call = ['run-script', 'bash', {command:"node '"+script.replaceAll("'","'\\''")+"'"}];
    } else if (!history.includes('SCRIPT_VERDICT: APPROVE')) throw new Error('The review script did not execute successfully.');
    else if (system.includes('You are a delegate working on one assignment')) response = 'Independent script check: APPROVE.';
    else if (!completed.has('delegate-verification')) call = ['delegate-verification', 'delegate_task', {title:'Verify review evidence',objective:'Independently run the repository review script and return its verdict. Use the review skill.'}];
    else if (!completed.has('wait-verification')) call = ['wait-verification', 'wait_for_agents', {}];
    else if (history.includes('Independent script check: APPROVE.')) response = 'APPROVE. The repository workflow and independent script verification both passed. No review was published.';
    else throw new Error('Lead resumed without its delegate evidence.');
  }
  const delta = call ? {role:'assistant',tool_calls:[{index:0,id:call[0],type:'function',function:{name:call[1],arguments:JSON.stringify(call[2])}}]} : {role:'assistant',content:response};
  const chunks = [delta, {}].map((item,index) => `data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:item,finish_reason:index ? (call ? 'tool_calls' : 'stop') : null}]})}\n\n`).join('');
  return new Response(chunks + 'data: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
};
