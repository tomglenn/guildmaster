import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Evaluated once in the service; freshly evaluated in every worker process.
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=createHash('sha256');
function visit(folder: string) {
  for(const entry of readdirSync(join(root,folder),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const relative=join(folder,entry.name);
    if(entry.isDirectory() && relative!=='web')visit(relative);
    else if(entry.isFile() && entry.name.endsWith('.ts'))hash.update(relative).update(readFileSync(join(root,relative)));
  }
}
visit('');
export const BUILD_ID=hash.digest('hex');
