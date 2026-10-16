// Only the model transport is simulated. Workspace creation, native sessions, and bash are real.
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const spec=JSON.parse(readFileSync(process.argv[2],'utf8'));
const nativeFetch=globalThis.fetch;
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
globalThis.fetch=async(input,init)=>{
  const url=String(typeof input==='string'?input:input.url??input);
  if(url.startsWith('http://127.0.0.1:'))return nativeFetch(input,init);
  if(!url.startsWith('http://fixture.invalid/'))throw Error('Unexpected network request.');
  const body=JSON.parse(init.body);
  appendFileSync(process.env.GUILDMASTER_TEST_REQUESTS,JSON.stringify(body)+'\n');
  const outputs=body.messages.filter(m=>m.role==='tool');
  const output=id=>outputs.find(m=>m.tool_call_id===id)?.content;
  let call,response;
  if(spec.role==='quest'&&!output('workspace'))call=['workspace',spec.workspacePolicy === 'isolated' ? 'set_repository_revision' : 'create_workspace',{repositoryId:spec.workspaces[0].repositoryId,commit:process.env.GUILDMASTER_TEST_COMMIT}];
  else if(!output('skill')) {
    const prepared=spec.role==='quest'?JSON.parse(output('workspace')):undefined;
    call=['skill','load_skill',{id:prepared?prepared.skills.find(s=>s.path.includes('.cursor')).id:'inspect'}];
  } else if(!output('script')) {
    const bases=[...output('skill').matchAll(/Relative file base: ([^\n]+)/g)];
    const base=bases.find(m=>m[1].includes('.cursor'))?.[1];
    if(!base)throw Error('Isolated skill bundle was not loaded.');
    const cwd=spec.role==='quest'?JSON.parse(output('workspace')).workspace.workspacePath:spec.cwd;
    call=['script','bash',{command:`cd ${quote(cwd)} && node ${quote(join(base,'check.mjs'))}`}];
  } else if(!output('script').includes('SCRIPT_OK'))throw Error('The copied script did not run.');
  else if(spec.role==='delegate') {
    if(body.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('quest lead answered: Use the assigned workspace.')))response='Independent script completed in the assigned workspace.';
    else call=['question','request_user',{question:'Please confirm the workspace for this assignment.'}];
  }
  else if(!output('delegate'))call=['delegate','delegate_task',{title:'Independent inspection',objective:'Use /inspect and run its script in your assigned workspace.'}];
  else if(!output('wait'))call=['wait','wait_for_agents',{}];
  else if(!output('inspect'))call=['inspect','inspect_agent',{agentId:JSON.parse(output('delegate')).agent.id}];
  else if(!output('answer')) {
    const detail=JSON.parse(output('inspect'));
    const pending=detail.requests.find(r=>r.status==='pending');
    if(!pending)throw Error('Expected delegate question routed to lead.');
    call=['answer','answer_agent',{agentId:detail.quest.id,requestId:pending.id,answer:'Use the assigned workspace.'}];
  }
  else if(!output('wait-again'))call=['wait-again','wait_for_agents',{}];
  else response='Both independent workspace checks passed.';
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:call[0],type:'function',function:{name:call[1],arguments:JSON.stringify(call[2])}}]}:{role:'assistant',content:response};
  const chunks=[delta,{}].map((item,index)=>`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:item,finish_reason:index?(call?'tool_calls':'stop'):null}]})}\n\n`).join('');
  return new Response(chunks+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
