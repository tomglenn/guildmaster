import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, lstat, copyFile, chmod, rm, realpath } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type IsolationRequest, type QuestWorkspace } from '../domain/types.ts';
import { within, scopeGuidance, type GuidanceManifest } from '../engine/guidance.ts';
import { directory, requireWorktreeSource } from './projects.ts';

const exec = promisify(execFile);
const gitQueues = new Map<string, Promise<unknown>>();
export async function gitMutation<T>(source: string, operation: () => Promise<T>): Promise<T> {
  const {stdout} = await exec('git', ['rev-parse', '--git-common-dir'], {cwd:source});
  const key = await realpath(resolve(source, stdout.trim()));
  const task = (gitQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  gitQueues.set(key, task);
  try { return await task; } finally { if (gitQueues.get(key) === task) gitQueues.delete(key); }
}

export function isolationRequests(raw: unknown, workspaces: QuestWorkspace[]): IsolationRequest[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > workspaces.length) throw new AppError('Select repository IDs and exact commit hashes for isolation.');
  const seen = new Set<string>();
  return raw.map(row => {
    if (!row || typeof row !== 'object' || typeof row.repositoryId !== 'string' || seen.has(row.repositoryId) || !workspaces.some(w => w.repositoryId === row.repositoryId)) throw new AppError('Isolated repositories must be distinct and selected for this assignment.');
    if (typeof row.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(row.commit)) throw new AppError('Use an exact full Git commit hash. Resolve branches or remote references before requesting isolation.');
    seen.add(row.repositoryId);
    return {repositoryId:row.repositoryId, commit:row.commit.toLowerCase()};
  });
}

