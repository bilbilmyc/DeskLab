import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Store} from '../../server/store';
import {DockerService} from '../../server/docker/service';
import {ComposeProjects} from '../../server/docker/compose';
import {dockerRun} from '../../server/docker/cli';
import {freePort} from '../../server/qemu';

await mkdir('.runtime/checks',{recursive:true});const root=await mkdtemp(resolve('.runtime/checks/docker-'));
const store=new Store(root);await store.init();const docker=new DockerService(store),compose=new ComposeProjects(docker);
const context=process.env.DESKLAB_DOCKER_TEST_CONTEXT??'desktop-linux';
const checks:string[]=[];const check=(condition:unknown,message:string)=>{assert.ok(condition,message);checks.push(message);console.log('PASS '+message);};
async function done(operation:{id:string}) {
  for(let i=0;i<1800;i++){const state=docker.operations().find(o=>o.id===operation.id);if(state?.state==='failed')throw new Error(state.message);if(state?.state==='succeeded'){await Bun.sleep(50);return state;}await Bun.sleep(100);}
  throw new Error('Docker operation did not finish');
}
async function http(port:number){for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(2000)});if(r.ok)return r.text();}catch{}await Bun.sleep(200);}throw new Error('Published HTTP service did not respond');}
let projectId='';
try {
  const initial=await docker.connect({context});check(!initial.error,'existing Linux engine connects');
  const external=initial.containers.filter(c=>!c.owned).map(c=>({id:c.id,state:c.state}));
  if(external.length){let rejected=false;try{await done(docker.control(external[0].id,'stop'));}catch{rejected=true;}check(rejected,'external container mutation is rejected');}
  const port=await freePort(),name='desklab-check-'+crypto.randomUUID().slice(0,8);
  await done(docker.create({name,image:'busybox:1.37',memoryMB:64,cpus:0.25,ports:[{hostPort:port,targetPort:80}],command:['sh','-c','mkdir -p /tmp/site; echo desklab-container > /tmp/site/index.html; exec httpd -f -p 80 -h /tmp/site']}));
  const snapshot=await docker.snapshot(true),container=snapshot.containers.find(c=>c.name===name)!;
  check(container?.owned&&container.state==='running','owned container is created and running');
  check((await http(port)).includes('desklab-container'),'Windows loopback reaches the published container port');
  check(container.ports.every(p=>p.hostAddress==='127.0.0.1'),'published ports are loopback-only');
  const output=await done(docker.exec(container.id,{command:'printf command-ok; printf error-stream >&2'}));
  check(output.message.includes('command-ok')&&output.message.includes('error-stream'),'command execution preserves stdout and stderr');
  await done(docker.control(container.id,'stop'));await done(docker.control(container.id,'start'));
  check((await http(port)).includes('desklab-container'),'container stop/start retains its writable data');
  await docker.shutdown();check((await docker.snapshot(true)).containers.find(c=>c.id===container.id)?.state==='exited','application shutdown stops its own workload');
  await done(docker.control(container.id,'delete'));
  check(!(await docker.snapshot(true)).containers.some(c=>c.id===container.id),'stopped container deletes cleanly');
  const composePort=await freePort(),file=join(root,'compose.yaml');
  await Bun.write(file,JSON.stringify({services:{web:{image:'busybox:1.37',command:['sh','-c','mkdir -p /site; test -f /site/index.html || echo persisted-volume > /site/index.html; exec httpd -f -p 80 -h /site'],ports:[`${composePort}:80`],volumes:['content:/site']},worker:{image:'busybox:1.37',command:['sh','-c','echo worker-ready; sleep 3600']}},volumes:{content:{}}},null,2));
  const project=await compose.import({name:'Compose 验证',filePath:file});projectId=project.id;
  await done(compose.control(project.id,'up'));check((await http(composePort)).includes('persisted-volume'),'Compose starts multiple services and publishes loopback port');
  await done(compose.control(project.id,'down'));await done(compose.control(project.id,'up'));
  check((await http(composePort)).includes('persisted-volume'),'Compose down/up preserves the named volume');
  await done(compose.control(project.id,'stop'));await done(compose.control(project.id,'down'));await done(compose.control(project.id,'delete'));
  check(!docker.projects().some(p=>p.id===project.id),'Compose project record deletes after container removal');
  const after=await docker.snapshot(true);check(external.every(old=>after.containers.some(c=>c.id===old.id&&c.state===old.state)),'pre-existing containers remain unchanged');
} finally {
  const ids=(await dockerRun(['--context',context,'ps','-aq','--filter',`label=io.desklab.installation=${docker.instanceId}`]).catch(()=>'')).split(/\s+/).filter(Boolean);
  if(ids.length)await dockerRun(['--context',context,'rm','-f',...ids]);
  // Only this check's own Compose project volumes/networks are eligible for cleanup.
  if(projectId) {
    const projectName=`desklab-${docker.instanceId.slice(0,8)}-${projectId.slice(0,8)}`;
    for(const kind of ['volume','network']){const ids=(await dockerRun(['--context',context,kind,'ls','-q','--filter',`label=com.docker.compose.project=${projectName}`])).split(/\s+/).filter(Boolean);if(ids.length)await dockerRun(['--context',context,kind,'rm',...ids]);}
  }
  await Bun.write(join(root,'report.json'),JSON.stringify({checks,root},null,2));
}
console.log(JSON.stringify({checks:checks.length,root}));
