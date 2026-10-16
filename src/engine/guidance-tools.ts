import { resolve } from 'node:path';
import { Type } from 'typebox';
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WorkerEvent, WorkerSpec } from './protocol.ts';
import { guidanceCatalog, pointerTarget, within, type GuidanceManifest, type GuidanceSkill } from './guidance.ts';

export function guidanceTools(spec: WorkerSpec, manifest: GuidanceManifest, emit: (event: WorkerEvent) => void): ToolDefinition<any>[] {
  const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
  const loaded = new Set(manifest.instructions.filter(file => file.root).map(file => `${file.path}:${file.scope}`));
  const instructions = (path: string, onlyNew = false) => manifest.instructions.filter(file => within(path, file.scope)
    && (!onlyNew || !loaded.has(`${file.path}:${file.scope}`))).map(file => {
      loaded.add(`${file.path}:${file.scope}`);
      emit({ type: 'activity', tool: 'guidance', detail: `Loaded ${file.path} (${file.hash.slice(0, 12)}), scope ${file.scope}.` });
      return `Instructions from ${file.path}, applicable within ${file.scope}:\n${file.content}`;
    }).join('\n\n');
  const activate = (entry: GuidanceSkill, seen = new Set<string>()): string => {
    if (seen.has(entry.id) || seen.size >= 8) throw new Error('Skill reference cycle or excessive pointer depth.');
    seen.add(entry.id);
    emit({ type: 'activity', tool: 'skill', detail: `Loaded ${entry.skill.name} from ${entry.skill.filePath} (${entry.hash.slice(0, 12)}).` });
    const target = pointerTarget(entry);
    const header = `Skill ${entry.id}\nSource: ${entry.sourcePath ?? entry.skill.filePath}\nSkill file: ${entry.skill.filePath}\nRelative file base: ${entry.skill.baseDir}\nRepository working directory: ${entry.scope ?? 'Use the selected repository for project commands.'}\n${entry.referenceRoot ? `Local guidance assets are copied under ${entry.referenceRoot}. Resolve repository-relative skill/script paths there; run scripts by absolute path with the assigned repository as cwd. Do not execute scripts in the original checkout. References outside the copied bundles may require additional files; report missing dependencies.\n` : ''}`;
    if (!target) return header + entry.content;
    const canonical = manifest.skills.find(skill => (skill.skill.filePath === target || skill.sourcePath === target) && skill.repositoryId === entry.repositoryId);
    if (!canonical) throw new Error(`Required skill reference is unavailable: ${target}. Read or repair this reference before continuing the workflow.`);
    return header + entry.content + '\n\nReferenced workflow:\n' + activate(canonical, seen);
  };
  const tools: ToolDefinition<any>[] = [{
    name: 'load_skill', label: 'Load skill',
    description: 'Read a discovered skill and its pointer target before using the workflow. Prefer repository-routed skills over generic shared skills. Call with a query to search shared or repository skills, or without arguments to list the catalog. Loading does not grant additional tools or authorize publication.',
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: 'Exact catalog ID, absolute SKILL.md path, or unambiguous name.' })), query: Type.Optional(Type.String()) }),
    execute: async (_id, args) => {
      const { id, query } = args as {id?:string;query?:string};
      if (!id) return result(JSON.stringify(guidanceCatalog(manifest).filter(entry => !query || `${entry.name} ${entry.description} ${entry.path}`.toLowerCase().includes(query.toLowerCase()))));
      const matches = manifest.skills.filter(entry => entry.id === id || entry.skill.filePath === id || entry.sourcePath === id || (entry.skill.name === id && !manifest.skills.some(other => (other.skill.filePath === pointerTarget(entry) || (other.sourcePath && other.sourcePath === pointerTarget(entry))) && other.repositoryId === entry.repositoryId)));
      if (matches.length !== 1) throw new Error(matches.length ? 'Several skills match. Use the exact catalog ID.' : 'Skill not found in this assignment. Inspect the catalog and report a missing required skill.');
      return result(activate(matches[0]));
    },
  }, {
    name: 'get_project_guidance', label: 'Read project guidance',
    description: 'Load all applicable agent instructions for a file or directory before working there, including shell commands. Paths are resolved against the current workspace. A delegate only receives guidance for its assigned repositories.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, args) => result(instructions(resolve(spec.cwd, (args as {path:string}).path)) || 'No additional instructions were found for this path.'),
  }];
  for (const factory of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition]) {
    const original = factory(spec.cwd) as ToolDefinition<any>;
    if (!spec.tools.includes(original.name)) continue;
    tools.push({ ...original, execute: async (id, args, signal, update, context) => {
      const path = resolve(spec.cwd, String((args as {path:string}).path));
      const guidance = instructions(path, true);
      // Return the new instructions before a mutation, so the agent can revise its intended edit.
      if (guidance && original.name !== 'read') return result(`${guidance}\n\nNo file was changed. Apply these instructions and retry the operation.`);
      const entry = manifest.skills.find(skill => skill.skill.filePath === path || skill.sourcePath === path);
      if (original.name === 'read' && entry) return result([guidance, activate(entry)].filter(Boolean).join('\n\n'));
      const value = await original.execute(id, args, signal, update, context);
      return guidance ? { ...value, content: [...result(guidance).content, ...value.content] } : value;
    } });
  }
  return tools;
}
