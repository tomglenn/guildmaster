import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { DeliveryInstruction, WorkerEvent, WorkerSpec } from '../src/engine/protocol.ts';

// This is a protocol fixture, not an inference-quality test. The production worker,
// Pi tools, native session serialization, subprocesses and resume are all real.
test('Pi worker persists a native conversation, resumes it, and waits for user input', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guildmaster-worker-test-'));
  const agentDir = join(directory, 'pi');
  await mkdir(agentDir);
  const requestPath = join(directory, 'requests.jsonl');
  const modelConfig = JSON.stringify({ providers: {
    'local-fixture': { baseUrl: 'http://fixture.invalid/v1', api: 'openai-completions', apiKey: 'test-only',
      models: [{ id: 'fixture', name: 'Local protocol fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048 }, { id:'alternate',name:'Alternate fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:2048 }] },
  } });
  await writeFile(join(agentDir, 'models.json'), modelConfig);
  const sessionPath = join(directory, 'session.jsonl');
  const run = async (prompt: string, runId: string, answer?: string, deliveries?: DeliveryInstruction[], exitBeforeResponse = false, questBoard?: WorkerSpec['questBoard'], model = 'local-fixture/fixture') => {
    const spec: WorkerSpec = { ...(prompt === 'STALL_MODEL_REQUEST' ? {modelIdleTimeoutMs:50} : {}), questId: 'test', runId, cwd: directory, prompt, sessionPath,
      deliveries: deliveries ?? [{ id: `delivery-${runId}`, kind: 'prompt', text: prompt }],
      model, tools: [], role: questBoard ? 'guildmaster' : 'quest', questBoard,
      ...(questBoard ? { serviceUrl:'http://127.0.0.1:4173',serviceToken:'fixture-only' } : {}),
      project: { id: 'alpha', name: 'Alpha', instructions: 'Use the cedar-17 API contract.' },
      workspaces: [
        {repositoryId:'web',name:'Web',sourcePath:'/source/web',workspacePath:directory,mode:'worktree',branch:'quest/alpha'},
        {repositoryId:'api',name:'API',sourcePath:'/source/api',workspacePath:'/saved/api-checkout',mode:'existing'},
      ],
    };
    if (prompt === 'STALL_MODEL_REQUEST') spec.sessionPath = join(directory, 'stalled-session.jsonl');
    const specPath = join(directory, `${runId}.json`);
    await writeFile(specPath, JSON.stringify(spec));
    const child = fork(resolve('src/worker.ts'), [specPath], {
      execArgv: ['--experimental-strip-types', '--import', resolve('tests/fixtures/model-fetch.mjs')],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, GUILDMASTER_TEST_REQUESTS: requestPath, GUILDMASTER_TEST_EXIT_BEFORE_RESPONSE: exitBeforeResponse ? '1' : '' }, silent: true,
    });
    const events: WorkerEvent[] = [];
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('message', (event: WorkerEvent) => {
      events.push(event);
      if (event.type === 'question') {
        if (answer) child.send({ type: 'answer', id: event.id, answer,
          delivery: { id: `answer-${runId}`, kind: 'answer', text: `The saved answer is: ${answer}`, answer, toolCallId: event.id } });
        else child.send({ type: 'cancel' });
      }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    clearTimeout(timer);
    return { events, code, stderr };
  };
  try {
    const originalRequest = 'Remember copper-otter. Exact additional constraint: preserve cedar-17.';
    const first = await run(originalRequest, 'first');
    assert.equal(first.code, 0, JSON.stringify(first));
    const context = first.events.findLast(event => event.type === 'context');
    assert.ok(context?.type === 'context');
    assert.equal(context.contextWindow, 32000);
    assert.equal(context.model, 'local-fixture/fixture');
    assert.ok(context.tokens === null || context.tokens >= 0);
    assert.ok(context.percent === null || Number.isFinite(context.percent));
    const firstStart = first.events.find(event => event.type === 'message_start');
    const firstDelta = first.events.find(event => event.type === 'delta');
    const firstMessage = first.events.find(event => event.type === 'message');
    assert.ok(firstStart?.type === 'message_start' && firstDelta?.type === 'delta' && firstMessage?.type === 'message');
    assert.equal(firstStart.messageId, firstDelta.messageId);
    assert.equal(firstStart.messageId, firstMessage.messageId);
    assert.ok(firstDelta.text.length > 0);
    assert.ok(first.events.indexOf(firstDelta) < first.events.indexOf(firstMessage));

    assert.ok(first.events.some(event => event.type === 'delivered' && event.ids.includes('delivery-first')));
    assert.ok(first.events.findIndex(event => event.type === 'delivered') < first.events.findIndex(event => event.type === 'complete'));
    const second = await run('What was the phrase?', 'second');
    assert.equal(second.code, 0, JSON.stringify(second));
    const firstSession = first.events.find((event) => event.type === 'session');
    const secondSession = second.events.find((event) => event.type === 'session');
    assert.ok(firstSession?.type === 'session' && secondSession?.type === 'session');
    assert.equal(firstSession.sessionId, secondSession.sessionId);
    const requests = (await readFile(requestPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(requests[1].messages.some((message: any) => message.role === 'user' &&
      (typeof message.content === 'string' ? message.content : message.content?.map((part: any) => part.text ?? '').join('')) === originalRequest),
      'The follow-up must retain the exact original request, including details absent from the assistant reply.');
    assert.ok(requests[1].messages.some((message: any) => message.role === 'assistant' && message.content?.includes('Remembered copper-otter.')));
    assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name), ['request_user']);
    for (const request of requests.slice(0, 2)) {
      const systemContext = JSON.stringify(request.messages.filter((message:any) => message.role === 'system' || message.role === 'developer'));
      assert.ok(systemContext.includes('Use the cedar-17 API contract.'));
      assert.ok(systemContext.includes(directory));
      assert.ok(systemContext.includes('/saved/api-checkout'));
      assert.ok(systemContext.includes('quest/alpha'));
    }

    const question = await run('ASK_REQUIRED', 'question', 'Blue');
    assert.equal(question.code, 0, JSON.stringify(question));
    assert.ok(question.events.some((event) => event.type === 'question' && event.question === 'Which colour?'));
    assert.ok(question.events.some((event) => event.type === 'complete' && event.text.includes('Blue')));
    const toolStart = question.events.find(event => event.type === 'tool_start');
    const toolEnd = question.events.find(event => event.type === 'tool_end');
    assert.ok(toolStart?.type === 'tool_start' && toolEnd?.type === 'tool_end');
    assert.equal(toolStart.tool, 'request_user');
    assert.equal(toolStart.detail, 'Which colour?');
    assert.equal(toolStart.toolCallId, toolEnd.toolCallId);
    assert.equal(toolEnd.isError, false);
    assert.match(toolEnd.output, /Blue/);
    assert.ok(question.events.indexOf(toolStart) < question.events.indexOf(toolEnd));

    const answerReceipt = question.events.findIndex(event => event.type === 'delivered' && event.ids.includes('answer-question'));
    assert.ok(answerReceipt >= 0 && answerReceipt < question.events.findIndex(event => event.type === 'complete'));
    const transcript = await readFile(sessionPath, 'utf8');
    assert.match(transcript, /copper-otter/);
    assert.match(transcript, /toolResult/);
    assert.match(transcript, /Blue/);

    const cancellation = await run('ASK_REQUIRED', 'cancel');
    assert.equal(cancellation.code, 1, JSON.stringify(cancellation));
    assert.ok(cancellation.events.some((event) => event.type === 'error'));
    assert.ok(!cancellation.events.some((event) => event.type === 'complete'));
    const recoveredAnswer: DeliveryInstruction = { id: 'answer-after-exit', kind: 'answer', text: 'The saved question was: Which colour? The user answered: Green.', answer: 'Green', toolCallId: 'question-fixture' };
    const recoveryPrompt: DeliveryInstruction = { id: 'recovery-prompt', kind: 'prompt', text: 'Continue using the saved answer and inspect previous effects.' };
    const recovered = await run(recoveryPrompt.text, 'recovery', undefined, [recoveredAnswer, recoveryPrompt]);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    assert.ok(recovered.events.some(event => event.type === 'delivered' && event.ids.includes(recoveredAnswer.id) && event.ids.includes(recoveryPrompt.id)));
    const finalRequests = (await readFile(requestPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(JSON.stringify(finalRequests.at(-1).messages).includes(recoveredAnswer.text));

    const authPrompt: DeliveryInstruction = { id: 'failed-auth-delivery', kind: 'prompt', text: 'Preserve the exact phrase: violet fog.' };
    const noAuth = JSON.parse(modelConfig); delete noAuth.providers['local-fixture'].apiKey;
    await writeFile(join(agentDir, 'models.json'), JSON.stringify(noAuth));
    const failedAuth = await run(authPrompt.text, 'failed-auth', undefined, [authPrompt]);
    assert.equal(failedAuth.code, 1, JSON.stringify(failedAuth));
    assert.ok(!failedAuth.events.some(event => event.type === 'delivered' && event.ids.includes(authPrompt.id)));
    await writeFile(join(agentDir, 'models.json'), modelConfig);
    const retriedAuth = await run(authPrompt.text, 'retried-auth', undefined, [authPrompt]);
    assert.equal(retriedAuth.code, 0, JSON.stringify(retriedAuth));
    assert.ok(retriedAuth.events.some(event => event.type === 'delivered' && event.ids.includes(authPrompt.id)));

    const crashPrompt: DeliveryInstruction = { id: 'saved-before-ack', kind: 'prompt', text: 'Keep the exact phrase: granite swan.' };
    const crashed = await run(crashPrompt.text, 'crash-before-ack', undefined, [crashPrompt], true);
    assert.equal(crashed.code, 86, JSON.stringify(crashed));
    assert.ok(!crashed.events.some(event => event.type === 'delivered' && event.ids.includes(crashPrompt.id)));
    const crashRecovery = await run(crashPrompt.text, 'recover-lost-ack', undefined, [crashPrompt]);
    assert.equal(crashRecovery.code, 0, JSON.stringify(crashRecovery));
    assert.ok(crashRecovery.events.some(event => event.type === 'delivered' && event.ids.includes(crashPrompt.id)));
    const saved = SessionManager.open(sessionPath, undefined, directory).getEntries();
    for (const instruction of [authPrompt, crashPrompt]) {
      const occurrences = saved.filter(entry => entry.type === 'message' && entry.message.role === 'user' &&
        (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map(part => part.type === 'text' ? part.text : '').join('')) === instruction.text);
      assert.equal(occurrences.length, 1, `Expected one native user message for ${instruction.id}`);
    }
    const board: NonNullable<WorkerSpec['questBoard']> = { capturedAt: 12345, omitted: 0, quests:[{id:'old-quest',title:'Earlier investigation',status:'accepted',archivedAt:12300}] };
    const gm = await run('Run a fresh investigation.', 'gm-fresh-board', undefined, undefined, false, board);
    assert.equal(gm.code, 0, JSON.stringify(gm));
    const gmRequest = (await readFile(requestPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1);
    const gmSystem = JSON.stringify(gmRequest.messages.filter((message:any) => message.role === 'system' || message.role === 'developer'));
    assert.ok(gmSystem.includes('old-quest') && gmSystem.includes('accepted') && gmSystem.includes('archivedAt'));
    assert.match(gmSystem,/call list_quests or inspect_quest in this turn/);
    assert.match(gmSystem,/create a new quest using the current request/);
    assert.match(gmSystem,/PR review or independent assessment.*create a separate quest with a fresh conversation/);
    assert.match(gmSystem,/Do not copy the implementation conversation or its conclusions/);
    assert.match(gmSystem,/explicitly requests continuation of an existing review, continue that review quest/);
    assert.match(gmSystem,/requests fixes from review findings, send those findings to the implementation quest/);
    const toolDescription = (name: string) => gmRequest.tools.find((tool:any) => tool.function.name === name)?.function.description ?? '';
    assert.match(toolDescription('create_quest'), /separate quest with a fresh conversation for PR reviews/);
    assert.match(toolDescription('continue_quest'), /use create_quest instead of continuing the implementation quest/);
    assert.ok(gmRequest.tools.some((tool:any)=>tool.function.name==='list_quests'));
    const switched = await run('Continue with another model.', 'model-switch', undefined, undefined, false, undefined, 'local-fixture/alternate');
    assert.equal(switched.code, 0, JSON.stringify(switched));
    assert.ok(switched.events.some(event => event.type === 'session' && event.model === 'local-fixture/alternate'));
    const switchedUsage = switched.events.findLast(event => event.type === 'context');
    assert.ok(switchedUsage?.type === 'context' && switchedUsage.contextWindow === 64000);
    const switchedRequest = (await readFile(requestPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1);
    assert.equal(switchedRequest.model, 'alternate');
    assert.ok(JSON.stringify(switchedRequest.messages).includes('copper-otter'), 'Switching models preserves the saved conversation.');
    const stalled = await run('STALL_MODEL_REQUEST', 'stalled');
    assert.equal(stalled.code, 1, JSON.stringify(stalled));
    assert.ok(stalled.events.some(event => event.type === 'activity' && event.tool === 'model'));
    assert.ok(stalled.events.some(event => event.type === 'error' && /progress|response|silent/i.test(event.error)), JSON.stringify(stalled));
    assert.ok(!stalled.events.some(event => event.type === 'complete'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi worker sends reference images to vision models, persists them, and rejects text-only models', {timeout:30_000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'guildmaster-vision-worker-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const agentDir=join(directory,'engine');await mkdir(agentDir);
  const requestPath=join(directory,'requests.jsonl');
  await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:'http://fixture.invalid/v1',api:'openai-completions',apiKey:'test-only',models:[
    {id:'vision',name:'Vision fixture',reasoning:false,input:['text','image'],contextWindow:32000,maxTokens:1024},
    {id:'text',name:'Text fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1024},
  ]}}}));
  const image={type:'image' as const,mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
  const instruction:DeliveryInstruction={id:'image-delivery',kind:'prompt',text:'Review this screen.',images:[image]};
  async function run(id:string,model:string,deliveries:DeliveryInstruction[],sessionPath=join(directory,'session.jsonl')) {
    const spec:WorkerSpec={questId:'vision-quest',runId:id,cwd:directory,agentDir,prompt:'Review this screen.',sessionPath,model:`local-fixture/${model}`,deliveries,tools:[],role:'quest'};
    const specPath=join(directory,id+'.json');await writeFile(specPath,JSON.stringify(spec));
    const child=fork(resolve('src/worker.ts'),[specPath],{execArgv:['--experimental-strip-types','--import',resolve('tests/fixtures/model-fetch.mjs')],env:{...process.env,PI_CODING_AGENT_DIR:agentDir,GUILDMASTER_TEST_REQUESTS:requestPath},silent:true});
    const events:WorkerEvent[]=[];let stderr='';child.on('message',(event:WorkerEvent)=>events.push(event));child.stderr?.on('data',data=>stderr+=data);
    const timer=setTimeout(()=>child.kill('SIGKILL'),12000);
    const code=await new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timer);
    return {events,code,stderr};
  }
  const first=await run('first','vision',[instruction]);assert.equal(first.code,0,JSON.stringify(first));
  assert.ok(first.events.some(event=>event.type==='delivered'&&event.ids.includes(instruction.id)));
  const requests=(await readFile(requestPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(JSON.stringify(requests[0]).includes(`data:image/png;base64,${image.data}`));
  const session=SessionManager.open(join(directory,'session.jsonl'));
  assert.ok(session.getEntries().some(entry=>entry.type==='message'&&entry.message.role==='user'&&Array.isArray(entry.message.content)&&entry.message.content.some(part=>part.type==='image'&&part.data===image.data)));
  const retry=await run('retry','vision',[instruction]);assert.equal(retry.code,0,JSON.stringify(retry));
  assert.equal(SessionManager.open(join(directory,'session.jsonl')).getEntries().filter(entry=>entry.type==='message'&&entry.message.role==='user'&&Array.isArray(entry.message.content)&&entry.message.content.some(part=>part.type==='image')).length,1);
  const unsupported=await run('unsupported','text',[instruction],join(directory,'text-session.jsonl'));
  assert.ok(unsupported.events.some(event=>event.type==='error'&&event.error.includes('cannot read images')),JSON.stringify(unsupported));
});
