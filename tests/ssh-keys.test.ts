import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SshKeys} from '../server/ssh-keys';
import {authorizeKeyCommand,sshCommand} from '../shared/ssh';
import {installationRecipe} from '../server/install-recipes';
import {run} from '../server/qemu';
test('generates one private local identity, exposes only public metadata and recovers it',async()=>{
  await mkdir('.runtime/tests',{recursive:true});const root=await mkdtemp(resolve('.runtime/tests','ssh-keys-')),keys=new SshKeys(root);
  const [a,b]=await Promise.all([keys.ensure(),keys.ensure()]);expect(a).toEqual(b);
  expect(a.publicKey.startsWith('ssh-ed25519 ')).toBe(true);expect(a.fingerprint).toMatch(/^SHA256:/);
  expect(JSON.stringify(a)).not.toContain('PRIVATE KEY');
  const privateBefore=await readFile(a.privateKeyPath);
  expect(await new SshKeys(root).ensure()).toEqual(a);expect(await readFile(a.privateKeyPath)).toEqual(privateBefore);
  const pub=await run('ssh-keygen',['-y','-f',a.privateKeyPath]);expect(pub.split(' ').slice(0,2)).toEqual(a.publicKey.split(' ').slice(0,2));
  for(const id of ['ubuntu-server','debian-server','rocky-server']){
    const recipe=installationRecipe(id,{baseUrl:'http://10.0.2.2:12345/install/abc',hostname:'test',sshPublicKey:a.publicKey});
    expect(recipe.files['finish.sh']).toContain(authorizeKeyCommand(a.publicKey));
    expect(recipe.files['finish.sh']).toContain('PermitRootLogin prohibit-password\\nPasswordAuthentication no\\nPubkeyAuthentication yes');
    expect(JSON.stringify(recipe)).not.toContain('PRIVATE KEY');
  }
},20000);
test('public-key authorization cannot carry shell syntax and preserves existing authorized keys',()=>{
  expect(()=>authorizeKeyCommand("ssh-ed25519 AAAA'; rm -rf /")).toThrow();
  expect(sshCommand('127.0.0.1',2222,'root',{publicKey:'public',fingerprint:'fingerprint',privateKeyPath:"D:\\someone's lab\\ssh\\key"})).toContain("'D:\\someone''s lab\\ssh\\key'");
});
