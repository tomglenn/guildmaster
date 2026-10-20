import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptItems, latestResultMessage, visibleLive, conversationProgress, visibleActivity, type ToolCall } from '../src/web/transcript-data.ts';

test('streaming is deduplicated by message identity, not by text prefixes, and fenced to active runs', () => {
  const messages = [{ id: 'saved', role: 'assistant' as const, text: 'Same wording', createdAt: 1 }];
  const stream = { runId: 'r', messageId: 'new', text: 'Same wording' };
  assert.equal(visibleLive(messages, stream, 'running', 'r'), stream);
  assert.equal(visibleLive(messages, { ...stream, messageId: 'saved' }, 'running', 'r'), null);
  assert.equal(visibleLive(messages, stream, 'running', 'another-run'), null);
  assert.equal(visibleLive(messages, stream, 'completed'), null);
  assert.equal(visibleLive(messages, null, 'running'), null);
});

test('questions appear once by identity in chronological conversation history', () => {
  const question = { id: 'run:ask', question: 'Which branch?', status: 'pending' as const, createdAt: 2 };
  const items = transcriptItems([{id:'user',role:'user',text:'Review this',createdAt:1}], [question,question]);
  assert.deepEqual(items.map(message => message.id), ['user', 'question:run:ask']);
});

test('answers use their saved message identity, preserving identical answers and legacy history', () => {
  const messages = [
    { id: 'a1', role: 'user' as const, text: 'Recovered answer prompt with extra context', createdAt: 3 },
    { id: 'a2', role: 'user' as const, text: 'Blue', createdAt: 6 },
    { id: 'legacy', role: 'user' as const, text: 'Existing history', createdAt: 8 },
  ];
  const requests = [
    { id: 'q1', question: 'Which color?', status: 'answered' as const, answer: 'Blue', answerMessageId: 'a1', createdAt: 2 },
    { id: 'q2', question: 'Which color?', status: 'answered' as const, answer: 'Blue', answerMessageId: 'a2', createdAt: 5 },
    { id: 'old', question: 'Old question?', status: 'answered' as const, answer: 'Existing history', createdAt: 7 },
  ];
  const items = transcriptItems(messages, requests);
  assert.deepEqual(items.map(message => message.id), ['question:q1','a1','question:q2','a2','question:old','legacy']);
  assert.deepEqual(items.filter(message => message.answerFor).map(message => [message.text, message.answerFor]), [['Blue','q1'],['Blue','q2']]);
  assert.equal(items.at(-1)?.text, 'Existing history');
  assert.equal(items.at(-1)?.answerFor, undefined);
});


test('progress describes active tools and never reuses old runs or completed work', () => {
  const call: ToolCall = {id:'t',runId:'current',tool:'read',detail:'private/path',status:'running',startedAt:10};
  assert.equal(conversationProgress('running', [call], [], 'current'), 'Reading files…');
  assert.equal(conversationProgress('running', [call], [], 'next'), 'Thinking…');
  assert.equal(conversationProgress('running', [{...call,status:'completed',endedAt:20}], [
    {type:'run_started',detail:'',createdAt:1},{type:'model',detail:'Model is thinking.',createdAt:2},
  ], 'current'), 'Thinking…');
  assert.equal(conversationProgress('running', [], [
    {type:'run_started',detail:'',createdAt:1},{type:'model',detail:'Model is thinking.',createdAt:2},
    {type:'run_started',detail:'',createdAt:3},
  ], 'next'), 'Thinking…');
  for (const status of ['awaiting_input','awaiting_review','completed','failed','interrupted','accepted','cancelled']) {
    assert.equal(conversationProgress(status,[call],[],'current'), null);
  }
  assert.equal(conversationProgress('waiting',[call],[],'current'), 'Waiting for agents…');
});

test('model progress is succinct and excludes raw error or reasoning text', () => {
  const events = [{type:'run_started',detail:'',createdAt:1}];
  assert.equal(conversationProgress('running',[],[...events,{type:'model',detail:'Model is thinking.',createdAt:2}],'r'), 'Thinking…');
  assert.equal(conversationProgress('running',[],[...events,{type:'model',detail:'Model retry 1/3 in 2 seconds. Long provider error',createdAt:2}],'r'), 'Retrying model request…');
});


