import { pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { runtimeOptions } from './settings.ts';

export async function listModels(agentDir?: string): Promise<Array<{ id: string; name: string; provider: string }>> {
  const runtime = await ModelRuntime.create(agentDir ? runtimeOptions(agentDir) : {});
  if (runtime.getError()) throw new Error(runtime.getError());
  return [...runtime.getAvailableSnapshot()]
    .map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify({ models: await listModels(process.argv[2]) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ models: [], error: error instanceof Error ? error.message : String(error) }) + '\n');
  }
}
