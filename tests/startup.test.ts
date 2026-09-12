import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {existingInstance} from '../server/startup';

test('an occupied browser port does not make DeskLab exit, and reopening uses the same data instance',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desklab-startup-'));
  const occupied=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('another application')});
  const env={...process.env,LAB_DATA_DIR:root,LAB_PORT:String(occupied.port),LAB_OPEN:'0'};
  const child=Bun.spawn([process.execPath,resolve('server/index.ts')],{env,stdout:'ignore',stderr:'pipe'});
  let second:Bun.Subprocess|undefined;
  try {
    let instance:{pid:number;port:number}|undefined;
    for(let n=0;n<100;n++){
      try{instance=await Bun.file(join(root,'instance.json')).json();if(instance)break;}catch{}
      if(child.exitCode!==null)throw new Error(`DeskLab exited instead of choosing a free port: ${await new Response(child.stderr).text()}`);
      await Bun.sleep(50);
    }
    expect(instance).toBeDefined();expect(instance!.port).not.toBe(occupied.port);
    const origin=`http://127.0.0.1:${instance!.port}`;
    const health=await(await fetch(origin+'/api/health')).json();
    expect(health.pid).toBe(child.pid);expect(health.dataDirectory).toBe(root);
    expect(await(await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe('another application');
    second=Bun.spawn([process.execPath,resolve('server/index.ts')],{env,stdout:'ignore',stderr:'pipe'});
    expect(await Promise.race([second.exited,Bun.sleep(5000).then(()=>-99)])).toBe(0);
    expect((await(await fetch(origin+'/api/health')).json()).pid).toBe(child.pid);
    expect((await Bun.file(join(root,'instance.json')).json()).pid).toBe(child.pid);
    expect((await fetch(origin+'/api/app/quit',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    const state=await(await fetch(origin+'/api/state')).json();
    const browse={method:'POST',headers:{'Content-Type':'application/json','x-lab-token':state.token},body:JSON.stringify({kind:'iso',path:root})};
    const files=await fetch(origin+'/api/files/list',browse);
    expect(files.ok).toBe(true);expect((await files.json()).path).toBe(root);
    expect((await fetch(origin+'/api/files/list',{...browse,headers:{'Content-Type':'application/json'}})).status).toBe(403);
    expect((await fetch(origin+'/api/files/list',{...browse,headers:{...browse.headers,Origin:'https://example.com'}})).status).toBe(403);
    expect((await fetch(origin+'/api/files/list',{...browse,body:JSON.stringify({kind:'iso',path:'relative'})})).status).toBe(400);
    expect((await fetch(origin+'/api/files/pick',{...browse,body:JSON.stringify({kind:'iso'})})).status).toBe(400);
    const quit=await fetch(origin+'/api/app/quit',{method:'POST',headers:{'Content-Type':'application/json','x-lab-token':state.token},body:'{}'});
    expect(quit.ok).toBe(true);
    expect(await Promise.race([child.exited,Bun.sleep(5000).then(()=>-99)])).toBe(0);
    expect(await Bun.file(join(root,'owner.lock')).exists()).toBe(false);
    expect(await Bun.file(join(root,'instance.json')).exists()).toBe(false);
  } finally {
    second?.kill();child.kill();await child.exited;if(second)await second.exited;occupied.stop(true);
    await rm(root,{recursive:true,force:true});
  }
},15000);

test('startup errors leave a readable log and release the data lock',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desklab-startup-error-'));
  await Bun.write(join(root,'lab.json'),'{broken configuration');
  const child=Bun.spawn([process.execPath,resolve('server/index.ts')],{env:{...process.env,LAB_DATA_DIR:root,LAB_PORT:'0',LAB_OPEN:'0'},stdout:'ignore',stderr:'pipe'});
  try {
    expect(await child.exited).toBe(1);
    expect(await Bun.file(join(root,'owner.lock')).exists()).toBe(false);
    expect(await Bun.file(join(root,'logs','startup.log')).text()).toMatch(/JSON|parse/i);
    const stderr=await new Response(child.stderr).text();
    expect(stderr).toContain('DeskLab 启动失败');expect(stderr).toContain('startup.log');
    expect(stderr).not.toContain('Bun v');
  }finally{child.kill();await child.exited;await rm(root,{recursive:true,force:true});}
});

test('instance discovery rejects another data directory, even if the health PID matches',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desklab-instance-'));
  const unrelated=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ok:true,pid:process.pid,dataDirectory:root+'-other'})});
  try {
    await Bun.write(join(root,'owner.lock'),String(process.pid));
    await Bun.write(join(root,'instance.json'),JSON.stringify({version:1,pid:process.pid,port:unrelated.port}));
    expect(await existingInstance(root,unrelated.port!)).toBeUndefined();
  }finally{unrelated.stop(true);await rm(root,{recursive:true,force:true});}
});
