import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/service/server.ts';

const authorization='[wait] Generate mockup images for this layout.';
const image={name:'Reference.png',mimeType:'image/png' as const,data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
async function fixture(t:any) {
  // Every service is bound to port 0 with fresh temporary data and fixture workers.
  const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-image-routes-'));
  let app=createApp({dataDir,port:0,models:[],workerPath:resolve('tests/fixtures/worker.ts'),imageGenerationOptions:{fetch:async()=>{throw new Error('Unexpected upstream request in mock test.');}}});
  let address=await app.listen();
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const request=(path:string,token=address.token,input?:unknown)=>fetch(address.url+path,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
  const spec=async(id:string)=>JSON.parse(await readFile(join(dataDir,'runs',app.service.get(id).activeRunId!+'.json'),'utf8'));
  return {dataDir,get app(){return app;},get token(){return address.token;},request,spec,restart:async()=>{await app.close();app=createApp({dataDir,port:0,models:[],workerPath:resolve('tests/fixtures/worker.ts')});address=await app.listen();}};
}

test('image credentials are human-only; dedicated run capabilities exist for GM, leads and delegates and revoke on stop',async t=>{
  const f=await fixture(t);
  const gm=(await f.app.service.guildmaster({message:authorization,workspaceMode:'none',commandId:randomUUID()})).quest;
  const lead=(await f.app.service.create({objective:authorization,workspaceMode:'none',commandId:randomUUID()})).quest;
  const delegate=(await f.app.service.createDelegate(lead.id,{objective:'[wait] Generate mockup images.',commandId:randomUUID()})).agent;
  const specs=await Promise.all([gm,lead,delegate].map(q=>f.spec(q.id)));
  for(const spec of specs) {
    assert.ok(spec.imageToken);assert.notEqual(spec.imageToken,spec.serviceToken);
    assert.equal((await f.request('/api/agent/images',spec.imageToken)).status,200);
    assert.equal((await f.request('/api/settings/images',spec.imageToken)).status,401);
    assert.ok([401,403].includes((await f.request('/api/settings/images',spec.serviceToken)).status));
  }
  assert.equal((await f.request('/api/agent/images')).status,403);
  const settings=await f.request('/api/settings/images',f.token,{enabled:true,apiKey:'fixture-secret',mock:true});
  assert.equal(settings.status,200);assert.deepEqual(await settings.json(),{enabled:true,mock:true,model:'gpt-image-1.5',configured:true,defaultQuality:'auto',defaultSize:'auto' });
  assert.ok(!JSON.stringify(await (await f.request('/api/bootstrap')).json()).includes('fixture-secret'));
  const run=f.app.service.imageTokens.get(specs[2].imageToken)!;
  f.app.service.stopWorker(delegate.id);
  assert.equal(run.controller.signal.aborted,true);
  assert.equal((await f.request('/api/agent/images',specs[2].imageToken)).status,403);
  await f.app.service.action(lead.id,'cancel',{commandId:randomUUID()});
  assert.equal((await f.request('/api/agent/images',specs[1].imageToken)).status,403);
});

test('generated assistant outputs are not copied as image bytes into later delegated instruction snapshots', async t => {
  const f = await fixture(t); f.app.service.schedule = () => {};
  const quest = (await f.app.service.create({ objective: authorization, workspaceMode: 'none', commandId: randomUUID() })).quest;
  f.app.images.saveSettings({ enabled: true, mock: true });
  const output = (await f.app.images.generate(quest, { commandId: 'snapshot:concept', prompt: 'A concept', authorization }))[0];
  f.app.service.prepare(quest, 'Review the saved concepts.', randomUUID());
  quest.status = 'running'; f.app.store.save(quest);
  const delegate = (await f.app.service.createDelegate(quest.id, { objective: 'Review the saved concepts.', commandId: randomUUID() })).agent;
  assert.ok(f.app.store.messages(quest.id).some(message => message.attachments?.some(image => image.id === output.id)));
  assert.ok(f.app.store.messages(delegate.id).every(message => !message.attachments?.length));
  assert.ok(f.app.store.deliveries(delegate.id).every(delivery => !delivery.attachments?.length));
});

test('generation routes isolate conversation references, scope commands, and save downloadable durable images',async t=>{
  const f=await fixture(t);
  await f.request('/api/settings/images',f.token,{enabled:true,mock:true});
  const one=(await f.app.service.create({objective:authorization,images:[image],workspaceMode:'none',commandId:randomUUID()})).quest;
  const two=(await f.app.service.create({objective:authorization,images:[image],workspaceMode:'none',commandId:randomUUID()})).quest;
  const a=await f.spec(one.id),b=await f.spec(two.id);
  const attachment=f.app.store.messages(one.id)[0].attachments![0];
  const generate=(input:Record<string,unknown>,token=a.imageToken)=>f.request('/api/agent/images/generate',token,{commandId:a.runId+':concept',prompt:'A compact layout concept',authorization,...input});
  assert.equal((await generate({commandId:b.runId+':wrong'})).status,403);
  assert.equal((await generate({questId:two.id})).status,400);
  assert.equal((await generate({references:[{imageId:attachment.id}]},b.imageToken)).status,403);
  const cross=await generate({commandId:b.runId+':cross',references:[{imageId:attachment.id}]},b.imageToken);
  assert.equal(cross.status,404);
  const result=await generate({quality:'high',size:'1536x1024',references:[{imageId:attachment.id}]});
  assert.equal(result.status,200,JSON.stringify(await result.clone().json()));
  const output=(await result.json()).outputs[0];assert.equal(output.questId,one.id);
  const duplicate=await generate({quality:'high',size:'1536x1024',references:[{imageId:attachment.id}]});assert.equal(duplicate.status,200);
  assert.equal((await duplicate.json()).outputs[0].id,output.id);
  const listed=await (await f.request('/api/agent/images',a.imageToken)).json();
  assert.equal(listed.outputs.length,1);assert.ok(listed.attachments.some((x:any)=>x.id===attachment.id));
  assert.equal(listed.jobs[0].quality,'high'); assert.equal(listed.jobs[0].size,'1536x1024');
  assert.ok(!('maxOutputs' in listed.settings)); assert.ok(!('maxAttempts' in listed.settings));
  assert.ok(!JSON.stringify(listed).includes('base64'));assert.ok(!JSON.stringify(listed).includes(image.data));
  const path=`/api/quests/${one.id}/images/${output.id}?download=1`;
  assert.equal((await f.request(path,a.imageToken)).status,401);
  assert.equal((await f.request(`/api/quests/${two.id}/images/${output.id}`)).status,404);
  const download=await f.request(path);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')!,/^attachment; filename\*=UTF-8''/);
  const bytes=Buffer.from(await download.arrayBuffer());assert.ok(bytes.length>0);
  await f.restart();
  assert.equal((await f.request('/api/agent/images',a.imageToken)).status,403);
  assert.deepEqual(Buffer.from(await (await f.request(path)).arrayBuffer()),bytes);
  assert.ok(f.app.store.messages(one.id).some(m=>m.attachments?.some(x=>x.id===output.id)));
});
