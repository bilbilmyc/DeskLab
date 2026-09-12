import {test,expect} from 'bun:test';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {ensureCredentials} from '../../server/docker/managed/credentials';
import {createEngineSeed} from '../../server/docker/managed/seed';
import {extractIsoFiles} from '../../server/install-media';
test('engine credentials have independent trust, correct SAN, and stable identity on reuse',async()=>{
 await mkdir('.runtime/tests/docker-managed',{recursive:true});const root=await mkdtemp(resolve('.runtime/tests/docker-managed/pki-')),id=crypto.randomUUID(),first=await ensureCredentials(join(root,'first'),id),second=await ensureCredentials(join(root,'second'),crypto.randomUUID());
 expect(first.fingerprint).not.toBe(second.fingerprint);expect((await ensureCredentials(first.directory,id)).generation).toBe(first.generation);
 const ca=new X509Certificate(await readFile(join(first.directory,'ca.pem'))),server=new X509Certificate(await readFile(join(first.directory,'server.pem'))),client=new X509Certificate(await readFile(join(first.directory,'client.pem'))),key=createPrivateKey(await readFile(join(first.directory,'client-key.pem')));
 expect(server.verify(ca.publicKey)).toBe(true);expect(server.checkIP('127.0.0.1')).toBe('127.0.0.1');expect(client.publicKey.export({type:'spki',format:'pem'})).toBe(createPublicKey(key).export({type:'spki',format:'pem'}));
 expect(await Bun.file(join(first.directory,'ca-key.pem')).exists()).toBe(false);
 const seed=join(root,'seed.iso'),dataId=crypto.randomUUID();await createEngineSeed(seed,id,dataId,first,false);const output=join(root,'seed');await mkdir(output);await extractIsoFiles(seed,output,[{isoPath:'user-data',outputName:'user-data'}]);const config=JSON.parse((await readFile(join(output,'user-data'),'utf8')).replace(/^#cloud-config\n/,''));
 const script=config.write_files.find((f:any)=>f.path==='/usr/local/sbin/desklab-initialize').content;expect(script).not.toContain('mkfs.ext4');expect(script).toContain(dataId);expect(script).toContain('refusing to format');
 expect(config.write_files.find((f:any)=>f.path==='/etc/containerd/config.toml').content).toContain('/mnt/desklab-data/containerd');expect(config.write_files.some((f:any)=>f.content.includes('BEGIN RSA PRIVATE KEY')&&f.path.includes('client'))).toBe(false);
});
