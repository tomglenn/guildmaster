import test from 'node:test';
import assert from 'node:assert/strict';
import { guildmasterTools } from './tools.ts';
import { projectContext } from './project-context.ts';
import type { WorkerSpec } from './protocol.ts';

const spec: WorkerSpec = {
  questId: 'gm', runId: 'run-1', cwd: '/projects/alpha/web', prompt: 'Work on Alpha',
  sessionPath: '/sessions/gm.jsonl', role: 'guildmaster', tools: ['read'],
  serviceUrl: 'http://127.0.0.1:4173', serviceToken: 'test-only',
  project: {id: 'alpha', name: 'Alpha', instructions: 'Preserve API compatibility.'},
  workspaces: [
    {repositoryId: 'web', name: 'Web', sourcePath: '/projects/alpha/web', workspacePath: '/projects/alpha/web', mode: 'worktree'},
    {repositoryId: 'api', name: 'API', sourcePath: '/projects/alpha/api', workspacePath: '/projects/alpha/api', mode: 'existing'},
  ],
};

test('delegation requires explicit project selection and never inherits a previous project', async t => {
  const sent: {url:string;body:any}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    if (init.method === 'GET') return new Response(JSON.stringify({project:{id:String(input).includes('Beta') ? 'beta' : 'alpha'}}));
    sent.push({url:String(input),body:init.body ? JSON.parse(String(init.body)) : undefined});
    return new Response(JSON.stringify({quest:{id:'created'}}), {status:201});
  });
  const create = guildmasterTools(spec).find(tool => tool.name === 'create_quest')!;
  await create.execute('call-1', {title:'Feature',objective:'Build it'}, undefined, undefined, {} as any);
  assert.equal(sent[0].body.projectId, null);
  assert.equal(sent[0].body.workspaceMode, 'none');
  assert.equal(sent[0].body.repositories, undefined);
  assert.equal(sent[0].body.workspacePath, undefined);
  assert.deepEqual(sent[0].body.tools, ['read']);
  assert.equal(sent[0].body.commandId, 'run-1:call-1');

  await create.execute('call-2', {title:'Review',objective:'Review Beta',projectId:'Beta'}, undefined, undefined, {} as any);
  assert.equal(sent[1].body.projectId, 'beta');
  assert.equal(sent[1].body.repositories, undefined);
  assert.equal(sent[1].body.workspacePath, undefined);
  assert.equal(sent[1].body.workspaceMode, undefined);

  await create.execute('call-3', {title:'Plan',objective:'Plan only',projectId:'alpha',repositories:[]}, undefined, undefined, {} as any);
  assert.deepEqual(sent[2].body.repositories, []);
  await create.execute('call-4', {title:'Plan',objective:'No workspace',projectId:'alpha',workspaceMode:'none'}, undefined, undefined, {} as any);
  assert.deepEqual(sent[3].body.repositories, []);

  await create.execute('call-5', {title:'Legacy',objective:'Use explicit folder',projectId:null,workspacePath:'/projects/other'}, undefined, undefined, {} as any);
  assert.equal(sent[4].body.projectId, null);
  assert.equal(sent[4].body.workspacePath, '/projects/other');
  assert.equal(sent[4].body.repositories, undefined);
  await create.execute('call-6', {title:'Scratch',objective:'Unassigned',projectId:null,workspaceMode:'none'}, undefined, undefined, {} as any);
  assert.equal(sent[5].body.projectId, null);
  assert.equal(sent[5].body.workspaceMode, 'none');
  assert.equal(sent[5].body.workspacePath, undefined);
  assert.equal(sent[5].body.repositories, undefined);
});

test('project discovery tools call the registered project API with encoded names', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify([{id:'alpha',name:'Alpha'}]));
  });
  const tools = guildmasterTools(spec);
  const result = await tools.find(tool => tool.name === 'list_projects')!.execute('list', {}, undefined, undefined, {} as any);
  assert.equal(result.content[0].type, 'text');
  assert.ok(JSON.stringify(result.content).includes('Alpha'));
  await tools.find(tool => tool.name === 'inspect_project')!.execute('inspect', {projectId:'Alpha / Web'}, undefined, undefined, {} as any);
  assert.deepEqual(urls, ['http://127.0.0.1:4173/api/projects', 'http://127.0.0.1:4173/api/projects/Alpha%20%2F%20Web']);
});

test('worker project context uses saved workspace paths and instructions without a live registry', () => {
  const context = projectContext({...spec,role:'quest',workspaces:[{...spec.workspaces![0],workspacePath:'/worktrees/alpha-web',branch:'quest/feature'}]});
  assert.match(context, /Preserve API compatibility/);
  assert.match(context, /"path":"\/worktrees\/alpha-web"/);
  assert.match(context, /"branch":"quest\/feature"/);
  assert.doesNotMatch(context, /"repositoryId":"api"/);
  assert.match(projectContext({...spec,workspaces:[]}), /No repository is selected/);
  assert.equal(projectContext({...spec,project:undefined}), '');
});

