import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import type { Quest } from '../domain/types.ts';
import { AppError } from '../domain/types.ts';
type GitHubInput = {operation:'issue'|'comments'|'pull';host:string;owner:string;repository:string;number:number;page?:number};
type RepositoryInput = {operation:'read'|'search';commit:string;path?:string;startLine?:number;endLine?:number;query?:string};
type Adapters = {readGitHub:(input:GitHubInput,signal:AbortSignal)=>Promise<unknown>;readRepository:(sourcePath:string,input:RepositoryInput,signal:AbortSignal)=>Promise<unknown>};
const defaultAdapters:Adapters = {
  readGitHub:async(input,signal)=>(await import('./inline-github.ts')).readGitHub(input,signal),
  readRepository:async(path,input,signal)=>(await import('./inline-repository.ts')).readRepository(path,input,signal),
};

export type InlineGrant = { kind:'github'; host:string; owner:string; repository:string; number?:number } | { kind:'repository'; repositoryId:string; commit:string; sourcePath:string };
type Usage = { grant?:InlineGrant; calls:number; bytes:number; firstRead?:number; rounds:string[]; pages:Record<string,number[]> };
type Run = { questId:string; runId:string; origin:string; controller:AbortController; concurrent:number };
const failure = (code:string, message:string) => ({ok:false,partial:true,untrusted:true,error:{code,message}});