/** Copy only skill bundles. Never copy the checkout, its environment, or dependency trees. */
async function copyBundle(source: string, destination: string, budget: {files:number;bytes:number}) {
  await mkdir(destination, {recursive:true,mode:0o700});
  for (const entry of await readdir(source, {withFileTypes:true})) {
    if (['node_modules','.git','.venv','__pycache__','auth.json','credentials.json'].includes(entry.name) || entry.name.startsWith('.env')) continue;
    const from = join(source,entry.name); const to = join(destination,entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new AppError(`Skill bundle contains a symbolic link: ${from}. Use a self-contained bundle or the shared workspace.`);
    if (++budget.files > 4000 || (budget.bytes += info.isFile() ? info.size : 0) > 32_000_000) throw new AppError('Skill assets exceed the isolated workspace copy limit. Use smaller bundles or a shared workspace.');
    if (info.isDirectory()) await copyBundle(from,to,budget);
    else if (info.isFile()) { await copyFile(from,to); await chmod(to, (info.mode & 0o700) | 0o600); }
  }
}

export async function prepareIsolatedWorkspaces(options: {
  dataDir:string; workspaces:QuestWorkspace[]; requests:IsolationRequest[]; guidance:GuidanceManifest;
  assertActive:()=>void;
}) {
  const {dataDir, requests, assertActive} = options;
  const generation = randomUUID();
  const folder = join(dataDir,'isolated',generation);
  await mkdir(folder,{recursive:true,mode:0o700});
  const created: {source:string;path:string}[] = [];
  // An interrupted preparation stays identifiable and is never mistaken for a saved workspace.
  await writeFile(join(folder,'preparation.json'),JSON.stringify({generation,requests,sources:options.workspaces,state:'preparing'}),{mode:0o600});
  const cleanup = async () => {
    for (const item of [...created].reverse()) await gitMutation(item.source, () => exec('git',['worktree','remove','--force',item.path],{cwd:item.source,timeout:10000}));
    await rm(folder,{recursive:true,force:true});
    await rm(join(dataDir,'guidance',`${generation}.json`),{force:true});
  };
  try {
    const workspaces = structuredClone(options.workspaces);
    const guidance = structuredClone(scopeGuidance(options.guidance,workspaces.map(w=>w.repositoryId)));
    const budget = {files:0,bytes:0};
    for (const request of requests) {
      assertActive();
      const workspace = workspaces.find(w=>w.repositoryId===request.repositoryId)!;
      const originalRoot = workspace.workspacePath;
      const source = directory(workspace.sourcePath);
      if (source !== workspace.sourcePath) throw new AppError('The source repository now points to another location. Restore its saved location before preparing a workspace.',409);
      if (within(folder,source)) throw new AppError('Isolated workspaces require an application data folder outside the source repository.');
      await requireWorktreeSource(source);
      const {stdout} = await exec('git',['rev-parse','--verify',`${request.commit}^{commit}`],{cwd:source,timeout:10000});
      if (stdout.trim() !== request.commit) throw new AppError('The requested object is not the exact commit.');
      const modules = await exec('git',['ls-tree','-r',request.commit],{cwd:source,timeout:10000,maxBuffer:8_000_000});
      if (modules.stdout.split('\n').some(line=>line.startsWith('160000 '))) throw new AppError('This commit contains submodules. Use the existing workspace until isolated submodule setup is supported.');
      const index = String(workspaces.indexOf(workspace));
      const path = join(folder,index,'repo');
      await mkdir(dirname(path),{recursive:true});
      assertActive();
      await gitMutation(source,async()=>{
        assertActive();
        created.push({source,path});
        await exec('git',['-c','core.hooksPath=/dev/null','worktree','add','--detach',path,request.commit],{cwd:source,timeout:30000});
      });
      assertActive();
      workspace.workspacePath = directory(path); workspace.mode = 'worktree'; workspace.commit = request.commit; delete workspace.branch;
      const assets = join(folder,index,'guidance');
      const remapScope = (scope:string) => within(scope,originalRoot) ? join(workspace.workspacePath,relative(originalRoot,scope)) : workspace.workspacePath;
      for (const instruction of guidance.instructions.filter(file=>file.repositoryId===workspace.repositoryId)) instruction.scope = remapScope(instruction.scope);
      const copied = new Set<string>();
      for (const entry of guidance.skills.filter(skill=>skill.repositoryId===workspace.repositoryId)) {
        // A previous isolated assignment can itself be the source of trusted skill assets.
        const base = entry.referenceRoot ?? originalRoot;
        if (!within(entry.skill.baseDir,base)) throw new AppError(`Cannot isolate a skill outside its repository: ${entry.skill.filePath}. Use a shared workspace for this workflow.`);
        const target = join(assets,relative(base,entry.skill.baseDir));
        if (!copied.has(target)) { await copyBundle(entry.skill.baseDir,target,budget); copied.add(target); }
        entry.sourcePath ??= entry.skill.filePath;
        entry.skill.filePath = join(assets,relative(base,entry.skill.filePath));
        entry.skill.baseDir = target;
        entry.referenceRoot = entry.scope ? join(assets,relative(originalRoot,entry.scope)) : assets;
        entry.scope = remapScope(entry.scope ?? originalRoot);
        entry.id = `${entry.id}:${generation.slice(0,8)}`;
        // Preserve the instruction body captured for this assignment, even if the live file changed.
        await writeFile(entry.skill.filePath,entry.content,{mode:0o600});
      }
    }
    const outputPath = join(folder,'output'); await mkdir(outputPath,{mode:0o700});
    await mkdir(join(dataDir,'guidance'),{recursive:true,mode:0o700});
    await writeFile(join(dataDir,'guidance',`${generation}.json`),JSON.stringify(guidance),{mode:0o600});
    assertActive();
    await writeFile(join(folder,'preparation.json'),JSON.stringify({generation,requests,state:'ready',workspaces}),{mode:0o600});
    return {workspaces,guidanceRevision:generation,outputPath,guidance,cleanup};
  } catch (error) {
    try { await cleanup(); } catch { /* Keep the preparation record when Git cleanup fails. Never hide the original error. */ }
    throw error;
  }
}

export async function readGuidance(dataDir:string, revision:string):Promise<GuidanceManifest> {
  return JSON.parse(await readFile(join(dataDir,'guidance',`${revision}.json`),'utf8'));
}
