import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './server.ts';

process.umask(0o077);
const dataDir = resolve(process.env.GUILDMASTER_HOME ?? join(homedir(), '.guildmaster'));
mkdirSync(dataDir,{recursive:true,mode:0o700});
const lockPath = join(dataDir,'service.lock');
function alive(pid: number) { try { process.kill(pid,0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }
try {
  try { const fd=openSync(lockPath,'wx',0o600); closeSync(fd); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid: number;
    try { pid=Number(readFileSync(lockPath,'utf8')); } catch { throw new Error('Cannot inspect the service lock.'); }
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) throw new Error('Another Guildmaster service owns this data directory. Use npm run status.');
    unlinkSync(lockPath); const fd=openSync(lockPath,'wx',0o600); closeSync(fd);
  }
  writeFileSync(lockPath,String(process.pid),{mode:0o600});
  const app=createApp({dataDir,port:Number(process.env.GUILDMASTER_PORT ?? 4173),defaultWorkspace:process.env.GUILDMASTER_WORKSPACE ?? process.cwd()});
  const address=await app.listen();
  writeFileSync(join(dataDir,'service.json'),JSON.stringify({pid:process.pid,url:address.url,dataDir}),{mode:0o600});
  console.log(`Guildmaster is ready at ${address.url}\nData: ${dataDir}`);
  let closing=false;
  const close=async () => { if(closing)return;closing=true;await app.close();try{unlinkSync(lockPath);unlinkSync(join(dataDir,'service.json'));}catch{}process.exit(0); };
  process.on('SIGTERM',close);process.on('SIGINT',close);
} catch (error) {
  try { if(readFileSync(lockPath,'utf8')===String(process.pid))unlinkSync(lockPath); } catch {}
  console.error(error instanceof Error ? error.message : String(error));process.exitCode=1;
}
