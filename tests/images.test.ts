import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/service/server.ts';
import {validateImages,imageMessage} from '../src/service/images.ts';
import {MAX_IMAGE_BYTES} from '../src/domain/images.ts';
import {Store} from '../src/service/store.ts';

const image={name:'Reference.png',mimeType:'image/png' as const,data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('image validation bounds size/count and rejects disguised or malformed content',()=>{
  assert.deepEqual(validateImages([image]),[image]);
  assert.equal(imageMessage('',[image]),'Please review the attached image.');
  assert.throws(()=>validateImages(Array(5).fill(image)),/up to 4/);
  assert.throws(()=>validateImages([{...image,mimeType:'image/svg+xml'}]),/PNG/);
  assert.throws(()=>validateImages([{...image,data:'not base64'}]),/PNG/);
  assert.throws(()=>validateImages([{...image,data:Buffer.from('not an image').toString('base64')}]),/format/);
  assert.throws(()=>validateImages([{...image,data:Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')}]),/5 MB/);
});

test('images persist, reach worker specifications, follow delegation, and delete with their owning quest',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-images-'));
  const app=createApp({dataDir,port:0,models:[],workerPath:resolve('tests/fixtures/worker.ts')});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const {url,token}=await app.listen();
  const post=async(path:string,body:unknown,auth=token)=>fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const until=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await sleep(25);}assert.fail('Worker did not reach expected state.');};
  const input={message:'[wait] Review this screen.',images:[image],workspaceMode:'none',commandId:randomUUID()};
  const response=await post('/api/guildmaster',input);assert.equal(response.status,200);
  const gm=(await response.json()).quest;
  await until(()=>app.service.get(gm.id).status==='running'&&!app.store.pendingDeliveries(gm.id).length);
  const attachment=app.store.messages(gm.id)[0].attachments![0];
  const imageUrl=`/api/quests/${gm.id}/images/${attachment.id}`;
  const saved=await fetch(url+imageUrl,{headers:{Authorization:'Bearer '+token}});
  assert.equal(saved.status,200);assert.equal(saved.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()),Buffer.from(image.data,'base64'));
  const reopened = new Store(dataDir);
  try { assert.deepEqual(Buffer.from(reopened.image(gm.id,attachment.id)!.data),Buffer.from(image.data,'base64')); } finally { reopened.close(); }
  assert.equal((await fetch(url+imageUrl)).status,401);
  app.service.gmTokens.set('fixture-agent',gm.id);
  assert.equal((await fetch(url+imageUrl,{headers:{Authorization:'Bearer fixture-agent'}})).status,403);
  const spec=JSON.parse(await readFile(join(dataDir,'runs',app.service.get(gm.id).activeRunId!+'.json'),'utf8'));
  assert.equal(spec.deliveries[0].images[0].data,image.data);
  const again=await post('/api/guildmaster',input);assert.equal(again.status,200);
  assert.equal(app.store.messages(gm.id).length,1);
  const source=app.service.delegationSource(app.service.get(gm.id));
  const quest=(await app.service.create({objective:'[wait] Assess the screen.',workspaceMode:'none',commandId:randomUUID()},'quest',undefined,source)).quest;
  const questImage=app.store.messages(quest.id)[0].attachments![0];
  assert.ok(questImage);assert.notEqual(questImage.id,attachment.id);
  assert.ok(app.store.image(quest.id,questImage.id));
  await until(()=>app.service.get(quest.id).status==='running'&&!app.store.pendingDeliveries(quest.id).length);
  const agent=(await app.service.createDelegate(quest.id,{objective:'Check the layout.',commandId:randomUUID()})).agent;
  assert.equal(app.store.messages(agent.id)[0].attachments!.length,1);
  assert.equal((await fetch(url+`/api/quests/${quest.id}/images/${attachment.id}`,{headers:{Authorization:'Bearer '+token}})).status,404);
  await app.service.action(quest.id,'cancel',{commandId:randomUUID()});
  await until(()=>!app.service.live.has(quest.id)&&!app.service.live.has(agent.id));
  await app.service.action(quest.id,'archive',{commandId:randomUUID()});
  const deleted=await app.archiveStorage.delete([quest.id]);assert.deepEqual(deleted.failed,[]);
  assert.equal(app.store.image(quest.id,questImage.id),undefined);
  assert.ok(app.store.image(gm.id,attachment.id));
  assert.equal((await post('/api/quests/'+gm.id+'/continue',{message:'Bad image',images:[{...image,data:'bad'}],commandId:randomUUID()})).status,400);
  const oversizedTextImage={...image,data:'x'.repeat(150000)};
  assert.equal((await post('/api/guildmaster',{message:'Invalid large image',images:[oversizedTextImage],commandId:randomUUID()})).status,400);
});

test('image replies to a pending question persist as a new durable instruction',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-image-answer-'));
  const app=createApp({dataDir,port:0,models:[],workerPath:resolve('tests/fixtures/worker.ts')});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const {quest}=await app.service.create({objective:'[question] Ask for a reference.',workspaceMode:'none',commandId:randomUUID()});
  for(let i=0;i<200&&!app.store.requests(quest.id).length;i++)await sleep(25);
  const question=app.store.requests(quest.id)[0];assert.ok(question);
  await app.service.answer(question.id,{answer:'Use this layout.',images:[image],commandId:randomUUID()});
  const reply=app.store.messages(quest.id).find(message=>message.id===app.store.getRequest(question.id)?.answerMessageId);
  assert.equal(reply?.attachments?.length,1);
  assert.equal(app.store.deliveries(quest.id).at(-1)?.attachments?.length,1);
});

test('reference images can be added to existing Guildmaster and quest conversations',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-image-followup-'));
  const app=createApp({dataDir,port:0,models:[],workerPath:resolve('tests/fixtures/worker.ts')});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  async function finished(id:string) {
    for(let i=0;i<200;i++){if(app.service.get(id).status==='awaiting_review'&&!app.service.live.has(id))return;await sleep(25);}
    assert.fail('Fixture conversation did not finish.');
  }
  const {quest:gm}=await app.service.guildmaster({message:'Review a layout.',workspaceMode:'none',commandId:randomUUID()});
  await finished(gm.id);
  await app.service.guildmaster({message:'Here is the screen.',images:[image],commandId:randomUUID()});
  assert.equal(app.store.messages(gm.id).at(-1)?.attachments?.length,1);
  await finished(gm.id);
  const {quest}=await app.service.create({objective:'Assess a layout.',workspaceMode:'none',commandId:randomUUID()});
  await finished(quest.id);
  await app.service.continue(quest.id,{message:'',images:[image],commandId:randomUUID()});
  const reply=app.store.messages(quest.id).at(-1)!;
  assert.equal(reply.attachments?.length,1);assert.match(reply.text,/attached image/);
  await finished(quest.id);
  const run=app.store.lastRun(quest.id)!;
  const spec=JSON.parse(await readFile(join(dataDir,'runs',run.id+'.json'),'utf8'));
  assert.equal(spec.deliveries[0].images[0].data,image.data);
});
