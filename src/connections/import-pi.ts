import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SLACK_MCP_URL, validateClientId } from './slack.ts';
import type { SlackConnection } from './types.ts';
export interface ImportCandidate { id:string; name:string; source:string; clientId?:string; restrictions?:SlackConnection['restrictions']; usesClaudeApp?:boolean }
function publicClientId(value:unknown) {try{return validateClientId(value);}catch{return undefined;}}
/** Import data only. No extensions, secret commands, OAuth credentials, or confidential client secrets. */
export async function discoverPiConnections(home=homedir()):Promise<{candidates:ImportCandidate[];warnings:string[]}> {
  const paths=[join(home,'.config/mcp/mcp.json'),join(home,'.pi/agent/mcp.json'),join(home,'.pi/agent/settings.json')];
  const candidates:ImportCandidate[]=[],warnings:string[]=[];
  for(const path of paths) {
    let raw:string;
    try{raw=await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')warnings.push(`Could not read ${path}.`);continue;}
    let data:any;try{if(raw.length>1_000_000)throw new Error();data=JSON.parse(raw);}catch{warnings.push(`Could not parse ${path}. Import accepts JSON configuration only.`);continue;}
    const servers=data?.mcpServers;
    if(!servers||typeof servers!=='object'||Array.isArray(servers))continue;
    for(const [name,value] of Object.entries(servers)) {
      const server=value as any;
      if(!server||server.url!==SLACK_MCP_URL)continue;
      // Imported authentication, headers, commands, and private authentication material are intentionally ignored.
      const strings=(v:unknown)=>Array.isArray(v)&&v.length<=100&&v.every(s=>typeof s==='string'&&s.length<=150)?v as string[]:undefined;
      if((server.includeTools!==undefined&&!strings(server.includeTools))||(server.excludeTools!==undefined&&!strings(server.excludeTools))){warnings.push(`Slack restrictions in ${path} are unsupported. This entry was skipped.`);continue;}
      candidates.push({id:createHash('sha256').update(path+'\0'+name).digest('hex'),name:name.slice(0,100),source:path,clientId:publicClientId(server.oauth?.clientId),restrictions:{include:strings(server.includeTools),exclude:strings(server.excludeTools)}});
    }
  }
  return {candidates,warnings};
}
