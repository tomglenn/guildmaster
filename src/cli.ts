import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const dataDir=resolve(process.env.GUILDMASTER_HOME ?? join(homedir(),'.guildmaster'));
const port=Number(process.env.GUILDMASTER_PORT ?? 4173);
const url=`http://127.0.0.1:${port}`;
const action=process.argv[2] ?? 'start';
function record(): {pid:number;url:string;dataDir:string}|undefined { try{return JSON.parse(readFileSync(join(dataDir,'service.json'),'utf8'));}catch{return undefined;} }
async function healthy(address:string) { try{const r=await fetch(address+'/api/health',{signal:AbortSignal.timeout(1500)});const data=await r.json();return r.ok&&data.dataDir===dataDir;}catch{return false;} }
try {
  if(action==='status') {
    const r=record();console.log(r&&await healthy(r.url)?`Guildmaster is running at ${r.url}\nData: ${dataDir}`:`Guildmaster is stopped.\nData: ${dataDir}`);
  } else if(action==='stop') {
    const r=record();
    if(!r||!await healthy(r.url))console.log('Guildmaster is not running for this data directory.');
    else {process.kill(r.pid,'SIGTERM');console.log('Guildmaster is stopping. Conversations and workspaces remain saved.');}
  } else if(action==='start'||action==='dev') {
    if(action==='start'&&!existsSync(join(root,'dist','index.html'))) {
      console.log('Building the interface…');
      const result=spawnSync(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:root,stdio:'inherit'});
      if(result.status!==0)throw new Error('The GUI build failed. Run npm install, then npm run build.');
    }
    const old=record();
    let serviceUrl=url;
    if(old&&await healthy(old.url)){serviceUrl=old.url;console.log(`Guildmaster is already running at ${old.url}`);}
    else {
      mkdirSync(dataDir,{recursive:true,mode:0o700});
      const logPath=join(dataDir,'service.log');const fd=openSync(logPath,'a',0o600);
      const child=spawn(process.execPath,['--experimental-strip-types',join(root,'src/service/main.ts')],{cwd:root,detached:true,stdio:['ignore',fd,fd],env:{...process.env,GUILDMASTER_HOME:dataDir,GUILDMASTER_PORT:String(port)}});
      let spawnError: Error | undefined;
      child.on('error',error=>{spawnError=error;});
      closeSync(fd);child.unref();
      let ready=false;
      for(let i=0;i<60;i++){if(spawnError)throw spawnError;if(await healthy(url)){ready=true;break;}await new Promise(r=>setTimeout(r,250));}
      if(!ready)throw new Error(`Guildmaster could not start. Read ${logPath}`);
      console.log(`Guildmaster is ready at ${url}\nThe service continues after you close this terminal.\nData: ${dataDir}`);
    }
    if(action==='dev') {
      process.env.GUILDMASTER_API_URL=serviceUrl;
      const {createServer}=await import('vite');
      const dev=await createServer({root,configFile:join(root,'vite.config.ts')});
      try {
        await dev.listen();
        dev.printUrls();
        console.log(`Frontend edits update automatically. Quest service: ${serviceUrl}\nCtrl+C stops the development UI; quests keep running. Backend changes require a service restart.`);
        if(process.env.GUILDMASTER_NO_OPEN!=='1')dev.openBrowser();
        await new Promise<void>(resolve=>{
          const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};
          process.once('SIGINT',stop);process.once('SIGTERM',stop);
        });
      } finally {await dev.close();}
    } else if(process.env.GUILDMASTER_NO_OPEN!=='1') {
      const target=serviceUrl;
      const opener=process.platform==='darwin'?'open':process.platform==='win32'?null:'xdg-open';
      if(opener){const child=spawn(opener,[target],{stdio:'ignore'});child.on('error',()=>{});child.unref();}
    }
  } else throw new Error('Use start, stop, status, or dev.');
} catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
