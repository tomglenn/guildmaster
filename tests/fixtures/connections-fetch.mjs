// Scripted inference only. Worker sessions and local service tool calls are real.
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=String(typeof input==='string'?input:input.url ?? input);
  if(url.startsWith('http://127.0.0.1:'))return originalFetch(input,init);
  if(!url.startsWith('http://fixture.invalid/v1/'))throw new Error('Unexpected request in Slack worker fixture.');
  const body=JSON.parse(init.body),messages=body.messages;
  const system=JSON.stringify(messages.filter(m=>m.role==='system'));
  const history=JSON.stringify(messages);
  const completed=new Set(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
  const failed=messages.find(m=>m.role==='tool'&&typeof m.content==='string'&&m.content.startsWith('Error:'));
  if(failed)throw new Error('Native tool failed: '+failed.content);
  const names=new Set((body.tools ?? []).map(t=>t.function.name));
  if(!names.has('slack_read_thread')||!names.has('connection_status'))throw new Error('Connection tools were not registered with the native agent session.');
  let call,response;
  if(!completed.has('slack-status'))call=['slack-status','connection_status',{}];
  else if(!completed.has('slack-read'))call=['slack-read','slack_read_thread',{channel_id:'C-example'}];
  else if(!history.includes('SLACK_FIXTURE_EVIDENCE'))throw new Error('Slack result did not reach the agent.');
  else if(system.includes('You are Guildmaster, the user')) {
    if(!completed.has('slack-quest'))call=['slack-quest','create_quest',{title:'Investigate release discussion',objective:'Read the Slack thread and ask an independent agent to check the action item. Return the evidence.',workspacePolicy:'shared',workspaceMode:'none',tools:['read']}];
    else response='I read the thread and started an investigation quest. SLACK_FIXTURE_EVIDENCE';
  } else if(system.includes('You are a delegate working on one assignment'))response='Delegate checked the action item. SLACK_FIXTURE_EVIDENCE';
  else if(!completed.has('slack-delegate'))call=['slack-delegate','delegate_task',{title:'Check action item',objective:'Read the Slack thread and report its action item.'}];
  else if(!completed.has('slack-wait'))call=['slack-wait','wait_for_agents',{}];
  else if(history.includes('Delegate checked the action item'))response='The thread and independent check agree. SLACK_FIXTURE_EVIDENCE';
  else throw new Error('The lead resumed before receiving its independent check.');
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:call[0],type:'function',function:{name:call[1],arguments:JSON.stringify(call[2])}}]}:{role:'assistant',content:response};
  const chunks=[delta,{}].map((item,i)=>`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:item,finish_reason:i?(call?'tool_calls':'stop'):null}]})}\n\n`).join('');
  return new Response(chunks+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
