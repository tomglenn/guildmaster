import { questFile } from './quest-files.ts';
import { ImageGeneration } from './image-generation.ts';
import { SchedulesService } from './schedules.ts';
import { ArchiveStorage } from './archive-storage.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { QuestService, directory } from './quests.ts';
import { AppError } from '../domain/types.ts';
import { EngineSettings } from '../engine/settings.ts';
import { discoverGuidance, guidanceCatalog } from '../engine/guidance.ts';
import { resolveProject, resolveProjectRepository } from './projects.ts';
import { browseFolders } from './folders.ts';
import { ConnectionManager } from '../connections/manager.ts';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const mime: Record<string,string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const safeEqual = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
function questSummary(q: ReturnType<Store['list']>[number]) {
  return { id:q.id,title:q.title,status:q.status,archivedAt:q.archivedAt,workspaceMode:q.workspaceMode,workspacePath:q.workspacePath,
    schedule:q.schedule,workspacePolicy:q.workspacePolicy,isolation:q.isolation,queueReason:q.queueReason,project:q.project ? { id:q.project.id,name:q.project.name } : undefined,workspaces:q.workspaces,model:q.model,runCount:q.runCount,error:q.error,agentSummary:q.agentSummary };
}
export function createApp(options: { dataDir: string; port?: number; workerPath?: string; defaultWorkspace?: string; models?: {id:string;name:string}[]; staticDir?: string; maxWorkers?: number; imageGenerationOptions?: { fetch?: typeof fetch; timeoutMs?: number }; connectionOptions?: Omit<ConstructorParameters<typeof ConnectionManager>[0], 'store'|'dataDir'> }) {
  const dataDir = resolve(options.dataDir); const store = new Store(dataDir);
  const settings = new EngineSettings(dataDir);
  const connections=new ConnectionManager({store,dataDir,...options.connectionOptions});
  const service = new QuestService({ store, dataDir, connections, workerPath: options.workerPath, defaultWorkspace: options.defaultWorkspace, maxWorkers: options.maxWorkers });
  const images = new ImageGeneration({ store, dataDir, ...options.imageGenerationOptions, changed: () => service.emit('change', { images: true }) });
  const archiveStorage=new ArchiveStorage(service);
  const schedules=new SchedulesService(service);
  const token = randomBytes(32).toString('hex'); let port = options.port ?? 4173; let listening = false;
  const clients = new Set<ServerResponse>(); const staticDir = resolve(options.staticDir ?? join(projectRoot, 'dist'));
  let modelsPromise: Promise<{models:{id:string;name:string}[];modelError?:string}> | undefined;
  async function models() {
    if (options.models) return { models: options.models };
    modelsPromise ??= settings.get().then(view => ({models:view.models,modelError:view.providerError}))
      .catch(() => ({models:[],modelError:'Provider settings could not be loaded. Open Settings to check your configuration.'}));
    return modelsPromise;
  }
  const broadcast = (event: string, data: unknown) => {
    for (const client of clients) {
      if (client.writableLength > 512000) { client.destroy(); clients.delete(client); continue; }
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  service.on('change', data => broadcast('change', data)); service.on('delta', data => broadcast('delta', data)); service.on('live', data => broadcast('live', data));
  service.on('tool', data => broadcast('tool', data));
  function json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }); res.end(JSON.stringify(data));
  }
  async function body(req: IncomingMessage): Promise<Record<string, any>> {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Send JSON with Content-Type: application/json.', 415);
    const imageMessagePath = /^\/api\/(?:guildmaster|quests(?:\/[^/]+\/continue)?|requests\/[^/]+\/answer)$/.test(new URL(req.url!, 'http://localhost').pathname);
    const limit = imageMessagePath ? 29 * 1024 * 1024 : 120000;
    let content = ''; for await (const chunk of req) { content += chunk; if (content.length > limit) throw new AppError('Request too large.', 413); }
    try { const value = JSON.parse(content); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new AppError('Request body must be a JSON object.'); }
  }
  function authorize(req: IncomingMessage) {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (safeEqual(supplied, token)) return { human: true, gm: undefined, lead: undefined };
    const worker = service.workerTokens.get(supplied);
    if (worker) {
      const lead = service.get(worker.questId);
      if (lead.activeRunId !== worker.runId || !['running','awaiting_input'].includes(lead.status)) throw new AppError('This lead run is no longer active.',403);
      return { human: false, gm: undefined, lead, runId: worker.runId };
    }
    const gmId = service.gmTokens.get(supplied);
    if (gmId) {
      const gm=service.get(gmId);
      if(gm.activeRunId!==service.gmRunTokens.get(supplied)||!['running','awaiting_input'].includes(gm.status))throw new AppError('This Guildmaster run is no longer active.',403);
      return {human:false,gm,lead:undefined};
    }
    const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('guildmaster_token='))?.slice('guildmaster_token='.length) ?? '';
    if (safeEqual(cookie, token)) return {human: true, gm: undefined, lead: undefined};
    throw new AppError('Open Guildmaster in this browser to connect to the local service.', 401);
  }
  const server = createServer(async (req, res) => {
    try {
      // Host validation prevents DNS rebinding. The service is loopback-only.
      if (!new Set([`127.0.0.1:${port}`,`localhost:${port}`]).has(req.headers.host ?? '')) throw new AppError('Invalid local host.', 403);
      if (req.headers.origin) {
        const allowed = new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
        if (process.env.GUILDMASTER_DEV_ORIGIN) allowed.add(process.env.GUILDMASTER_DEV_ORIGIN);
        if (!allowed.has(req.headers.origin)) throw new AppError('This origin cannot access Guildmaster.', 403);
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); const path = url.pathname;
      // Exhaustion fences all ordinary main routes, including public/GET routes.
      // Worker completion is IPC and deliberately retains its authority.
      const mainId=service.gmTokens.get(req.headers.authorization?.replace(/^Bearer /,'') ?? '');
      if(mainId)service.inlineReads.toolBudget(mainId);
      if(req.method==='GET'&&path==='/oauth/slack/callback') {
        const ok=await connections.callback(url.searchParams.get('state'),url.searchParams.get('code'),url.searchParams.has('error'));
        broadcast('change',{connection:true});
        res.writeHead(ok||url.searchParams.has('error')?200:400,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});
        res.end(`<html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guildmaster Slack connection</title><body style="font:16px system-ui;padding:40px;background:#191a1c;color:#e9e9ec"><h1>${ok?'Slack connected':url.searchParams.has('error')?'Slack sign-in cancelled':'Slack could not be connected'}</h1><p>Return to Guildmaster Settings → Connections${ok||url.searchParams.has('error')?'.':' to check the connection and try again.'}</p></body></html>`);return;
      }
      if(path==='/api/agent/inline-read') {
        if(req.method!=='POST')throw new AppError('Method not allowed.',405);
        const supplied=req.headers.authorization?.replace(/^Bearer /,'') ?? '';
        const input=await body(req);
        input.roundId ??= req.headers['x-guildmaster-round-id'];
        const controller=new AbortController();const onClose=()=>{if(!res.writableEnded)controller.abort();};res.on('close',onClose);
        try {json(res,200,await service.inlineReads.read(supplied,input,controller.signal));} finally {res.off('close',onClose);}return;
      }
      if (path === '/api/agent/images' || path === '/api/agent/images/generate') {
        const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const run = service.imageTokens.get(supplied);
        const active = () => {
          const quest = run && store.get(run.questId);
          if (!run || run.controller.signal.aborted || quest?.activeRunId !== run.runId || !['running','awaiting_input'].includes(quest.status)) throw new AppError('This agent run no longer has image access.',403);
          if (quest.kind === 'guildmaster') {
            service.inlineReads.toolBudget(quest.id);
            if (req.method === 'POST' && service.inlineReads.hasRead(quest.id)) throw new AppError('Inline source data cannot authorize image generation. Only the original request may be handed off to a quest.',403);
          }
          return quest;
        };
        const quest = active();
        // Outputs belong to the caller's durable conversation: GM's conversation quest,
        // or the delegate itself (never its lead). References cannot cross this boundary.
        if (req.method === 'GET' && path === '/api/agent/images') {
          const jobs = images.list(quest.id);
          json(res,200,{ outputs: jobs.flatMap(job => job.outputs), jobs: jobs.map(({commandId,status,error,createdAt,endedAt,count,quality,size}) => ({commandId,status,error,createdAt,endedAt,count,quality,size})), settings: (() => { const {defaultQuality,defaultSize} = images.settingsView(); return {defaultQuality,defaultSize}; })(), attachments: store.messages(quest.id).flatMap(message => message.attachments ?? []) }); return;
        }
        if (req.method !== 'POST' || path !== '/api/agent/images/generate') throw new AppError('Method not allowed.',405);
        const input = await body(req);
        active();
        if (Object.keys(input).some(key => !['commandId','prompt','count','quality','size','references','reviseImageId','authorization'].includes(key))) throw new AppError('Unknown image generation field. Quest association is fixed by this run.');
        if (typeof input.commandId !== 'string' || !input.commandId.startsWith(`${run!.runId}:`) || !/^[^\x00-\x1f\x7f]{1,200}$/.test(input.commandId.slice(run!.runId.length + 1))) throw new AppError('Image command ID must be scoped to the current run.',403);
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close',onClose);
        try {
          const outputs = await images.generate(quest,input as Parameters<ImageGeneration['generate']>[1],AbortSignal.any([run!.controller.signal,controller.signal]));
          active(); json(res,200,{outputs});
        } finally { res.off('close',onClose); }
        return;
      }
      if(path==='/api/agent/connections'||path==='/api/agent/connections/call') {
        const supplied=req.headers.authorization?.replace(/^Bearer /,'') ?? '';
        const run=service.connectionTokens.get(supplied);
        const active=()=>{const quest=run&&store.get(run.questId);if(!run||run.controller.signal.aborted||quest?.activeRunId!==run.runId||!['running','awaiting_input'].includes(quest.status))throw new AppError('This agent run no longer has connection access.',403);};
        active();service.inlineReads.toolBudget(run!.questId);
        if(req.method==='GET'&&path==='/api/agent/connections') {json(res,200,{connections:connections.statuses(),availableTools:run!.grants.flatMap(g=>g.tools.map(t=>t.name))});return;}
        if(req.method!=='POST'||!path.endsWith('/call'))throw new AppError('Method not allowed.',405);
        const input=await body(req);service.inlineReads.toolBudget(run!.questId);const grant=run!.grants.find(g=>g.connectionId===input.connectionId);
        if(!grant)throw new AppError('This connection is not available to this run.',403);
        const controller=new AbortController();const onClose=()=>{if(!res.writableEnded)controller.abort();};res.on('close',onClose);
        try {const result=await connections.call(grant,input.tool,input.arguments,AbortSignal.any([run!.controller.signal,controller.signal]));active();service.inlineReads.toolBudget(run!.questId);json(res,200,result);}finally{res.off('close',onClose);}return;
      }
      if (req.method === 'GET' && path === '/api/health') { json(res, 200, {ok:true,version:'0.1.0',dataDir,capabilities:{isolatedQuests:true,followupQuests:true,schedules:true,questLifecycle:true,questInbox:true}}); return; }
      if (req.method === 'GET' && path === '/api/bootstrap') {
        if (req.headers.authorization && !authorize(req).human) throw new AppError('Only the user can open the browser session.',403);
        res.setHeader('Set-Cookie', `guildmaster_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
        const available = await models();
        json(res, 200, { ...service.board(),
          ...available, defaultModel: await settings.getDefaultModel(), defaultWorkspace: service.defaultWorkspace,
          projects: store.projects(), dataDir, version:'0.1.0' }); return;
      }
      if (path.startsWith('/api/')) {
        const auth = authorize(req);
        // The only post-read mutation exception copies the exact original direct request.
        if(path==='/api/guildmaster/delegate-request') {
          if(!auth.gm)throw new AppError('Only the active Guildmaster run can hand off its request.',403);
          if(req.method!=='POST')throw new AppError('Method not allowed.',405);
          const runId=auth.gm.activeRunId!;
          json(res,200,await service.delegateRequest(auth.gm.id,runId,await body(req)));return;
        }
        // Source text cannot authorize other mutations; worker questions use IPC.
        if(auth.gm&&req.method!=='GET'&&req.method!=='HEAD'&&service.inlineReads.hasRead(auth.gm.id))throw new AppError('Inline source data cannot authorize mutations. Use delegate_current_request to hand off only the saved original request within its scope; unrelated actions need direct user authorization.',403);
        const filePath = path.match(/^\/api\/quests\/([^/]+)\/files\/(.+)$/);
        if (filePath) {
          if (!auth.human) throw new AppError('Only the user can open quest files.',403);
          if (!['GET','HEAD'].includes(req.method ?? '')) throw new AppError('Method not allowed.',405);
          const file = await questFile(service.get(decodeURIComponent(filePath[1])),decodeURIComponent(filePath[2]));
          res.writeHead(200,{'Content-Type':file.type,'Content-Length':file.data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
            'Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            ...(file.download?{'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`}:{})});
          res.end(req.method==='HEAD'?undefined:file.data);return;
        }
        const imagePath = path.match(/^\/api\/quests\/([^/]+)\/images\/([^/]+)$/);
        if (imagePath) {
          if (!auth.human) throw new AppError('Only the user can open conversation images.',403);
          if (req.method !== 'GET') throw new AppError('Method not allowed.',405);
          const image = store.image(decodeURIComponent(imagePath[1]),decodeURIComponent(imagePath[2]));
          if (!image) throw new AppError('Image not found.',404);
          res.writeHead(200,{'Content-Type':image.mimeType,'Content-Length':image.data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",
            ...(url.searchParams.has('download') ? {'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(image.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`} : {})});
          res.end(Buffer.from(image.data)); return;
        }
        if (path === '/api/schedule-drafts') {
          if (!auth.gm) throw new AppError('Only Guildmaster can prepare schedule drafts.',403);
          if (req.method !== 'POST') throw new AppError('Method not allowed.',405);
          const input=await body(req);input.model??=auth.gm.model;input.tools??=auth.gm.tools;
          if(!Array.isArray(input.tools)||input.tools.some((tool:string)=>!auth.gm!.tools.includes(tool)))throw new AppError('The draft cannot expand Guildmaster capabilities.',403);
          json(res,201,await schedules.draft(input));return;
        }
        const draftPath=path.match(/^\/api\/schedule-drafts\/([^/]+)$/);
        if (path === '/api/schedules' || path.startsWith('/api/schedules/') || draftPath) {
          if (!auth.human) throw new AppError('Only the user can manage schedules.',403);
          if(draftPath) {
            if(req.method!=='GET')throw new AppError('Method not allowed.',405);
            const draft=store.scheduleDraft(draftPath[1]);if(!draft)throw new AppError('Schedule draft not found.',404);
            json(res,200,{draft});return;
          }
          const match=path.match(/^\/api\/schedules\/([^/]+)(?:\/(history|pause|resume|delete|run))?$/);
          if(req.method==='GET') {
            if(path==='/api/schedules'){json(res,200,{schedules:schedules.list(),schedulerError:schedules.lastError});return;}
            if(match){const schedule=schedules.get(match[1]);
              if(match[2]==='history') {const offset=Number(url.searchParams.get('offset')??0);if(!Number.isSafeInteger(offset)||offset<0)throw new AppError('Invalid history offset.');json(res,200,schedules.history(schedule.id,offset));return;}
              if(!match[2]){json(res,200,{schedule,...schedules.history(schedule.id)});return;}
            }
          }
          if(req.method==='POST') {
            const input=await body(req);
            if(path==='/api/schedules'||(match&&!match[2])){input.model||=(await settings.getDefaultModel())||(await models()).models[0]?.id;json(res,200,await schedules.save(input,match?.[1]));return;}
            if(match&&['pause','resume','delete','run'].includes(match[2])){json(res,200,await schedules.action(match[1],match[2] as 'pause'|'resume'|'delete'|'run',input));return;}
          }
          throw new AppError('Endpoint not found.',404);
        }
        const agentsPath = path.match(/^\/api\/quests\/([^/]+)\/agents(?:\/([^/]+)(?:\/(continue|answer))?)?$/);
        const waitPath = path.match(/^\/api\/quests\/([^/]+)\/wait$/);
        const followupsPath = path.match(/^\/api\/quests\/([^/]+)\/followups$/);
        const projectRead = req.method === 'GET' && (path === '/api/projects' || path.startsWith('/api/projects/'));
        const workspacePath = path.match(/^\/api\/quests\/([^/]+)\/workspaces$/);
        if (auth.lead && !projectRead && ((!agentsPath && !waitPath && !workspacePath && !followupsPath) || (agentsPath?.[1] ?? waitPath?.[1] ?? workspacePath?.[1] ?? followupsPath?.[1]) !== auth.lead.id)) throw new AppError('Quest leads can only read projects and manage their own delegates, workspaces, and requested follow-up quests.',403);
        if (followupsPath) {
          if (!auth.lead || auth.lead.kind !== 'quest') throw new AppError('Only the originating quest lead can create follow-up quests.',403);
          if (req.method !== 'POST') throw new AppError('Method not allowed.',405);
          const created = await service.createFollowup(auth.lead.id, await body(req), auth.runId!);
          json(res,201,{quest:questSummary(created.quest)}); return;
        }
        if (workspacePath) {
          if (!auth.human && !auth.lead) throw new AppError('Only the user or this quest lead can prepare its workspaces.',403);
          if (req.method !== 'POST') throw new AppError('Method not allowed.',405);
          json(res,201,await service.createWorkspace(workspacePath[1],await body(req) as any,auth.runId)); return;
        }
        if (agentsPath || waitPath) {
          if (!auth.human && !auth.lead) throw new AppError('Only the user or this quest lead can manage its delegates.',403);
          const parentId = (agentsPath?.[1] ?? waitPath?.[1])!;
          if (service.get(parentId).kind !== 'quest') throw new AppError('Only quest leads can delegate work.',403);
          if (req.method === 'GET' && agentsPath && !agentsPath[2]) { json(res,200,{agents:service.agents(parentId)}); return; }
          if (agentsPath?.[2] && service.get(agentsPath[2]).parentQuestId !== parentId) throw new AppError('This delegate belongs to another quest.',403);
          if (req.method === 'GET' && agentsPath?.[2] && !agentsPath[3]) { json(res,200,service.detail(agentsPath[2])); return; }
          if (req.method !== 'POST') throw new AppError('Endpoint not found.',404);
          const input = await body(req);
          if (waitPath) { json(res,200,await service.waitForAgents(parentId,input as any,auth.runId)); return; }
          if (agentsPath?.[3] === 'answer') {
            if (!auth.lead) throw new AppError('Only the quest lead can answer a delegate.',403);
            json(res,200,await service.answer(String(input.requestId),{answer:input.answer,commandId:input.commandId as string},{parentId,agentId:agentsPath[2],expectedRunId:auth.runId})); return;
          }
          if (agentsPath?.[3] === 'continue') { json(res,200,await service.continueDelegate(parentId,agentsPath[2],input as any,auth.runId)); return; }
          if (agentsPath && !agentsPath[2]) { json(res,201,await service.createDelegate(parentId,input as any,auth.runId)); return; }
          throw new AppError('Endpoint not found.',404);
        }
        if (path === '/api/folders') {
          if (!auth.human) throw new AppError('Only the user can browse folders.', 403);
          if (req.method !== 'GET') throw new AppError('Method not allowed.', 405);
          json(res, 200, await browseFolders({ path: url.searchParams.has('path') ? url.searchParams.get('path') : undefined, hidden: url.searchParams.get('hidden') === 'true' }));
          return;
        }
        if (path === '/api/projects' || path.startsWith('/api/projects/')) {
          if (req.method === 'GET' && path === '/api/projects/resolve') {
            json(res, 200, await resolveProjectRepository(store.projects(), url.searchParams.get('repositoryUrl') ?? '')); return;
          }
          if (path === '/api/projects/default') throw new AppError('Endpoint not found.', 404);
          const projectActionPath = path.match(/^\/api\/projects\/([^/]+)\/(archive|restore)$/);
          const projectPath = path.match(/^\/api\/projects\/([^/]+)$/);
          const repositoriesPath = path.match(/^\/api\/projects\/([^/]+)\/repositories$/);
          if (req.method === 'GET' && path === '/api/projects') {
            const projects = store.projects().filter(project => url.searchParams.get('includeArchived') === 'true' || !project.archivedAt);
            json(res, 200, auth.human ? projects : projects.map(({ id, name, aliases, repositories, archivedAt }) => ({ id, name, aliases, repositories, ...(archivedAt ? { archivedAt } : {}) })));
            return;
          }
          if (req.method === 'GET' && projectPath) {
            const project = resolveProject(store, decodeURIComponent(projectPath[1]));
            const guidance = discoverGuidance(project.repositories.map(repository => ({ repositoryId: repository.id, sourcePath: repository.path, workspacePath: repository.path })), { shared: false });
            json(res, 200, { project, guidance: { instructions: guidance.instructions.map(({ path, scope, root }) => ({ path, scope, root })), skills: guidanceCatalog(guidance), warnings: guidance.warnings } }); return;
          }
          if (req.method === 'POST' && path === '/api/projects') { json(res, 201, await service.saveProject(await body(req))); return; }
          if (req.method === 'POST' && projectActionPath) {
            json(res, 200, await service.projectAction(decodeURIComponent(projectActionPath[1]), projectActionPath[2] as 'archive' | 'restore', await body(req))); return;
          }
          if (req.method === 'POST' && repositoriesPath) { json(res, 200, await service.addProjectRepositories(await body(req), decodeURIComponent(repositoriesPath[1]))); return; }
          if (!auth.human) throw new AppError('Only the user can replace project settings.', 403);
          if (req.method === 'POST') {
            const input = await body(req);
            if (projectPath) { json(res, 200, await service.saveProject(input, decodeURIComponent(projectPath[1]))); return; }
          }
          throw new AppError('Endpoint not found.', 404);
        }
        if(path==='/api/settings/connections'||path.startsWith('/api/settings/connections/')) {
          if(!auth.human)throw new AppError('Only the user can manage connections.',403);
          const loginPath=path.match(/^\/api\/settings\/connections\/login\/([^/]+)$/);
          let result:unknown;
          if(req.method==='GET'&&path==='/api/settings/connections')result=connections.view();
          else if(req.method==='GET'&&path.endsWith('/import-pi'))result=await connections.importPreview();
          else if(req.method==='GET'&&loginPath)result=connections.login(loginPath[1]);
          else if(req.method==='DELETE'&&loginPath)result=connections.cancelLogin(loginPath[1]);
          else if(req.method==='DELETE'&&path==='/api/settings/connections/slack')result=await connections.disconnect();
          else if(req.method==='POST') {
            const input=await body(req);
            if(path==='/api/settings/connections/login')result=await connections.startLogin(input.clientId);
            else if(path==='/api/settings/connections/import-pi') {
              result=await connections.importSettings(input.candidateId,input.clientId);
            } else throw new AppError('Endpoint not found.',404);
          } else throw new AppError('Endpoint not found.',404);
          broadcast('change',{connection:true});json(res,200,result);return;
        }
        if (path === '/api/settings/storage') {
          if (!auth.human) throw new AppError('Only the user can configure storage cleanup.',403);
          if (req.method === 'GET') json(res,200,archiveStorage.view());
          else if (req.method === 'POST') json(res,200,await archiveStorage.savePolicy((await body(req)).retentionDays));
          else throw new AppError('Method not allowed.',405);
          return;
        }
        if (path === '/api/quests/delete') {
          if (!auth.human) throw new AppError('Only the user can permanently delete quests.',403);
          if (req.method !== 'POST') throw new AppError('Method not allowed.',405);
          json(res,200,await archiveStorage.delete((await body(req)).ids));return;
        }
        if (path === '/api/settings/images') {
          if (!auth.human) throw new AppError('Only the user can configure image generation.',403);
          let view;
          if (req.method === 'GET') view = images.settingsView();
          else if (req.method === 'POST') view = images.saveSettings(await body(req));
          else throw new AppError('Method not allowed.',405);
          const {enabled,mock,model,configured,defaultQuality,defaultSize} = view;
          json(res,200,{enabled,mock,model,configured,defaultQuality,defaultSize}); return;
        }
        if (path === '/api/settings' || path.startsWith('/api/settings/')) {
          if (!auth.human) throw new AppError('Only the user can configure model providers.',403);
          const providerPath = path.match(/^\/api\/settings\/provider\/([^/]+)$/);
          const loginPath = path.match(/^\/api\/settings\/login\/([^/]+)$/);
          let result: unknown;
          if (req.method === 'GET' && path === '/api/settings') result = await settings.get();
          else if (req.method === 'GET' && loginPath) result = settings.getLogin(decodeURIComponent(loginPath[1]));
          else if (req.method === 'DELETE' && providerPath) result = await settings.removeProvider(decodeURIComponent(providerPath[1]));
          else if (req.method === 'DELETE' && loginPath) result = settings.cancelLogin(decodeURIComponent(loginPath[1]));
          else if (req.method === 'POST') {
            const input = await body(req);
            if (path === '/api/settings/provider') result = await settings.saveProvider({providerId:input.providerId,apiKey:input.apiKey});
            else if (path === '/api/settings/preferences') result = await settings.savePreferences({defaultModel:input.defaultModel});
            else if (path === '/api/settings/import-pi') result = await settings.importPi();
            else if (path === '/api/settings/login') result = await settings.startLogin(input.providerId,input.authType);
            else if (loginPath) result = settings.answerLogin(decodeURIComponent(loginPath[1]),input.value);
            else throw new AppError('Endpoint not found.',404);
          } else throw new AppError('Endpoint not found.',404);
          modelsPromise = undefined;
          json(res,200,result); return;
        }
        if (path === '/api/guildmaster/history') {
          if (!auth.human) throw new AppError('Only the user can view conversation history.',403);
          if (req.method !== 'GET') throw new AppError('Method not allowed.',405);
          json(res,200,{ conversations: store.list().filter(q => q.kind === 'guildmaster' && q.archivedAt).map(q => ({ id:q.id, title:q.objective.slice(0,140), createdAt:q.createdAt, archivedAt:q.archivedAt })) }); return;
        }
        if (req.method === 'GET' && path === '/api/events') {
          if (!auth.human) throw new AppError('Unsupported agent operation.',403);
          res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
          res.write(': connected\n\n'); clients.add(res);
          const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          res.on('close', () => { clearInterval(timer); clients.delete(res); }); return;
        }
        if (req.method === 'GET' && path === '/api/quests') { const quests=service.board().quests; json(res,200,auth.human?quests:quests.map(questSummary)); return; }
        const questPath = path.match(/^\/api\/quests\/([^/]+)(?:\/(continue|resume|accept|cancel|archive|restore|accept-close|close|reopen))?$/);
        if (req.method === 'GET' && questPath && !questPath[2]) {
          const detail=service.detail(questPath[1]);
          json(res,200,auth.human?detail:{quest:{...questSummary(detail.quest),result:detail.quest.result},requests:detail.requests.filter(r=>r.status==='pending')}); return;
        }
        if (req.method !== 'POST') throw new AppError('Endpoint not found.',404);
        const input = await body(req);
        if (path === '/api/quests') {
          if (auth.gm) {
            input.tools ??= auth.gm.tools;
            if (!Array.isArray(input.tools) || input.tools.some((t:string) => !auth.gm!.tools.includes(t))) throw new AppError('The quest needs capabilities beyond the current Guildmaster defaults. Ask the user to change the controls.',403);
            if (input.projectId !== undefined && input.projectId !== null) {
              // Registering a project makes its repositories available for delegation. Tool access is still bounded above.
              resolveProject(store, input.projectId);
            } else {
              // Unassigned quests use scratch space unless an allowed checkout is explicitly requested.
              input.projectId = null;
              input.workspacePath ??= auth.gm.workspacePath; input.workspaceMode ??= 'none';
              if (input.workspaceMode !== 'none' && directory(input.workspacePath) !== auth.gm.workspacePath) throw new AppError('Register this workspace as a project before creating the quest.',403);
            }
          }
          input.model ??= await settings.getDefaultModel();
          const created = await service.create(input as any, 'quest', undefined, auth.gm ? service.delegationSource(auth.gm) : undefined);
          json(res,201,auth.human?created:{quest:questSummary(created.quest)}); return;
        }
        if (questPath && questPath[2]) {
          const [, id, action] = questPath;
          if (!auth.human && action !== 'continue') throw new AppError('Only the user can accept, cancel, resume, archive, or restore a quest.',403);
          if (auth.gm) {
            const q = service.get(id);
            const registeredProject = q.project && !!store.project(q.project.id);
            if (q.kind !== 'quest' || !q.tools.every(t => auth.gm!.tools.includes(t)) || (!registeredProject && q.workspaceMode !== 'none' && (q.sourcePath ?? q.workspacePath) !== auth.gm.workspacePath)) throw new AppError('This quest is outside the current Guildmaster defaults.',403);
          }
          if (action === 'continue' || action === 'resume') { const updated=await service.continue(id,input as any,action === 'resume',auth.gm ? service.delegationSource(auth.gm) : undefined); json(res,200,auth.human?updated:{quest:questSummary(updated.quest!)}); }
          else json(res,200,await service.action(id,action as 'accept'|'cancel'|'archive'|'restore'|'accept-close'|'close'|'reopen',input as any));
          return;
        }
        if (!auth.human) throw new AppError('Unsupported agent operation.',403);
        const requestPath = path.match(/^\/api\/requests\/([^/]+)\/answer$/);
        if (requestPath) { json(res,200,await service.answer(decodeURIComponent(requestPath[1]),input as any)); return; }
        if (path === '/api/guildmaster/new') { json(res,200,await service.newGuildmaster(input as any)); return; }
        if (path === '/api/guildmaster') { input.model ??= await settings.getDefaultModel(); json(res,200,await service.guildmaster(input)); return; }
        throw new AppError('Endpoint not found.',404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError('Method not allowed.',405);
      const requested = resolve(staticDir, `.${decodeURIComponent(path)}`);
      if (requested !== staticDir && !requested.startsWith(staticDir + sep)) throw new AppError('Invalid path.',403);
      let file = requested;
      try { if (!(await stat(file)).isFile()) file = join(staticDir,'index.html'); } catch { file = join(staticDir,'index.html'); }
      if (!existsSync(file)) {
        res.writeHead(503, {'Content-Type':'text/html; charset=utf-8'}); res.end('<h1>Guildmaster is running</h1><p>Build the interface with <code>npm run build</code>, then reload.</p>'); return;
      }
      res.writeHead(200, {'Content-Type':mime[extname(file)] ?? 'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"});
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) { if (!res.headersSent) json(res,error instanceof AppError ? error.status : 500,{error:error instanceof Error ? error.message : String(error)}); else res.end(); }
  });
  return {
    server, store, service, connections, images, archiveStorage, schedules,
    async listen() {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port,'127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      port = (server.address() as {port:number}).port; listening = true;
      const url = `http://127.0.0.1:${port}`; service.serviceUrl = url; service.serviceToken = token; connections.serviceUrl=url; archiveStorage.start();schedules.start();
      return {url,token};
    },
    async close() {
      for (const c of clients) c.end(); clients.clear();
      await schedules.close();
      await archiveStorage.close();
      settings.close();
      await images.close();
      await service.close();
      await connections.close();
      if (listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      store.close();
    },
  };
}