test('explicit project names and aliases do not inherit a previous repository subset', async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: URL, init: RequestInit) => {
    if (init.method === 'GET') return new Response(JSON.stringify({project:{id:'alpha',name:'Alpha'}}));
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({quest:{id:'created'}}));
  });
  const create = guildmasterTools({...spec,workspaces:[spec.workspaces![0]]}).find(tool => tool.name === 'create_quest')!;
  for (const reference of ['Alpha','alpha-alias','ALPHA']) {
    await create.execute(reference, {title:'Feature',objective:'Build it',projectId:reference}, undefined, undefined, {} as any);
  }
  for (const request of requests) {
    assert.equal(request.projectId, 'alpha');
    assert.equal(request.repositories, undefined);
    assert.equal(request.workspacePath, undefined);
  }
});

test('project registration and additions preserve user paths, roles, and stable command IDs', async t => {
  const sent: {url:string;body:any;authorization:string}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    sent.push({url:String(input),body:JSON.parse(String(init.body)),authorization:(init.headers as Record<string,string>).Authorization});
    return new Response(JSON.stringify({project:{id:'example-app',name:'Example App'}}));
  });
  const tools = guildmasterTools(spec);
  const register = tools.find(tool => tool.name === 'register_project')!;
  const repositories = [
    {name:'Frontend',path:'~/projects/example-frontend'},
    {name:'Backend',path:'~/projects/example-backend'},
    {name:'Worker',path:'~/projects/example-worker'},
  ];
  const args = {name:'Example App',aliases:['example'],instructions:'Keep API contracts compatible.',repositories};
  await register.execute('register', args, undefined, undefined, {} as any);
  await register.execute('register', args, undefined, undefined, {} as any);
  assert.deepEqual(sent[0], sent[1], 'retries must use the same command ID and payload');
  assert.equal(sent[0].url, 'http://127.0.0.1:4173/api/projects');
  assert.deepEqual(sent[0].body, {...args,commandId:'run-1:register'});
  assert.equal(sent[0].authorization, 'Bearer test-only');
  const addition = {name:'Documentation',path:'~/projects/example-docs',description:'All guide content lives here.'};
  const result = await tools.find(tool => tool.name === 'add_project_repositories')!.execute('add', {projectId:'Example App / guides',repositories:[addition]}, undefined, undefined, {} as any);
  assert.equal(sent[2].url, 'http://127.0.0.1:4173/api/projects/Example%20App%20%2F%20guides/repositories');
  assert.deepEqual(sent[2].body, {repositories:[addition],commandId:'run-1:add'});
  assert.match(JSON.stringify(result.content), /Example App/);
  assert.match(projectContext({...spec,workspaces:[{...spec.workspaces![0],description:'All guide content lives here.'}]}), /All guide content lives here/);
});

test('project tools report validation failures instead of claiming success', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({error:'The workspace directory does not exist or cannot be read.'}), {status:400}));
  const register = guildmasterTools(spec).find(tool => tool.name === 'register_project')!;
  await assert.rejects(register.execute('bad-path', {name:'Missing',repositories:[{name:'App',path:'~/missing'}]}, undefined, undefined, {} as any), /400.*directory does not exist/);
});

test('Guildmaster can discover archived projects and archive or restore them with stable command IDs', async t => {
  const sent: {url:string;method:string;body:any}[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    sent.push({ url: String(input), method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(init.method === 'GET' ? [] : {project:{id:'project'}}));
  });
  const tools = guildmasterTools(spec);
  await tools.find(tool => tool.name === 'list_projects')!.execute('list-archived', {includeArchived:true}, undefined, undefined, {} as any);
  const archive = tools.find(tool => tool.name === 'archive_project')!;
  await archive.execute('archive-call', {projectId:'Demo / App'}, undefined, undefined, {} as any);
  await archive.execute('archive-call', {projectId:'Demo / App'}, undefined, undefined, {} as any);
  await tools.find(tool => tool.name === 'restore_project')!.execute('restore-call', {projectId:'Demo / App'}, undefined, undefined, {} as any);
  assert.equal(sent[0].url, 'http://127.0.0.1:4173/api/projects?includeArchived=true');
  assert.equal(sent[1].url, 'http://127.0.0.1:4173/api/projects/Demo%20%2F%20App/archive');
  assert.deepEqual(sent[1], sent[2]);
  assert.equal(sent[1].body.commandId, 'run-1:archive-call');
  assert.equal(sent[3].url, 'http://127.0.0.1:4173/api/projects/Demo%20%2F%20App/restore');
  assert.equal(sent[3].body.commandId, 'run-1:restore-call');
});

test('a new worker refuses isolated creation against an older service before any mutation', async t => {
  const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async (input:URL,init:RequestInit) => {
    calls.push(init.method+' '+new URL(input).pathname);
    return new Response(JSON.stringify({ok:true,version:'0.1.0'}));
  });
  const create=guildmasterTools(spec).find(tool=>tool.name==='create_quest')!;
  await assert.rejects(create.execute('isolated',{title:'Review',objective:'Inspect committed source',projectId:'alpha',workspacePolicy:'isolated'},undefined,undefined,{} as any),/No quest was created/);
  assert.deepEqual(calls,['GET /api/health']);
});
