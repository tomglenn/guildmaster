import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, type Quest } from '../domain/types.ts';
import type { QuestService } from './quests.ts';
import { gitMutation } from './isolated-workspaces.ts';

const exec=promisify(execFile);
const DAY=86_400_000;
const segment=(value:string)=>/^[a-zA-Z0-9_-]+$/.test(value);
const within=(root:string,path:string)=>path===root||path.startsWith(root+sep);
type Policy={retentionDays:number|null;lastCleanupAt?:number;lastDeleted?:number;lastError?:string};
type BatchResult={deleted:string[];failed:{id:string;error:string}[]};

/** Files are removed before records. A failed cleanup retains the archived record for retry. */
export class ArchiveStorage {
  private timer?:ReturnType<typeof setInterval>;
  private cleaning?:Promise<BatchResult>;
  private stopped=false;
  private cleanupError?:string;
  private service:QuestService;
  constructor(service:QuestService){this.service=service;}
  view() {
    const policy=this.service.store.setting<Policy>('storage')??{retentionDays:null};
    return {...policy,lastError:this.cleanupError??policy.lastError,archivedQuests:this.service.store.list().filter(q=>q.kind==='quest'&&q.archivedAt!==undefined).length};
  }
  start() {
    const cleanup=()=>{void this.cleanExpired().catch(()=>{this.cleanupError='Automatic cleanup could not finish. It will retry while Guildmaster is running.';});};
    this.timer=setInterval(cleanup,60*60*1000);this.timer.unref();cleanup();
  }
  async close() {this.stopped=true;if(this.timer)clearInterval(this.timer);await this.cleaning?.catch(()=>{});}
  async savePolicy(days:unknown) {
    if(days!==null&&(!Number.isInteger(days)||Number(days)<1||Number(days)>3650))throw new AppError('Choose a whole number from 1 to 3650 days, or turn automatic deletion off.');
    await this.service.serialize(()=>this.service.store.saveSetting('storage',{...this.view(),retentionDays:days}));
    void this.cleanExpired().catch(()=>{this.cleanupError='Automatic cleanup could not finish. It will retry while Guildmaster is running.';});return this.view();
  }
  cleanExpired(now=Date.now()):Promise<BatchResult> {
    if(this.cleaning)return this.cleaning;
    this.cleaning=(async()=>{
      const result:BatchResult={deleted:[],failed:[]};this.cleanupError=undefined;
      const policy=this.view();if(this.stopped||policy.retentionDays===null)return result;
      const ids=this.service.store.list().filter(q=>q.kind==='quest'&&q.archivedAt!==undefined&&q.archivedAt<=now-policy.retentionDays!*DAY).map(q=>q.id);
      for(const id of ids) {
        if(this.stopped)break;
        // Recheck age and policy inside the same queue used by restore/continue.
        try {const removed=await this.service.serialize(async()=>{
          const current=this.view();const q=this.service.store.get(id);
          if(current.retentionDays===null||!q||q.archivedAt===undefined||q.archivedAt>now-current.retentionDays*DAY)return false;
          await this.remove(id);return true;
        });if(removed)result.deleted.push(id);}catch(error){result.failed.push({id,error:(error as Error).message});}
      }
      this.service.store.saveSetting('storage',{...this.view(),lastCleanupAt:now,lastDeleted:result.deleted.length,lastError:result.failed.length?'Some archived quests could not be deleted. They remain archived and cleanup will retry.':undefined});
      return result;
    })().finally(()=>{this.cleaning=undefined;});
    return this.cleaning;
  }
  async delete(ids:unknown):Promise<BatchResult> {
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||!segment(id)))throw new AppError('Select between 1 and 100 archived quests.');
    const result:BatchResult={deleted:[],failed:[]};
    for(const id of new Set<string>(ids)) {
      try {await this.service.serialize(()=>this.remove(id));result.deleted.push(id);}catch(error){result.failed.push({id,error:(error as Error).message});}
    }
    return result;
  }
  private async remove(id:string) {
    const {store,dataDir}=this.service;const q=store.get(id);
    if(!q)return; // Repeated deletion is harmless.
    if(q.kind!=='quest'||q.archivedAt===undefined||!['accepted','cancelled'].includes(q.status))throw new AppError('Only archived quests can be permanently deleted.',409);
    const all=store.list();const family=all.filter(item=>item.id===id||item.parentQuestId===id);
    if(family.some(item=>this.service.live.has(item.id)||item.activeRunId||['queued','running','waiting','awaiting_input'].includes(item.status)))throw new AppError('This quest still has active work. Wait for it to finish stopping before deleting it.',409);
    const familyIds=new Set(family.map(item=>item.id));const others=all.filter(item=>!familyIds.has(item.id));
    const root=await realpath(dataDir);
    const prefixes=[resolve(dataDir)];
    const aliases=store.setting<unknown>('storage.pathAliases') ?? [];
    if(!Array.isArray(aliases))throw new AppError('The saved storage aliases are invalid. The archived quest was kept.',409);
    for(const alias of aliases) {
      if(typeof alias!=='string'||!isAbsolute(alias)||await realpath(alias).catch(()=>undefined)!==root||!(await lstat(alias)).isSymbolicLink())throw new AppError('A storage compatibility link is missing or changed. Restore it before deleting archived quests.',409);
      prefixes.push(resolve(alias));
    }
    const normalized=(path:string)=>{const value=resolve(path);const prefix=prefixes.find(prefix=>within(prefix,value));return prefix?join(root,relative(prefix,value)):value;};
    const safe=async(path:string)=>{
      const target=resolve(path);if(!within(root,target)||target===root)throw new AppError('Cleanup refused a path outside Guildmaster storage.',409);
      let current=root;
      for(const part of relative(root,target).split(sep)) {
        current=join(current,part);
        try {if((await lstat(current)).isSymbolicLink())throw new AppError('Cleanup found a symbolic link in a storage path. The archived quest was kept.',409);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      }
    };
    const readJson=async(path:string)=>{await safe(path);try{const info=await lstat(path);if(info.size>8_000_000)throw new AppError('A cleanup record is too large. The archived quest was kept.',409);return JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}};
    const paths=(value:unknown):string[]=>{
      if(typeof value==='string')return isAbsolute(value)?[normalized(value)]:[];
      if(!value||typeof value!=='object')return [];
      return Object.entries(value).filter(([key])=>['workspacePath','sourcePath','sessionPath','outputPath','guidancePath','path','workspaces','preparedWorkspaces'].includes(key)||Array.isArray(value)).flatMap(([,entry])=>paths(entry));
    };
    const records=async(quests:Quest[])=>{
      const references=(value:any)=>Object.fromEntries(['workspaceMode','workspacePath','sourcePath','sessionPath','outputPath','guidancePath','guidanceRevision','workspaces','preparedWorkspaces'].map(key=>[key,value[key]]));
      const rows:unknown[]=quests.map(references);
      for(const item of quests)for(const run of store.runs(item.id)) {
        if(!segment(run.id))throw new AppError('Invalid saved run path. The archived quest was kept.',409);
        const spec=await readJson(join(root,'runs',run.id+'.json'));if(spec)rows.push(references(spec));
      }
      return rows;
    };
    const owned=await records(family);const retained=await records(others);
    const keptPaths=[...retained.flatMap(paths),...store.projects().flatMap(project=>project.repositories.map(repo=>normalized(repo.path))),...family.flatMap(item=>item.workspaceMode==='none'?[]:[normalized(item.sourcePath??item.workspacePath)])];
    const protectedPath=(path:string)=>keptPaths.some(kept=>within(path,kept));
    const generations=new Set<string>();const revisions=new Set<string>();
    for(const row of owned) {
      for(const path of paths(row)) {
        const parts=relative(join(root,'isolated'),path).split(sep);
        if(parts.length>=2&&/^[a-f0-9-]{36}$/i.test(parts[0]))generations.add(parts[0]);
        const guidance=relative(join(root,'guidance'),path);
        if(/^[a-zA-Z0-9_-]+\.json$/.test(guidance))revisions.add(guidance.slice(0,-5));
      }
      const revision=(row as Quest).guidanceRevision;if(revision&&segment(revision)){revisions.add(revision);if(/^[a-f0-9-]{36}$/i.test(revision))generations.add(revision);}
    }
    const retainedRevisions=new Set(retained.flatMap(row=>{
      const revision=(row as Quest).guidanceRevision;
      return [...(revision?[revision]:[]),...paths(row).filter(path=>within(join(root,'guidance'),path)).map(path=>relative(join(root,'guidance'),path).replace(/\.json$/,''))];
    }));
    const folders=new Set<string>();const files=new Set<string>();const worktrees=new Map<string,string>();
    for(const item of family) {
      if(!segment(item.id))throw new AppError('Invalid saved quest path.',409);
      for(const directory of ['sessions','workspaces','worktrees']) {
        const folder=join(root,directory,item.id);if(protectedPath(folder))throw new AppError('Another quest or project still uses this quest’s storage. Restore or move that work before deleting it.',409);
        folders.add(folder);
      }
      for(const run of store.runs(item.id))files.add(join(root,'runs',run.id+'.json'));
    }
    // Legacy quest worktrees are recorded in snapshots; generations have their own preparation record.
    for(const row of owned) {
      const add=(value:any)=>{if(value?.mode==='worktree'&&typeof value.workspacePath==='string'&&typeof value.sourcePath==='string'&&[...folders].some(folder=>within(folder,normalized(value.workspacePath))))worktrees.set(normalized(value.workspacePath),value.sourcePath);};
      for(const value of [(row as Quest).workspaces??[],(row as Quest).preparedWorkspaces??[]])value.forEach(add);
      const quest=row as Quest;if(quest.workspaceMode==='worktree')add({...quest,mode:'worktree'});
    }
    for(const generation of generations) {
      const folder=join(root,'isolated',generation);
      if(protectedPath(folder)||retainedRevisions.has(generation))continue;
      const record=await readJson(join(folder,'preparation.json'));
      if(!record){try{await lstat(folder);throw new AppError('An isolated workspace is missing its ownership record. The archived quest was kept.',409);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(record&&(record.generation!==generation||record.state!=='ready'||!Array.isArray(record.workspaces)))throw new AppError('An isolated workspace has an incomplete cleanup record. The archived quest was kept.',409);
      for(const workspace of record?.workspaces??[]) {
        if(workspace.mode!=='worktree')continue;
        if(typeof workspace.workspacePath!=='string'||typeof workspace.sourcePath!=='string')throw new AppError('Invalid isolated workspace ownership record.',409);
        // Older quests can isolate a subset of repositories; the other checkouts stay shared.
        if(!within(folder,normalized(workspace.workspacePath)))continue;
        worktrees.set(normalized(workspace.workspacePath),workspace.sourcePath);
      }
      folders.add(folder);revisions.add(generation);
    }
    for(const revision of revisions)if(!retainedRevisions.has(revision))files.add(join(root,'guidance',revision+'.json'));
    for(const item of family) {
      const folder=join(root,'worktrees',item.id);await safe(folder);
      if(await lstat(folder).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})&&![...worktrees.keys()].some(path=>within(folder,path)))throw new AppError('A worktree folder is missing its ownership record. The archived quest was kept.',409);
    }
    // Validate the entire plan before removing anything. Never follow symlinked storage roots.
    for(const path of [...folders,...files,...worktrees.keys()])await safe(path);
    for(const [path,source] of worktrees) {
      try {await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      const {stdout}=await exec('git',['worktree','list','--porcelain','-z'],{cwd:source,timeout:10000});
      if(!stdout.split('\0').some(line=>line.startsWith('worktree ')&&normalized(line.slice(9))===path))throw new AppError('A saved worktree no longer matches its repository. The archived quest was kept.',409);
    }
    for(const [path,source] of worktrees) {
      try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      await gitMutation(source,()=>exec('git',['-c','core.hooksPath=/dev/null','worktree','remove','--force',path],{cwd:source,timeout:30000}));
    }
    for(const path of folders)await rm(path,{recursive:true,force:true});
    for(const path of files)await rm(path,{force:true});
    store.deleteQuestRecords([...familyIds]);
    for(const item of family)this.service.partialMessages.delete(item.id);
    this.service.changed(id);
  }
}
