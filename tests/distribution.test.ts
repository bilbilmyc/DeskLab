import { expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataDirectory } from '../server/bundle';

test('standalone EXE uses user data, preserves portable libraries, and respects an explicit data override', async () => {
  await mkdir('.runtime/tests/tests',{recursive:true});
  const root=await mkdtemp(resolve('.runtime/tests/tests','distribution-unit-'));
  const bundle=join(root,'application'), localData=join(root,'user-local-data');
  const previousData=process.env.LAB_DATA_DIR, previousLocal=process.env.LOCALAPPDATA;
  try {
    delete process.env.LAB_DATA_DIR; process.env.LOCALAPPDATA=localData;
    expect(await dataDirectory(bundle,join(bundle,'DeskLab.exe'))).toBe(join(localData,'DeskLab','data'));
    await mkdir(join(bundle,'.data'),{recursive:true});
    expect(await dataDirectory(bundle,join(bundle,'DeskLab.exe'))).toBe(join(localData,'DeskLab','data'));
    await Bun.write(join(bundle,'.data','lab.json'),'{}');
    expect(await dataDirectory(bundle,join(bundle,'DeskLab.exe'))).toBe(join(bundle,'.data'));
    process.env.LAB_DATA_DIR=join(root,'explicit-library');
    expect(await dataDirectory(bundle,join(bundle,'DeskLab.exe'))).toBe(join(root,'explicit-library'));
  } finally {
    if(previousData===undefined)delete process.env.LAB_DATA_DIR;else process.env.LAB_DATA_DIR=previousData;
    if(previousLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previousLocal;
  }
});

test('Bun development keeps project data without a portable library marker', async () => {
  const previous=process.env.LAB_DATA_DIR;
  try {
    delete process.env.LAB_DATA_DIR;
    const bundle=resolve('.runtime/tests/tests','development-library');
    expect(await dataDirectory(bundle,join(bundle,'bun.exe'))).toBe(join(bundle,'.data'));
  } finally {if(previous===undefined)delete process.env.LAB_DATA_DIR;else process.env.LAB_DATA_DIR=previous;}
});
