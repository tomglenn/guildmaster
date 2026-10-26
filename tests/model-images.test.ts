import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {SessionManager,estimateTokens} from '@earendil-works/pi-coding-agent';
import type {WorkerSpec,WorkerEvent} from '../src/engine/protocol.ts';

// Valid 1233 × 1234 PNGs with identical pixels but different metadata lengths.
// The large image has exactly the decoded byte size of the original incident.
function png(size:number){
 const crc=(data:Buffer)=>{let crc=0xffffffff;for(const byte of data){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
 const chunk=(type:string,data:Buffer)=>{const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(1233,0);header.writeUInt32BE(1234,4);header[8]=8;header[9]=2;
 const start=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((1233*3+1)*1234)))]);
 const end=chunk('IEND',Buffer.alloc(0));const length=Math.max(2,size-start.length-end.length-12);const metadata=Buffer.alloc(length,65);metadata[0]=75;metadata[1]=0;
 return Buffer.concat([start,chunk('tEXt',metadata),end]).toString('base64');
}

test('incident-sized images survive pending input, retained history, model changes and SDK compaction without byte-based blocking', {timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'gm-image-regression-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const agentDir=join(directory,'engine');await mkdir(agentDir);
 await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:'http://fixture.invalid/v1',api:'openai-completions',apiKey:'test-only',models:[
  {id:'vision',name:'Vision',reasoning:false,input:['text','image'],contextWindow:272000,maxTokens:16000},
  {id:'text',name:'Text only',reasoning:false,input:['text'],contextWindow:272000,maxTokens:16000},
 ]}}}));
 await writeFile(join(agentDir,'settings.json'),JSON.stringify({compaction:{keepRecentTokens:200,reserveTokens:16384}}));
 const large={type:'image' as const,mimeType:'image/png' as const,data:png(368979)};
 const small={...large,data:png(6000)};
 assert.equal(large.data.length,491972);
 assert.equal(estimateTokens({role:'user',content:[large],timestamp:0}),estimateTokens({role:'user',content:[small],timestamp:0}));
 async function run(name:string,overrides:Partial<WorkerSpec>={},fail=false){
  const requestsPath=join(directory,name+'-requests.jsonl');
  const spec:WorkerSpec={questId:'images',runId:name,cwd:directory,agentDir,sessionPath:join(directory,name+'.jsonl'),role:'quest',serviceUrl:'http://127.0.0.1:1',serviceToken:'fixture-only',tools:[],prompt:'Inspect the reference',execution:{model:'fixture/vision',reasoning:null},deliveries:[{id:name,kind:'prompt',text:'Inspect the reference',images:[large]}],...overrides};
  const path=join(directory,name+'-spec.json');await writeFile(path,JSON.stringify(spec));
  const child=fork(resolve('src/worker.ts'),[path],{execArgv:['--experimental-strip-types','--import',resolve('tests/fixtures/context-fetch.mjs')],env:{...process.env,PI_CODING_AGENT_DIR:agentDir,GUILDMASTER_TEST_REQUESTS:requestsPath,GUILDMASTER_CONTEXT_FAIL:fail?'overflow':'0'},silent:true});
  const events:WorkerEvent[]=[];let stderr='';child.on('message',(event:WorkerEvent)=>events.push(event));child.stderr?.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);const code=await new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timer);
  const requests=(await readFile(requestsPath,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {code,events,stderr,requests,spec};
 }
 for(const role of ['guildmaster','quest','delegate'] as const){
  const pending=await run(role,{role});assert.equal(pending.code,0,JSON.stringify(pending.events));assert.ok(pending.requests.length>=1);
  assert.ok(JSON.stringify(pending.requests).includes(large.data),'The image reaches the provider unchanged.');
  const resumed=await run(role+'-resume',{role,sessionPath:pending.spec.sessionPath,deliveries:[{id:role+'-next',kind:'prompt',text:'Continue with the retained image'}]});
  assert.equal(resumed.code,0,JSON.stringify(resumed.events));assert.ok(JSON.stringify(resumed.requests).includes(large.data));
 }
 const less=await run('same-pixels',{deliveries:[{id:'small',kind:'prompt',text:'Inspect the reference',images:[small]}]});assert.equal(less.code,0);
 const original=join(directory,'guildmaster.jsonl');const before=await readFile(original,'utf8');
 const incompatible=await run('incompatible',{role:'guildmaster',sessionPath:original,execution:{model:'fixture/text',reasoning:null},deliveries:[{id:'still-pending',kind:'prompt',text:'Keep this instruction'}]});
 assert.equal(incompatible.code,1);assert.equal(incompatible.requests.length,0);assert.ok(!incompatible.events.some(e=>e.type==='delivered'));assert.equal(await readFile(original,'utf8'),before);
 const compactPath=join(directory,'compact.jsonl');const manager=SessionManager.open(compactPath,undefined,directory);manager.appendModelChange('fixture','vision');manager.appendThinkingLevelChange('off');
 for(let i=0;i<5;i++){
  manager.appendMessage({role:'user',content:[{type:'text',text:`Historical requirement ${i}`},large],timestamp:i*2+1});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'Historical work completed.'}],api:'openai-completions',provider:'fixture',model:'vision',stopReason:'stop',timestamp:i*2+2,usage:{input:260000,output:10,cacheRead:0,cacheWrite:0,totalTokens:260010,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 }
 const retained=await readFile(compactPath,'utf8');
 const compacted=await run('compaction',{sessionPath:compactPath,deliveries:[{id:'post-compact',kind:'prompt',text:'Continue after compaction'}]});
 assert.equal(compacted.code,0,JSON.stringify(compacted.events));assert.ok(compacted.requests.length>=2,'SDK summary and task both reach the provider.');
 const after=await readFile(compactPath,'utf8');assert.ok(after.startsWith(retained));assert.match(after,/"type":"compaction"/);
 const overflow=await run('overflow',{},true);assert.equal(overflow.code,1);assert.ok(overflow.events.some(e=>e.type==='error'&&/context/i.test(e.error)));
 assert.ok(overflow.requests.length<8,'There is no additional host retry loop.');
 const mismatch=await run('mixed-build',{buildId:'old-service-build'});assert.equal(mismatch.code,1);assert.equal(mismatch.requests.length,0);assert.ok(mismatch.events.some(e=>e.type==='error'&&/service and worker code differ/.test(e.error)));
});
