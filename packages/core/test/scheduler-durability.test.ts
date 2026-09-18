import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { addSchedule, listSchedules, parseCron, schedulesPath } from '../src/scheduler.js';
import { schedulerDbPath } from '../src/scheduler-store.js';

const valid={id:'legacy',cron:'* * * * *',prompt:'fixture',createdAt:'2026-09-18T00:00:00.000Z'};
test('legacy migration rejects malformed jobs without losing the source or committing a partial import', async t=>{
 for(const bad of [[valid,valid],[{...valid,disabled:'false'}],[{...valid,nextRunAt:'invalid'}],[{...valid,cron:'1junk * * * *'}]]){
  const cwd=await mkdtemp(join(tmpdir(),'muster-migration-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const path=schedulesPath(cwd);await mkdir(dirname(path),{recursive:true});const raw=JSON.stringify(bad);await writeFile(path,raw);
  await assert.rejects(listSchedules(cwd),/Malformed schedules file/);
  assert.equal(await readFile(path,'utf8'),raw);
  await writeFile(path,JSON.stringify([valid]));assert.equal((await listSchedules(cwd)).length,1);
  assert.equal((await stat(schedulerDbPath(cwd))).mode & 0o077,0,'database must be private');
 }
 for(const cron of ['1foo * * * *','1-2-3 * * * *','*/2/3 * * * *',',1 * * * *'])assert.throws(()=>parseCron(cron),/Invalid cron/);
});

test('separate processes claim one due occurrence exactly once', async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'muster-schedule-process-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await addSchedule('* * * * *','cross-process fixture',{cwd,now:new Date('2026-09-18T00:00:00Z')});
 const source=`import {runDueSchedules} from ${JSON.stringify(new URL('../src/scheduler.ts',import.meta.url).href)};
 import {writeFile,access,appendFile} from 'node:fs/promises';import {setTimeout as sleep} from 'node:timers/promises';
 const [cwd,actor]=process.argv.slice(1);await writeFile(cwd+'/ready-'+actor,'ready');
 let ready=false;for(let i=0;i<500;i++){try{await access(cwd+'/go');ready=true;break}catch{await sleep(10)}}if(!ready)throw Error('barrier timeout');
 await runDueSchedules(async()=>{await appendFile(cwd+'/calls',actor+'\\n');await sleep(50);return {runId:actor,status:'completed'}},{cwd,now:new Date('2026-09-18T00:01:00Z')});`;
 const children=['a','b'].map(actor=>spawn(process.execPath,['--import','tsx','--input-type=module','-e',source,cwd,actor],{stdio:['ignore','ignore','pipe']}));
 t.after(()=>children.forEach(child=>{if(child.exitCode===null)child.kill();}));
 const done=children.map(child=>new Promise<void>((resolve,reject)=>{let error='';child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error)));}));
 // Attach handlers before the barrier so early child failures are always collected.
 const completion=Promise.all(done);
 let ready=false;for(let i=0;i<500;i++){try{await Promise.all(['a','b'].map(actor=>stat(cwd+'/ready-'+actor)));ready=true;break}catch{await sleep(10)}}
 assert.ok(ready,'both processes reached the claim barrier');await writeFile(cwd+'/go','go');await completion;
 assert.equal((await readFile(cwd+'/calls','utf8')).trim().split('\n').length,1);
 assert.equal((await listSchedules(cwd))[0].lastStatus,'completed');
});
