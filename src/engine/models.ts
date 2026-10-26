import { pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { runtimeOptions } from './settings.ts';

type RuntimeModel = ReturnType<ModelRuntime['getModels']>[number];

/** SDK capability metadata, not permission to select a model or a price promise. */
export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  reasoning: boolean;
  /** Pi controls supported by the installed SDK, including custom thinkingLevelMap. */
  reasoningLevels: string[];
  input: string[];
  contextWindow: number;
  maxTokens: number;
  /** Pi's chat catalog does not declare whether a remote endpoint accepts tools. */
  tools: 'unknown';
}

export function describeModel(model: RuntimeModel, available = true): CatalogModel {
  return {
    id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider,
    available, reasoning: model.reasoning, reasoningLevels: getSupportedThinkingLevels(model),
    input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    tools: 'unknown',
  };
}

export async function listModels(agentDir?: string): Promise<CatalogModel[]> {
  const runtime = await ModelRuntime.create(agentDir ? runtimeOptions(agentDir) : {});
  if (runtime.getError()) throw new Error(runtime.getError());
  return [...runtime.getAvailableSnapshot()]
    .map((model) => describeModel(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify({ models: await listModels(process.argv[2]) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ models: [], error: error instanceof Error ? error.message : String(error) }) + '\n');
  }
}
