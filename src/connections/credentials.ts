import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialStore, SlackTokens } from './types.ts';

/** Keep existing keyring entries accessible when the data folder moves. */
export function credentialNamespace(dataDir:string):string {
  const path=join(dataDir,'connections.namespace');
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const legacy='guildmaster.connections.'+createHash('sha256').update(dataDir).digest('hex').slice(0,20);
  try { writeFileSync(path,legacy+'\n',{flag:'wx',mode:0o600}); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error; }
  const namespace=readFileSync(path,'utf8').trim();
  if(!/^guildmaster\.connections\.[a-f0-9]{20}$/.test(namespace))throw new Error('The saved credential namespace is invalid. Restore connections.namespace from your data backup.');
  return namespace;
}

/** Chunking keeps individual values within Windows Credential Manager's size limit. */
export class SystemCredentials implements CredentialStore {
  private namespace: string;
  constructor(dataDir:string) { this.namespace=credentialNamespace(dataDir); }
  private async entry(id:string) {
    const {AsyncEntry}=await import('@napi-rs/keyring');
    return new AsyncEntry(this.namespace,id);
  }
  private async manifest(id:string):Promise<{generation:string;count:number}|undefined> {
    const value=await (await this.entry(id)).getPassword();
    if (!value) return;
    const result=JSON.parse(value);
    if (typeof result.generation!=='string' || !Number.isInteger(result.count) || result.count<1 || result.count>128) throw new Error('Invalid credential record.');
    return result;
  }
  async get(id:string):Promise<SlackTokens|undefined> {
    try {
      const manifest=await this.manifest(id); if(!manifest)return;
      let value='';
      for(let i=0;i<manifest.count;i++) {
        const chunk=await (await this.entry(`${id}:${manifest.generation}:${i}`)).getPassword();
        if(!chunk)throw new Error('Incomplete credentials.'); value+=chunk;
      }
      const tokens=JSON.parse(value);
      if(typeof tokens.accessToken!=='string' || !Array.isArray(tokens.scopes))throw new Error('Invalid credentials.');
      return tokens;
    } catch { throw new Error('The secure credential store could not be read. Unlock your system credential store and reconnect Slack.'); }
  }
  async set(id:string,tokens:SlackTokens):Promise<void> {
    const generation=randomUUID(), chunks=JSON.stringify(tokens).match(/[\s\S]{1,1000}/g)!;
    if(chunks.length>128)throw new Error('Slack credentials exceed the supported size.');
    const written:string[]=[];
    try {
      const old=await this.manifest(id);
      for(let i=0;i<chunks.length;i++) {const key=`${id}:${generation}:${i}`;await (await this.entry(key)).setPassword(chunks[i]);written.push(key);}
      await (await this.entry(id)).setPassword(JSON.stringify({generation,count:chunks.length}));
      if(old)for(let i=0;i<old.count;i++)await (await this.entry(`${id}:${old.generation}:${i}`)).deleteCredential().catch(()=>{});
    } catch {
      for(const key of written)await (await this.entry(key)).deleteCredential().catch(()=>{});
      throw new Error('Slack credentials could not be saved securely. Unlock your system credential store and try again.');
    }
  }
  async delete(id:string):Promise<void> {
    try {
      const manifest=await this.manifest(id);
      if(manifest)for(let i=0;i<manifest.count;i++)await (await this.entry(`${id}:${manifest.generation}:${i}`)).deleteCredential();
      await (await this.entry(id)).deleteCredential();
    } catch { throw new Error('Slack is disconnected, but saved credentials could not be removed. Unlock your system credential store and disconnect again.'); }
  }
}