/** Service-owned, durable per-human-message authority; never derived from retrieved source text. */
export class InlineReads {
  tokens = new Map<string,Run>();
  private store:Store; private adapters:Adapters; private now:()=>number;
  constructor(store:Store, adapters:Adapters = defaultAdapters, now = Date.now) {this.store=store;this.adapters=adapters;this.now=now;}
  private usage(origin:string) { return this.store.setting<Usage>(`inline:usage:${origin}`); }
  private save(origin:string,usage:Usage) { this.store.saveSetting(`inline:usage:${origin}`,usage); }
  origin(runId:string) {return this.store.setting<string>(`inline:origin:${runId}`);}
  bind(runId:string,origin:string) {this.store.saveSetting(`inline:origin:${runId}`,origin);}
  private resolve(q:Quest,request:string):InlineGrant|undefined {
    const urls=[...request.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(issues|pull)\/(\d+))?/g)];
    const targets=new Set(urls.map(m=>`${m[1].toLowerCase()}/${m[2].replace(/\.git$/,'').toLowerCase()}`));
    if(targets.size>1)return;
    if(urls.length) {const m=urls[0];return {kind:'github',host:'github.com',owner:m[1],repository:m[2].replace(/\.git$/,''),...(m[4]?{number:Number(m[4])}:{})};}
    const contains=(value:string)=>value.length>2&&new RegExp(`(^|[^a-z0-9_-])${value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9_-]|$)`,'i').test(request);
    const projects=this.store.projects().filter(p=>!p.archivedAt);
    const explicit=projects.flatMap(p=>p.repositories.filter(r=>contains(r.id)||contains(r.name)||(p.repositories.length===1&&[p.id,p.name,...p.aliases].some(contains))));
    const selected=explicit.length ? explicit : q.project ? projects.find(p=>p.id===q.project!.id)?.repositories.filter(r=>q.workspaces?.some(w=>w.repositoryId===r.id)) ?? [] : [];
    if(selected.length!==1)return;
    const r=selected[0];
    try {const commit=execFileSync('git',['--no-replace-objects','-C',r.path,'rev-parse','--verify','HEAD^{commit}'],{encoding:'utf8',timeout:3000,maxBuffer:1024,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
      if(/^[a-f0-9]{40,64}$/.test(commit))return {kind:'repository',repositoryId:r.id,commit,sourcePath:r.path};
    } catch { /* An unresolved repository grants nothing. */ }
  }
  attach(q:Quest,runId:string) {
    if(q.kind!=='guildmaster')return;
    const bound=this.origin(runId);
    const origin=bound ? this.store.messages(q.id).find(m=>m.id===bound) : [...this.store.messages(q.id)].reverse().find(m=>m.role==='user'&&m.source==='user');
    if(!origin)return;
    let usage=this.usage(origin.id);
    if(!usage) {usage={grant:this.resolve(q,origin.displayText??origin.text),calls:0,bytes:0,rounds:[],pages:{}};this.save(origin.id,usage);}
    const token=randomUUID();this.tokens.set(token,{questId:q.id,runId,origin:origin.id,controller:new AbortController(),concurrent:0});
    const grant=usage.grant;
    return {inlineToken:token,inlineGrant:grant?.kind==='github'?{github:{host:grant.host,owner:grant.owner,repository:grant.repository,...(grant.number?{number:grant.number}:{})}}:grant?{repository:{repositoryId:grant.repositoryId,commit:grant.commit}}:undefined};
  }
  private active(run:Run) {
    const q=this.store.get(run.questId);
    if(run.controller.signal.aborted||q?.activeRunId!==run.runId||!['running','awaiting_input'].includes(q.status))throw new AppError('This run no longer has inline read access.',403);
  }
  revoke(questId:string,runId?:string) {for(const [token,run] of this.tokens)if(run.questId===questId&&(!runId||run.runId===runId)){run.controller.abort();this.tokens.delete(token);}}
  hasRead(questId:string) {
    const q=this.store.get(questId);const bound=q?.activeRunId&&this.origin(q.activeRunId);
    const origin=bound ?? [...this.store.messages(questId)].reverse().find(m=>m.role==='user'&&m.source==='user')?.id;
    return !!origin&&!!this.usage(origin)?.calls;
  }
  toolBudget(questId:string) {
    const q=this.store.get(questId);const origin=q?.activeRunId&&this.origin(q.activeRunId);const usage=origin?this.usage(origin):undefined;
    if(usage?.firstRead!==undefined&&(usage.rounds.length>4||this.now()-usage.firstRead>=60000))throw new AppError('Inline tool budget exhausted. Return partial coverage without further source calls.',403);
  }
  round(questId:string,runId:string,roundId:string) {
    const run=[...this.tokens.values()].find(r=>r.questId===questId&&r.runId===runId);if(!run)return false;
    this.active(run);const usage=this.usage(run.origin)!;
    if(typeof roundId!=='string'||!roundId||roundId.length>200)return false;
    if(usage.rounds.length>4)return false;
    const key=`${runId}:${roundId}`;
    if(!usage.rounds.includes(key)) {usage.rounds.push(key);this.save(run.origin,usage);}
    return usage.rounds.length<=4;
  }
  async read(token:string,input:Record<string,any>,disconnect?:AbortSignal) {
    const run=this.tokens.get(token);if(!run)throw new AppError('Inline reads are only available to the active Guildmaster run.',403);
    this.active(run);
    const usage=this.usage(run.origin)!;const grant=usage.grant;
    if(!grant)return failure('scope_required','Ask the user for one exact GitHub URL or one registered repository.');
    if(input.kind!==grant.kind)return failure('scope_denied','This source is outside the direct user request.');
    if(grant.kind==='github') {
      if(input.host!==grant.host||String(input.owner).toLowerCase()!==grant.owner.toLowerCase()||String(input.repository).toLowerCase()!==grant.repository.toLowerCase()||(grant.number!==undefined&&input.number!==grant.number)||!['issue','comments','pull'].includes(input.operation)||!Number.isSafeInteger(input.number)||input.number<1)return failure('scope_denied','GitHub target or operation is outside this grant.');
    } else if(input.repositoryId!==grant.repositoryId||input.commit!==grant.commit||!['read','search'].includes(input.operation))return failure('scope_denied','Repository identity and commit must match the resolved grant.');
    if(!this.round(run.questId,run.runId,input.roundId))return failure('round_budget','Four tool-using rounds exhausted. Return an honest partial answer.');
    // round() persists an updated copy; reload before reserving.
    const current=this.usage(run.origin)!;
    if(current.calls>=8||current.bytes>=100*1024)return failure('source_budget','Inline source budget exhausted; disclose missing coverage.');
    if(current.firstRead!==undefined&&this.now()-current.firstRead>=60000)return failure('deadline','Inline request exceeded sixty seconds; return partial coverage.');
    if(run.concurrent>=2)return failure('concurrency','At most two inline reads may be in flight.');
    const page=input.page??1;
    if(!Number.isSafeInteger(page)||page<1||page>3)return failure('page_budget','Only the first three pages of a collection may be read.');
    const collection=`${input.kind}:${input.operation}:${input.number??''}`;
    const pages=current.pages[collection]??[];
    if(!pages.includes(page)&&pages.length>=3)return failure('page_budget','Three pages per collection exhausted.');
    current.pages[collection]=[...new Set([...pages,page])];current.calls++;current.firstRead??=this.now();this.save(run.origin,current);run.concurrent++;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.min(15000,Math.max(1,60000-(this.now()-current.firstRead))));
    const signal=AbortSignal.any([run.controller.signal,controller.signal,...(disconnect?[disconnect]:[])]);
    try {
      // The race fences adapters which ignore cancellation; late results never enter receipts.
      const operation=grant.kind==='github'
        ? this.adapters.readGitHub({operation:input.operation,host:grant.host,owner:grant.owner,repository:grant.repository,number:input.number,page},signal)
        : this.adapters.readRepository(grant.sourcePath,{operation:input.operation,commit:grant.commit,path:input.path,startLine:input.startLine,endLine:input.endLine,query:input.query},signal);
      let abort!:()=>void;
      const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Read cancelled or timed out.'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
      let result:unknown;try{result=await Promise.race([operation,cancelled]);}finally{signal.removeEventListener('abort',abort);}
      this.active(run);
      if(signal.aborted)throw new Error('Read cancelled or timed out.');
      const latest=this.usage(run.origin)!;const size=Buffer.byteLength(JSON.stringify(result));
      if(size>100*1024-latest.bytes){latest.bytes=100*1024;this.save(run.origin,latest);return failure('byte_budget','Source response exceeded remaining aggregate byte budget and was withheld; coverage is partial.');}
      latest.bytes+=size;this.save(run.origin,latest);
      return {ok:true,untrusted:true,source:grant.kind==='github'?grant:{kind:grant.kind,repositoryId:grant.repositoryId,commit:grant.commit},result,budget:{calls:latest.calls,bytes:latest.bytes,maxCalls:8,maxBytes:100*1024}};
    } catch(error) {this.active(run);return failure(signal.aborted?'cancelled':'source_error',error instanceof Error?error.message.slice(0,1000):'Source could not be read.');}
    finally {clearTimeout(timer);run.concurrent--;}
  }
}
