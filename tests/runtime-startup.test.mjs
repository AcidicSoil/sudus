import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ensureRuntime, RuntimeStartError } from '../lib/runtime-startup.mjs';

const endpoint='http://127.0.0.1:18889/v1/systemone';
const entry={model:'clef-flash',endpoint,executable:'/usr/bin/llama-server',args:['--alias','clef-flash','--sleep-idle-seconds','900'],startup_timeout_ms:3000};
const response=(status,body)=>({status,json:async()=>body});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(callback,edit={}) {
 const dir=await mkdtemp(join(tmpdir(),'sudus-runtime-test-'));
 const registryPath=join(dir,'runtimes.json');
 await writeFile(registryPath,JSON.stringify({version:1,runtimes:[{...entry,...edit}]}));
 try{return await callback({registryPath,lockDir:join(dir,'locks')})}finally{await rm(dir,{recursive:true,force:true})}
}
function mockService({online=false,model='clef-flash',stuck=false}={}) {
 let active=online,spawned=[];
 const fetchImpl=async(url)=>{
  if(!active)throw Error('offline');
  if(stuck)return response(503,{error:'loading'});
  const route=new URL(url).pathname;
  if(route==='/health')return response(200,{status:'ok'});
  if(route==='/v1/models')return response(200,{data:[{id:model}]});
  throw Error(`unexpected ${route}`);
 };
 const spawnImpl=(file,args,opts)=>{
  spawned.push({file,args,opts});active=true;
  const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
 };
 return {fetchImpl,spawnImpl,spawned};
}
const options=(fixture,service)=>({...fixture,model:'clef-flash',endpoint,fetchImpl:service.fetchImpl,spawnImpl:service.spawnImpl,pollMs:15});

test('unknown model or missing registry does not start anything',async()=>fixture(async fx=>{
 const svc=mockService();
 assert.equal(await ensureRuntime({...options(fx,svc),model:'other-model'}),false);
 assert.equal(await ensureRuntime({...options(fx,svc),registryPath:join(fx.lockDir,'missing')}),false);
 assert.equal(svc.spawned.length,0);
}));

test('healthy server is reused, but mismatched model fails before any launch',async()=>fixture(async fx=>{
 const svc=mockService({online:true});
 assert.equal(await ensureRuntime(options(fx,svc)),true);
 assert.equal(svc.spawned.length,0);
 const wrong=mockService({online:true,model:'wrong'});
 await assert.rejects(ensureRuntime(options(fx,wrong)),e=>e instanceof RuntimeStartError&&e.kind==='model_mismatch');
 assert.equal(wrong.spawned.length,0);
}));

test('starts exactly registered process without shell and verifies model readiness',async()=>fixture(async fx=>{
 const svc=mockService();
 assert.equal(await ensureRuntime(options(fx,svc)),true);
 assert.equal(svc.spawned.length,1);
 assert.equal(svc.spawned[0].file,entry.executable);
 assert.deepEqual(svc.spawned[0].args,entry.args);
 assert.equal(svc.spawned[0].opts.shell,false);
 assert.equal(svc.spawned[0].opts.detached,true);
}));

test('concurrent requests only launch the process once',async()=>fixture(async fx=>{
 const svc=mockService();
 await Promise.all([ensureRuntime(options(fx,svc)),ensureRuntime(options(fx,svc))]);
 assert.equal(svc.spawned.length,1);
}));

test('rejects unsafe or malformed runtime definitions',async()=>fixture(async fx=>{
 const svc=mockService();
 await assert.rejects(ensureRuntime(options(fx,svc)),e=>e instanceof RuntimeStartError&&e.kind==='config');
 assert.equal(svc.spawned.length,0);
},{executable:'sh'}));

test('existing busy port remains untouched; startup timeout fails closed',async()=>fixture(async fx=>{
 const svc=mockService({online:true,stuck:true});
 await assert.rejects(ensureRuntime(options(fx,svc)),e=>e instanceof RuntimeStartError&&e.kind==='startup_timeout');
 assert.equal(svc.spawned.length,0);
},{startup_timeout_ms:300}));