test('internal coordination stays out of conversation while human copies remain visible', () => {
  const raw = 'Your delegated work has returned. Internal report JSON';
  const items = transcriptItems([
    { id:'internal', role:'user', source:'system', text:raw, createdAt:1 },
    { id:'human', role:'user', source:'user', text:raw, createdAt:2 },
    { id:'assignment', role:'user', source:'guildmaster', text:'Full runtime prompt with original context', displayText:'Investigate startup', createdAt:3 },
    { id:'legacy', role:'user', text:'Unclassified historical message', createdAt:4 },
  ]);
  assert.deepEqual(items.map(message => message.id), ['human','assignment','legacy']);
  assert.equal(items[0].text,raw);
  assert.equal(items[1].text,'Investigate startup');
  assert.equal(items[1].source,'guildmaster');
});


test('activity omits transient model states but retains retries, errors, and tool details', () => {
  const events = [
    {type:'model',detail:'Waiting for model response.'},
    {type:'model',detail:'Model is thinking.'},
    {type:'model',detail:'Model retry 1/3 in 2 seconds. Connection failed.'},
    {type:'failed',detail:'Model request timed out.'},
    {type:'bash',detail:'Model is thinking.'},
    {type:'result',detail:'Result ready for review.'},
  ];
  assert.deepEqual(visibleActivity(events), events.slice(2));
  assert.equal(events.length,6);
});

test('result navigation targets the saved outcome instead of subsequent follow-up commentary', () => {
  const messages = [
    {id: 'first', role: 'assistant' as const, text: 'Report', createdAt: 1},
    {id: 'latest', role: 'assistant' as const, text: 'Report', createdAt: 2},
    {id: 'feedback', role: 'user' as const, text: 'Report', createdAt: 3},
    {id: 'commentary', role: 'assistant' as const, text: 'Checking your feedback…', createdAt: 4},
  ];
  assert.equal(latestResultMessage(messages, 'Report')?.id, 'latest');
  assert.equal(latestResultMessage(messages, undefined), undefined);
  assert.equal(latestResultMessage(messages, 'Missing result'), undefined);
});

test('conversation explains why a quest is queued', () => {
  assert.equal(conversationProgress('queued',[],[],undefined,'Waiting for workspace'),'Waiting for workspace…');
  assert.equal(conversationProgress('queued',[],[],undefined,'Waiting for an available worker'),'Waiting for an available worker…');
});

test('conversation activity interleaves confirmed delegation and tool evidence with saved messages', async () => {
  const { conversationEntries } = await import('../src/web/transcript-data.ts');
  const calls: ToolCall[] = [
    { id:'read', runId:'r', tool:'read', detail:'src/example.ts', status:'completed', startedAt:3 },
    { id:'test', runId:'r', tool:'bash', detail:'npm test', status:'running', startedAt:4 },
    { id:'later', runId:'r2', tool:'read', detail:'README.md', status:'completed', startedAt:7 },
  ];
  const agents = [{id:'agent',title:'Review boundaries',status:'running',createdAt:2}];
  const entries = conversationEntries([
    {id:'start',role:'assistant',text:'Splitting the investigation.',createdAt:1},
    {id:'report',role:'assistant',text:'Findings.',createdAt:6},
  ], [...calls,calls[0]], [...agents,...agents]);
  assert.deepEqual(entries.map(entry=>entry.kind), ['message','delegation','tools','message','tools']);
  assert.equal(entries[1].kind==='delegation' && entries[1].agent.id,'agent');
  assert.deepEqual(entries[2].kind==='tools' && entries[2].calls.map(call=>call.id),['read','test']);
  assert.equal(conversationEntries([],[],[]).length,0);
});

