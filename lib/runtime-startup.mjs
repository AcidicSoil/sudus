// Optional user-owned runtime launcher for the generic System One protocol.
// Model unloading/reloading is handled natively by the configured runtime.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export class RuntimeStartError extends Error {
  constructor(kind) { super(`local runtime: ${kind}`); this.name = 'RuntimeStartError'; this.kind = kind; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pathDefault = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sudus', 'runtimes.json');
const lockDefault = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'sudus', 'launch-locks');
const sameUrl = (x,y) => x === y;
const validName = m => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(m) && !m.includes('://');
const validUrl = endpoint => {
  try { const u=new URL(endpoint);return u.protocol==='http:' && ['127.0.0.1','[::1]'].includes(u.hostname) &&
    u.pathname==='/v1/systemone' && !u.search && !u.hash && !u.password && !u.username; } catch { return false; }
};
const validEntry = item => item && validName(item.model) && validUrl(item.endpoint) &&
  typeof item.executable==='string' && isAbsolute(item.executable) && !item.executable.includes('\0') &&
  Array.isArray(item.args) && item.args.length<=64 && item.args.every(arg=>typeof arg==='string' && arg.length<4096 && !arg.includes('\0')) &&
  Number.isInteger(item.startup_timeout_ms) && item.startup_timeout_ms>=100 && item.startup_timeout_ms<=300000;

async function configuration(path) {
  let info;
  try { info=await stat(path); } catch(e) { if(e.code==='ENOENT')return null; throw new RuntimeStartError('config'); }
  if(!info.isFile() || info.size>65536 || (info.mode & 0o022)) throw new RuntimeStartError('config');
  let data;
  try{data=JSON.parse(await readFile(path,'utf8'))}catch{throw new RuntimeStartError('config')}
  if(data?.version!==1 || !Array.isArray(data.runtimes) || data.runtimes.length>32 || data.runtimes.some(x=>!validEntry(x))) throw new RuntimeStartError('config');
  const seen=new Set();
  for(const runtime of data.runtimes){
    if(seen.has(runtime.endpoint))throw new RuntimeStartError('config');
    seen.add(runtime.endpoint);
  }
  return data.runtimes;
}

async function probe(endpoint,model,fetchImpl) {
  const origin=new URL(endpoint).origin;
  let health;
  try{health=await fetchImpl(`${origin}/health`,{redirect:'error',signal:AbortSignal.timeout(1800)});}catch{return 'offline'}
  if(health.status!==200)return 'loading';
  try{
    const models=await fetchImpl(`${origin}/v1/models`,{redirect:'error',signal:AbortSignal.timeout(1800)});
    if(models.status!==200)return 'loading';
    const data=await models.json();
    const ids=data?.data?.map(x=>x?.id) || [];
    return ids.includes(model)?'ready':'model_mismatch';
  }catch{return 'loading'}
}

export async function ensureRuntime({ model, endpoint, registryPath=pathDefault(), lockDir=lockDefault(),
  fetchImpl=globalThis.fetch, spawnImpl=spawn, pollMs=250 }={}) {
  if(!validName(model) || !validUrl(endpoint))throw new RuntimeStartError('config');
  const configured=await configuration(registryPath);
  if(!configured)return false;
  const runtime=configured.find(item=>item.model===model && sameUrl(item.endpoint,endpoint));
  if(!runtime)return false; // No implicit fallback, downloads, or launches for unregistered models.
  const deadline=Date.now()+runtime.startup_timeout_ms;
  const status=await probe(endpoint,model,fetchImpl);
  if(status==='ready')return true;
  if(status==='model_mismatch')throw new RuntimeStartError('model_mismatch');
  await mkdir(lockDir,{recursive:true,mode:0o700});
  const lock=join(lockDir,createHash('sha256').update(endpoint).digest('hex').slice(0,32)+'.lock');
  let owned=false;
  while(Date.now()<deadline){
    try{await mkdir(lock,{mode:0o700});owned=true;break;}
    catch(e){if(e.code!=='EEXIST')throw new RuntimeStartError('startup');}
    const current=await probe(endpoint,model,fetchImpl);
    if(current==='ready')return true;
    if(current==='model_mismatch')throw new RuntimeStartError('model_mismatch');
    // Recover only abandoned locks older than the entire allowed startup window.
    const info=await stat(lock).catch(()=>null);
    if(info && Date.now()-info.mtimeMs>runtime.startup_timeout_ms+10000)await rm(lock,{recursive:true,force:true});
    await delay(pollMs);
  }
  if(!owned)throw new RuntimeStartError('startup_timeout');
  try{
    // Recheck after acquiring the cross-process lock; another caller may already have launched it.
    const current=await probe(endpoint,model,fetchImpl);
    if(current==='ready')return true;
    if(current==='model_mismatch')throw new RuntimeStartError('model_mismatch');
    if(current==='offline'){
      await mkdir(dirname(lockDir),{recursive:true,mode:0o700});
      const logFile=join(dirname(lockDir),'runtime.log');
      const log=openSync(logFile,'a',0o600);
      let child;
      try{child=spawnImpl(runtime.executable,runtime.args,{shell:false,detached:true,
        stdio:['ignore',log,log],windowsHide:true,
        env:Object.fromEntries(['PATH','HOME','USER','LD_LIBRARY_PATH','CUDA_VISIBLE_DEVICES','HF_HOME','HF_HUB_CACHE','XDG_CACHE_HOME']
          .filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});}
      catch{throw new RuntimeStartError('startup')}
      finally{closeSync(log)}
      let failed=false;
      child.on('error',()=>{failed=true});child.on('exit',()=>{failed=true});
      child.unref();
      while(Date.now()<deadline){
        if(failed)throw new RuntimeStartError('startup');
        const state=await probe(endpoint,model,fetchImpl);
        if(state==='ready')return true;
        if(state==='model_mismatch')throw new RuntimeStartError('model_mismatch');
        await delay(pollMs);
      }
    }else{
      // A service is loading on the target port. Never start a competing server.
      while(Date.now()<deadline){
        const state=await probe(endpoint,model,fetchImpl);
        if(state==='ready')return true;
        if(state==='model_mismatch')throw new RuntimeStartError('model_mismatch');
        await delay(pollMs);
      }
    }
    throw new RuntimeStartError('startup_timeout');
  }finally{await rm(lock,{recursive:true,force:true});}
}
