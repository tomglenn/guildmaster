import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, sep, extname, basename } from 'node:path';
import { AppError, type Quest } from '../domain/types.ts';

const types: Record<string, string> = {
  '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8',
  '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8',
  '.json':'application/json', '.csv':'text/plain; charset=utf-8', '.log':'text/plain; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.pdf':'application/pdf',
};

export async function questFile(quest: Quest, path: string) {
  if (!path || path.includes('\0')) throw new AppError('Invalid file path.');
  const roots = [...new Set([quest.workspacePath, quest.outputPath, ...(quest.workspaces ?? []).map(w=>w.workspacePath), ...(quest.preparedWorkspaces ?? []).flatMap(w=>[w.workspacePath,w.outputPath])].filter((p): p is string=>!!p))];
  // Check canonical paths so symlinks cannot expose files outside this quest.
  const canonicalRoots = (await Promise.all(roots.map(root=>realpath(root).catch(()=>undefined)))).filter((p): p is string=>!!p);
  for (const root of roots) {
    const requested = resolve(root,path);
    if (!roots.some(base=>requested.startsWith(resolve(base)+sep))) continue;
    const file = await realpath(requested).catch(()=>undefined);
    if (!file) continue;
    if (!canonicalRoots.some(base=>file.startsWith(base+sep))) throw new AppError('This file is outside the quest workspace.',403);
    const info = await stat(file);
    if (!info.isFile()) continue;
    if (info.size>25*1024*1024) throw new AppError('This file is too large to open here (25 MB maximum).',413);
    const type = types[extname(file).toLowerCase()];
    return { data:await readFile(file), type:type??'application/octet-stream', download:!type, name:basename(file) };
  }
  throw new AppError('File not found in this quest workspace. It may have been moved or deleted.',404);
}