test('compact activity bounds history, keeps active calls visible, and exposes everything on expansion', async () => {
  const { compactToolCalls, toolPresentation } = await import('../src/web/transcript-data.ts');
  const calls: ToolCall[] = Array.from({length:80},(_,i)=>({id:String(i),runId:'r',tool:'read',detail:'file',status:i===0?'running':'completed',startedAt:i}));
  assert.deepEqual(compactToolCalls(calls).calls.map(call=>call.id),['0','77','78','79']);
  assert.equal(compactToolCalls(calls).hidden,76);
  assert.deepEqual(compactToolCalls(calls,true),{calls,hidden:0});
  assert.equal(compactToolCalls([]).hidden,0);
  assert.deepEqual(toolPresentation('bash'),{label:'Run',icon:'terminal'});
  assert.deepEqual(toolPresentation('custom_read_tool'),{label:'Custom read tool',icon:'activity'});
});

test('visible agent indicators replace duplicate waiting progress without hiding lead work', () => {
  for (const status of ['running','queued']) {
    const agents = [{status}];
    assert.equal(conversationProgress('waiting',[],[],'r',undefined,agents),null);
    const wait: ToolCall = {id:'wait',runId:'r',tool:'wait_for_agents',detail:'',status:'running',startedAt:1};
    assert.equal(conversationProgress('running',[wait],[],'r',undefined,agents),null);
    assert.equal(conversationProgress('running',[{...wait,tool:'read'}],[],'r',undefined,agents),'Reading files…');
  }
  assert.equal(conversationProgress('waiting',[],[],'r',undefined,[]),'Waiting for agents…');
  assert.equal(conversationProgress('waiting',[],[],'r',undefined,[{status:'completed'}]),'Waiting for agents…');
});

test('successful follow-ups create renewed handoffs in the current turn and retain agent identity', async () => {
  const { delegationEntries } = await import('../src/web/transcript-data.ts');
  const agent={id:'saved-agent',title:'Repository investigator',status:'running',createdAt:1};
  const call:ToolCall={id:'r:again',runId:'r',tool:'continue_agent',detail:agent.id,status:'completed',startedAt:10,endedAt:12};
  const entries=delegationEntries([agent],[call,{...call,id:'failed',status:'failed'},{...call,id:'pending',status:'running'}]);
  assert.equal(entries.length,2);
  assert.equal(entries[0].status,'previous','earlier handoffs must not spin again');
  assert.deepEqual(entries[1],{...agent,id:call.id,agentId:agent.id,followup:true,createdAt:12});
  const again=delegationEntries([agent],[call,{...call,id:'next',startedAt:30,endedAt:31}]);
  assert.deepEqual(again.map(entry=>entry.status),['previous','previous','running']);
  assert.deepEqual(again.map(entry=>entry.agentId),[agent.id,agent.id,agent.id]);
  assert.equal(delegationEntries([{...agent,status:'completed'}],[call])[1].status,'completed');
});

test('direct tool transitions survive stale snapshots and respect newer cancellation state', async () => {
  const { mergeToolCalls } = await import('../src/web/transcript-data.ts');
  const running:ToolCall={id:'call',runId:'r',tool:'read',detail:'file.ts',status:'running',startedAt:1};
  const completed:ToolCall={...running,status:'completed',endedAt:3,output:'Read complete'};
  assert.deepEqual(mergeToolCalls([running],[completed]),[completed]);
  assert.deepEqual(mergeToolCalls([completed],[running]),[completed]);
  const interrupted:ToolCall={...running,status:'interrupted',endedAt:5};
  assert.deepEqual(mergeToolCalls([interrupted],[completed]),[interrupted]);
  assert.equal(mergeToolCalls([], [running,completed,running]).length,1);
  assert.deepEqual(mergeToolCalls([], [completed,running]),[completed]);
});

test('handoff preparation stays visible until running assignments take over the waiting signal', () => {
  const call:ToolCall={id:'handoff',runId:'r',tool:'delegate_task',detail:'Inspect the repository',status:'running',startedAt:1};
  for(const tool of ['delegate_task','continue_agent']) {
    assert.equal(conversationProgress('running',[{...call,tool}],[],'r',undefined,[{status:'running'}]),'Delegating work…');
  }
  assert.equal(conversationProgress('waiting',[],[],'r',undefined,[{status:'running'}]),null);
  assert.equal(conversationProgress('waiting',[],[],'r',undefined,[]),'Waiting for agents…');
});
