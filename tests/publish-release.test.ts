import {expect,test} from 'bun:test';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {publishRelease} from '../scripts/build/publish-release';

async function fixture(version:string) {
  await mkdir('.runtime/tests',{recursive:true});
  const directory=await mkdtemp(resolve('.runtime/tests/release-'));
  const installer=`DeskLab-Setup-v${version}-windows-x64.exe`;
  const digest=(text:string)=>new Bun.CryptoHasher('sha256').update(text).digest('hex');
  const contents:Record<string,string>={[installer]:'installer','DeskLab.exe':'app','SHA256SUMS.txt':`${digest('installer')}  ${installer}\n${digest('app')}  DeskLab.exe\n`};
  contents['DeskLab-Setup.build.json']=JSON.stringify({appVersion:version,installer:{sha256:digest('installer')},executable:{sha256:digest('app')}});
  for(const [name,text] of Object.entries(contents))await Bun.write(join(directory,name),text);
  return {context:{version,ref:`refs/tags/v${version}`,event:'push',repository:'owner/repo',sha:'a'.repeat(40),runId:'123',directory},assets:Object.entries(contents).map(([name,text])=>({name,state:'uploaded',digest:`sha256:${digest(text)}`}))};
}

for(const version of ['1.0.0-rc1','1.0.0'])test(`publishes ${version} only after all uploaded digests match`,async()=>{
  const {context,assets}=await fixture(version),calls:string[][]=[];
  await publishRelease(context,async args=>{
    calls.push(args);
    if(args.includes('--slurp'))return '[[]]';
    if(args[0]==='release'&&args[1]==='view')return '123';
    if(args[1]==='repos/owner/repo/releases/123')return JSON.stringify({id:123,assets});
    return '';
  });
  expect(calls[1]).toContain('--draft');
  expect(calls[2].slice(0,2)).toEqual(['release','upload']);
  const publish=calls.at(-1)!;
  expect(publish).toContain('PATCH');
  expect(publish).toContain(`prerelease=${version.includes('-')}`);
  expect(publish).toContain(`make_latest=${version.includes('-')?'false':'legacy'}`);
});

test('never publishes a branch or replaces a published release',async()=>{
  const {context}=await fixture('1.0.0-rc1');let calls=0;
  const gh=async()=>{calls++;return '[[{"id":123,"tag_name":"v1.0.0-rc1","draft":false}]]';};
  await expect(publishRelease({...context,ref:'refs/heads/v1.0.0-rc1'},gh)).rejects.toThrow('Only a tag push');
  expect(calls).toBe(0);
  await expect(publishRelease(context,gh)).rejects.toThrow('already published');
  expect(calls).toBe(1);
});

test('bad remote digest leaves the release unpublished',async()=>{
  const {context,assets}=await fixture('1.0.0-rc1'),calls:string[][]=[];
  assets[0].digest='sha256:incorrect';
  await expect(publishRelease(context,async args=>{
    calls.push(args);
    if(args.includes('--slurp'))return '[[]]';
    if(args[0]==='release'&&args[1]==='view')return '123';
    if(args[1]==='repos/owner/repo/releases/123')return JSON.stringify({id:123,assets});
    return '';
  })).rejects.toThrow('GitHub digest mismatch');
  expect(calls.some(args=>args.includes('PATCH'))).toBe(false);
});
