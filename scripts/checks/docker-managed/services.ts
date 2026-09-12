import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createSocket} from 'node:dgram';
import {Store} from '../../../server/store';
import {DockerService} from '../../../server/docker/service';
import {ComposeProjects} from '../../../server/docker/compose';
import {freePort} from '../../../server/qemu';
import {storedPorts} from '../../../server/ports';
await mkdir('.runtime/checks/docker-managed',{recursive:true});const root=await mkdtemp(resolve('.runtime/checks/docker-managed/services-'));
const store=new Store(root);await store.init();const docker=new DockerService(store),compose=new ComposeProjects(docker);const checks:string[]=[];
const check=(value:unknown,message:string)=>{assert.ok(value,message);checks.push(message);console.log('PASS '+message);};
async function done(op:{id:string}){for(let i=0;i<3000;i++){const state=docker.operations().find(o=>o.id===op.id);if(state?.state==='failed')throw new Error(state.message);if(state?.state==='succeeded'){await Bun.sleep(100);return state;}await Bun.sleep(200);}throw new Error('operation timeout');}
async function http(port:number){for(let i=0;i<40;i++){try{const response=await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(2000)});if(response.ok)return response.text();}catch{}await Bun.sleep(250);}throw new Error('HTTP not reachable');}
console.log('MANAGED SERVICES '+root);
try {
 await done(docker.managedAction('enable',{memoryMB:2048,cpus:2,diskGB:64}));check(docker.engine()?.kind==='managed','independent engine starts and is selected');
 const port=await freePort();await done(docker.create({name:'desklab-http',image:'busybox:1.37',ports:[{hostPort:port,targetPort:80}],command:['sh','-c','mkdir -p /site; echo independent-engine > /site/index.html; exec httpd -f -p 80 -h /site']}));
 check((await http(port)).includes('independent-engine'),'Windows reaches HTTP through both NAT layers');
 const container=(await docker.snapshot(true)).containers.find(c=>c.name==='desklab-http')!;
 check(container.ports[0].hostPort===port&&container.ports[0].guestPort!==port,'UI exposes the Windows endpoint and stores a separate guest port');
 const udpPort=await new Promise<number>((resolve,reject)=>{const socket=createSocket('udp4');socket.once('error',reject);socket.bind(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});});await done(docker.create({name:'desklab-udp',image:'busybox:1.37',ports:[{hostPort:udpPort,targetPort:9000,protocol:'udp'}],command:['sh','-c','while true; do echo udp-ok | nc -u -l -p 9000; done']}));
 const udp=await new Promise<string>((resolve,reject)=>{const socket=createSocket('udp4');const timer=setTimeout(()=>{socket.close();reject(new Error('UDP timed out'));},5000);socket.once('message',bytes=>{clearTimeout(timer);socket.close();resolve(bytes.toString());});socket.send('ping',udpPort,'127.0.0.1');});check(udp.includes('udp-ok'),'Windows receives UDP through both NAT layers');
 let denied=false;try{await done(docker.create({name:'port-conflict',image:'busybox:1.37',ports:[{hostPort:port,targetPort:80}]}));}catch{denied=true;}check(denied,'duplicate Windows port is rejected');
 const binding=storedPorts(store,container.id)[0];check(binding.appliedState==='applied','mapping application state is persisted');
 await done(docker.control(container.id,'stop'));await docker.managed.stop();check(docker.managed.record()?.state==='stopped','engine stop shuts down its Linux VM');
 const cached=await docker.snapshot(true);check(cached.managed?.engine?.state==='stopped','reading stopped engine does not start it');
 await done(docker.control(container.id,'start'));check((await http(port)).includes('independent-engine'),'container action starts the engine and restores the same host port');
 const composePort=await freePort(),file=join(root,'compose.yaml');
 await Bun.write(file,JSON.stringify({services:{web:{image:'nginx:alpine',ports:[`${composePort}:80`]},db:{image:'redis:7-alpine',volumes:['data:/data']}},volumes:{data:{}}}));
 const project=await compose.import({name:'Managed Compose',filePath:file});await done(compose.control(project.id,'up'));
 check((await http(composePort)).includes('nginx'),'independent Compose publishes Nginx to Windows');
 let redis=(await docker.snapshot(true)).containers.find(c=>c.image==='redis:7-alpine')!;
 await done(docker.exec(redis.id,{command:'redis-cli SET desklab-check persisted && redis-cli SAVE'}));
 await done(compose.control(project.id,'down'));await done(compose.control(project.id,'up'));redis=(await docker.snapshot(true)).containers.find(c=>c.image==='redis:7-alpine')!;
 check((await done(docker.exec(redis.id,{command:'redis-cli GET desklab-check'}))).message.includes('persisted'),'Compose down/up retains database contents in its named volume');
 await docker.shutdown();check(docker.managed.record()?.state==='stopped','application shutdown releases the dedicated VM');
}catch(error){await Bun.write(join(root,'failure.log'),await docker.managed.logs());throw error;}
finally{await docker.managed.stop();await Bun.write(join(root,'report.json'),JSON.stringify({checks,root,record:docker.managed.record()},null,2));}
console.log(JSON.stringify({checks:checks.length,root}));
