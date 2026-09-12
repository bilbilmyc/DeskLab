import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Store} from '../../../server/store';
import {ManagedDocker} from '../../../server/docker/managed/engine';
await mkdir('.runtime/checks/docker-managed',{recursive:true});const root=await mkdtemp(resolve('.runtime/checks/docker-managed/bootstrap-'));
const store=new Store(root);await store.init();const managed=new ManagedDocker(store);console.log('BOOTSTRAP '+root);const started=Date.now();
try{await managed.prepare({memoryMB:2048,cpus:2,diskGB:64});console.log('PREPARED');await managed.start();const info=await managed.checked();console.log(JSON.stringify({state:managed.record()?.state,os:info.OperatingSystem,engine:info.ServerVersion,root:info.DockerRootDir,seconds:(Date.now()-started)/1000,compose:await managed.raw(['compose','version'])}));}
catch(error){console.error(await managed.logs());throw error;}
finally{await managed.stop();await Bun.write(join(root,'report.json'),JSON.stringify({record:managed.record(),seconds:(Date.now()-started)/1000},null,2));}
