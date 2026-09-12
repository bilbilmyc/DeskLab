import { test, expect } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundleDirectory, dataDirectory, systemImages } from '../server/bundle';

async function fixture() {
  await mkdir('.runtime/tests/tests', {recursive:true});
  return mkdtemp(resolve('.runtime/tests/tests', 'bundle-unit-'));
}
test('double-click resolves the bundle beside EXE, independently of working directory', async () => {
  const root = await fixture();
  expect(await bundleDirectory(join(root,'DeskLab.exe'), 'C:/Windows')).toBe(root);
  await Bun.write(join(root,'desklab.bundle.json'), '{"version":1}');
  expect(await bundleDirectory(join(root,'dist','DeskLab.exe'), 'C:/Windows')).toBe(root);
  expect(await bundleDirectory(join(root,'dist','app','DeskLab.exe'), 'C:/Windows')).toBe(root);
  expect(await bundleDirectory('C:/bin/bun.exe',root)).toBe(root);
});
test('installer marker automatically selects adjacent data, without a pre-existing database', async()=>{
  const root=await fixture(), previous=process.env.LAB_DATA_DIR;
  delete process.env.LAB_DATA_DIR;
  try {
    await Bun.write(join(root,'desklab.install.json'),JSON.stringify({version:1,dataDirectory:'data'}));
    expect(await dataDirectory(root,join(root,'DeskLab.exe'))).toBe(join(root,'data'));
    process.env.LAB_DATA_DIR=join(root,'override');
    expect(await dataDirectory(root,join(root,'DeskLab.exe'))).toBe(join(root,'override'));
    delete process.env.LAB_DATA_DIR;
    await Bun.write(join(root,'desklab.install.json'),JSON.stringify({version:1,dataDirectory:'../../outside'}));
    await expect(dataDirectory(root,join(root,'DeskLab.exe'))).rejects.toThrow('配置无效');
  } finally {if(previous===undefined)delete process.env.LAB_DATA_DIR;else process.env.LAB_DATA_DIR=previous;}
});
test('catalog only pairs present ISOs with existing registered template disks', async () => {
  const root = await fixture(), iso = join(root,'iso'), data = join(root,'.data');
  await mkdir(iso);
  const template={id:crypto.randomUUID(),name:'Prepared Ubuntu',family:'ubuntu' as const,diskGB:40,createdAt:new Date().toISOString()};
  await Bun.write(join(iso,'ubuntu.iso'),'iso');
  await Bun.write(join(iso,'extra.iso'),'iso');
  await Bun.write(join(iso,'incomplete.iso.part'),'partial');
  await Bun.write(join(iso,'prepared-images.json'),JSON.stringify({images:[{iso:'ubuntu.iso',name:template.name,templateId:template.id,status:'ready'},{iso:'../escape.iso',name:'invalid',templateId:template.id,status:'ready'}]}));
  let catalog=await systemImages(iso,[template],data);
  expect(catalog).toHaveLength(2);
  expect(catalog.find(x=>x.file==='ubuntu.iso')?.templateId).toBeUndefined();
  await mkdir(join(data,'templates',template.id),{recursive:true});
  await Bun.write(join(data,'templates',template.id,'base.qcow2'),'disk');
  catalog=await systemImages(iso,[template],data);
  expect(catalog.find(x=>x.file==='ubuntu.iso')?.templateId).toBe(template.id);
  expect((await systemImages(iso,[],data)).every(x=>!x.templateId)).toBe(true);
  expect(await systemImages(join(root,'missing'),[],data)).toEqual([]);
});
