import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {Store} from '../../../server/store';
import {DockerService} from '../../../server/docker/service';
import {ComposeProjects} from '../../../server/docker/compose';
import {dockerExecutable,dockerRun} from '../../../server/docker/cli';
import {ensureCredentials} from '../../../server/docker/managed/credentials';
import {findEngineAssets} from '../../../server/docker/managed/assets';
const root=resolve(process.argv[2]??'.runtime/checks/docker-managed/services-QBF0sm');
if(!root.toLowerCase().startsWith(resolve('.runtime/checks/docker-managed').toLowerCase()+'\\'))throw new Error('Only isolated managed-engine check directories are accepted');
process.env.PATH=process.env.SystemRoot+'\\System32';process.env.ProgramFiles=join(root,'no-desktop');
const store=new Store(root);await store.init();const docker=new DockerService(store),compose=new ComposeProjects(docker);const checks:string[]=[];
function check(value:unknown,name:string){assert.ok(value,name);checks.push(name);console.log('PASS '+name);}
async function done(op:{id:string}){for(let i=0;i<3000;i++){const state=docker.operations().find(o=>o.id===op.id);if(state?.state==='failed')throw new Error(state.message);if(state?.state==='succeeded'){await Bun.sleep(100);return state;}await Bun.sleep(200);}throw new Error('Operation timed out');}
async function redis(command:string){const c=(await docker.snapshot(true)).containers.find(c=>c.image==='redis:7-alpine');assert.ok(c);return (await done(docker.exec(c.id,{command}))).message;}
try {
 check(!dockerExecutable(),'system Docker CLI and Desktop fallback are unavailable in this test');
 await docker.managed.start();const project=docker.projects()[0];assert.ok(project);await done(compose.control(project.id,'up'));
 check((await docker.managed.status()).engine!.diskFreeBytes!>0,'guest filesystem free space is read from QEMU Guest Agent');
 await redis('redis-cli SET desklab-check before-backup && redis-cli SAVE');await docker.managed.stop();
 const backup=await docker.backups.create('Database integrity check');check(backup.bytes>0,'full stopped-engine backup is registered');
 await docker.managed.start();await done(compose.control(project.id,'up'));await redis('redis-cli SET desklab-check after-backup && redis-cli SAVE');await docker.managed.stop();
 await docker.backups.restore(backup.id);await docker.managed.start();await done(compose.control(project.id,'up'));
 check((await redis('redis-cli GET desklab-check')).includes('before-backup'),'restoring backup restores the earlier database value');
 const assets=(await findEngineAssets())!,record=docker.managed.record()!,credentials=join(docker.managed.directory(record.id),'credentials'),foreign=await ensureCredentials(join(root,'foreign-credentials'),crypto.randomUUID());
 let rejected=false;try{await dockerRun(['--host',`tcp://127.0.0.1:${record.managementPort}`,'--tlsverify','--tlscacert',join(credentials,'ca.pem'),'--tlscert',join(foreign.directory,'client.pem'),'--tlskey',join(foreign.directory,'client-key.pem'),'info'],10000,false,{executable:join(assets.directory,'tools/docker.exe')});}catch{rejected=true;}check(rejected,'daemon rejects a client certificate from another engine');
 await docker.managed.stop();await docker.backups.rebuild();await done(compose.control(project.id,'up'));
 check((await redis('redis-cli GET desklab-check')).includes('before-backup'),'rebuilding the system disk preserves containerd images and Redis volume');
 await docker.shutdown();check(docker.managed.record()?.state==='stopped','independent engine exits with no system Docker client');
}finally{await docker.managed.stop();await Bun.write(join(root,'backup-report.json'),JSON.stringify({checks},null,2));}
console.log(JSON.stringify({checks:checks.length,root}));
