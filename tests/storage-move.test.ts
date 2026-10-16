import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rename,rm,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {credentialNamespace} from '../src/connections/credentials.ts';

test('moving a data folder preserves its original OS credential identity',async t=>{
 const root=await mkdtemp(join(tmpdir(),'guildmaster-storage-move-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=join(root,'old'),moved=join(root,'new');
 const expected='guildmaster.connections.'+createHash('sha256').update(original).digest('hex').slice(0,20);
 assert.equal(credentialNamespace(original),expected);
 assert.equal((await stat(join(original,'connections.namespace'))).mode&0o777,0o600);
 await rename(original,moved);
 assert.equal(credentialNamespace(moved),expected);
 assert.equal((await readFile(join(moved,'connections.namespace'),'utf8')).trim(),expected);
 assert.notEqual(credentialNamespace(join(root,'separate')),expected);
});

test('an invalid saved credential identity is rejected instead of silently disconnecting',async t=>{
 const root=await mkdtemp(join(tmpdir(),'guildmaster-storage-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'connections.namespace'),'invalid identity');
 assert.throws(()=>credentialNamespace(root),/saved credential namespace is invalid/);
 assert.equal(await readFile(join(root,'connections.namespace'),'utf8'),'invalid identity');
});
