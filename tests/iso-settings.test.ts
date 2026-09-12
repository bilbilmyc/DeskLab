import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Store } from '../server/store';
import { Lab } from '../server/lab';
import { isoSources } from '../server/iso-sources';
import { IsoDownloads, type DownloadProgress } from '../server/iso-downloads';

test('ISO directory changes persist immediately without resetting engine settings', async()=>{
  await mkdir('.runtime/tests/tests',{recursive:true});
  const root=await mkdtemp(resolve('.runtime/tests/tests','iso-settings-')), store=new Store(join(root,'data'));
  await store.init();const fallback=join(root,'original'), chosen=join(root,'my images');await mkdir(fallback);
  store.data.settings={qemuPath:'existing-engine',accelerator:'tcg'};await store.save();
  const lab=new Lab(store,fallback);
  // Host detection is independent of the directory behavior covered here.
  lab.host=async()=>({platform:'win32',arch:'x64',cpu:'test',threads:4,totalMemory:8*1024**3,freeMemory:4*1024**3,qemuFound:false,imageToolFound:false,accelerators:[],dataDirectory:store.root});
  await lab.settings({isoDirectory:chosen});
  await Bun.write(join(chosen,'user supplied.iso'),'fixture installation media');
  expect((await lab.images()).map(item=>item.file)).toEqual(['user supplied.iso']);
  expect(store.data.settings).toEqual({qemuPath:'existing-engine',accelerator:'tcg',isoDirectory:chosen});
  await lab.settings({accelerator:'whpx'});
  expect(lab.isoDirectory()).toBe(chosen);
  const reload=new Store(store.root);await reload.init();expect(new Lab(reload,fallback).isoDirectory()).toBe(chosen);
  await expect(lab.settings({isoDirectory:'relative/path'})).rejects.toThrow('完整路径');
  expect(lab.isoDirectory()).toBe(chosen);
  await lab.settings({isoDirectory:''});expect(lab.isoDirectory()).toBe(fallback);
  await lab.shutdown();await removeFixture(root);
});

test('scan reports missing directories and truncated known ISOs without offering them as ready',async()=>{
  await mkdir('.runtime/tests/tests',{recursive:true});const root=await mkdtemp(resolve('.runtime/tests/tests','iso-scan-')),store=new Store(join(root,'data'));
  await store.init();const directory=join(root,'isos'),lab=new Lab(store,directory);
  let library=await lab.isoLibrary();expect(library.error).toContain('不存在');expect(library.resources).toHaveLength(8);
  await mkdir(directory);await Bun.write(join(directory,isoSources[0].file),'incomplete');
  await Bun.write(join(directory,'downloading.iso.part'),'partial');
  library=await lab.isoLibrary();expect(library.error).toBeUndefined();expect(library.resources[0].issue).toContain('不完整');expect(library.resources[0].isoPath).toBeUndefined();
  expect((await lab.images()).map(item=>item.file)).toEqual([isoSources[0].file]);
  await lab.shutdown();await removeFixture(root);
});

async function removeFixture(root: string) {
  if (!resolve(root).startsWith(resolve('.runtime/tests/tests') + sep)) throw new Error('Fixture cleanup must stay inside .runtime');
  // Bun on Windows can retain a completed file operation until GC; its rm retry
  // options are not sufficient for the resulting transient EBUSY on this host.
  for(let attempt=0;;attempt++){
    try {await rm(root,{recursive:true,force:true});return;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EBUSY'||attempt===5)throw error;Bun.gc(true);await Bun.sleep(100);}
  }
}

async function downloadFixture() {
  await mkdir('.runtime/tests/tests', {recursive:true});
  const root = await mkdtemp(resolve('.runtime/tests/tests', 'iso-settings-download-'));
  const original = join(root, 'original'), chosen = join(root, 'chosen');
  await mkdir(original); await mkdir(chosen);
  const bytes = Buffer.alloc(512 * 1024, 37);
  const requests: {id:string; range:string|null; ifRange:string|null}[] = [];
  const server = Bun.serve({hostname:'127.0.0.1', port:0, fetch(request) {
    const range = request.headers.get('range'), offset = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
    requests.push({id:new URL(request.url).pathname.slice(1), range, ifRange:request.headers.get('if-range')});
    const headers = new Headers({'Content-Length':String(bytes.length - offset), ETag:'"settings-fixture-v1"'});
    if (offset) headers.set('Content-Range', `bytes ${offset}-${bytes.length - 1}/${bytes.length}`);
    let position = offset, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(25);
        if (cancelled) return;
        const next = Math.min(position + 8192, bytes.length);
        controller.enqueue(bytes.subarray(position, next)); position = next;
        if (position === bytes.length) controller.close();
      },
      cancel() { cancelled = true; },
    });
    return new Response(body, {status:offset ? 206 : 200, headers});
  }});
  const store = new Store(join(root, 'data')); await store.init();
  const lab = new Lab(store, original);
  lab.host = async()=>({platform:'win32', arch:'x64', cpu:'test', threads:4, totalMemory:8*1024**3, freeMemory:4*1024**3, qemuFound:false, imageToolFound:false, accelerators:[], dataDirectory:store.root});
  const sources = isoSources.slice(0, 3).map(source=>({id:source.id, file:source.file, url:`${server.url}${source.id}`, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')}));
  const downloads = new IsoDownloads(sources);
  (lab as unknown as {downloads:IsoDownloads}).downloads = downloads;
  return {lab, downloads, original, chosen, sources, requests, async close() {
    try { await lab.shutdown(); }
    finally { await server.stop(true); await removeFixture(root); }
  }};
}

async function waitForDownload(downloads: IsoDownloads, directory: string, id: string, matches: (job:DownloadProgress)=>boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const job = (await downloads.list(directory)).find(item=>item.id === id);
    if (job && matches(job)) return job;
    await Bun.sleep(15);
  }
  throw new Error(`Download state timed out: ${JSON.stringify(await downloads.list(directory))}`);
}

test('directory changes are rejected while downloads run or queue, and allowed after pausing all tasks', async()=>{
  const f = await downloadFixture();
  try {
    for (const source of f.sources) await f.lab.downloadIso(source.id);
    const jobs = await f.downloads.list(f.original);
    expect(jobs.filter(job=>job.status === 'downloading')).toHaveLength(2);
    expect(jobs.find(job=>job.id === f.sources[2].id)?.status).toBe('queued');
    await expect(f.lab.settings({isoDirectory:f.chosen})).rejects.toThrow('请先暂停');
    expect(f.lab.isoDirectory()).toBe(f.original);

    await f.lab.pauseIso(f.sources[2].id);
    await expect(f.lab.settings({isoDirectory:f.chosen})).rejects.toThrow('请先暂停');
    for (const source of f.sources.slice(0, 2)) await f.lab.pauseIso(source.id);
    expect(f.downloads.hasActive()).toBe(false);
    expect(f.requests.some(request=>request.id === f.sources[2].id)).toBe(false);
    await f.lab.settings({isoDirectory:f.chosen});
    expect(f.lab.isoDirectory()).toBe(f.chosen);
    expect((await f.lab.isoLibrary()).resources.every(source=>!source.download)).toBe(true);
  } finally { await f.close(); }
}, 15000);

test('returning to a previous ISO directory restores its paused task and resumes its recorded bytes', async()=>{
  const f = await downloadFixture(), source = f.sources[0];
  try {
    await f.lab.downloadIso(source.id);
    await waitForDownload(f.downloads, f.original, source.id, job=>job.received >= 32768);
    const paused = await f.lab.pauseIso(source.id);
    expect(paused.status).toBe('paused'); expect(paused.received).toBeGreaterThan(0);
    await f.lab.settings({isoDirectory:f.chosen});
    expect((await f.lab.isoLibrary()).resources.find(item=>item.id === source.id)?.download).toBeUndefined();
    await f.lab.settings({isoDirectory:f.original});
    const restored = (await f.lab.isoLibrary()).resources.find(item=>item.id === source.id)?.download;
    expect(restored).toMatchObject({id:source.id, directory:f.original, status:'paused', received:paused.received, total:source.bytes});
    expect(f.requests).toHaveLength(1);

    await f.lab.downloadIso(source.id);
    const completed = await waitForDownload(f.downloads, f.original, source.id, job=>job.status === 'completed');
    expect(completed.verified).toBe(true);
    expect(f.requests[1]).toMatchObject({range:`bytes=${paused.received}-`, ifRange:'"settings-fixture-v1"'});
    expect(await Bun.file(join(f.original, source.file)).exists()).toBe(true);
    expect(await Bun.file(join(f.chosen, source.file)).exists()).toBe(false);
  } finally { await f.close(); }
}, 15000);

test('download shutdown failure still runs the VM shutdown stage and remains visible to the caller', async()=>{
  await mkdir('.runtime/tests/tests', {recursive:true});
  const root = await mkdtemp(resolve('.runtime/tests/tests', 'iso-settings-shutdown-'));
  const store = new Store(join(root, 'data')); await store.init();
  const lab = new Lab(store), events: string[] = [];
  const internals = lab as unknown as {downloads:{shutdown:()=>Promise<void>}; shutdownProcesses:()=>Promise<void>};
  // Only isolate the two cleanup stages here; the existing reboot tests cover
  // real QMP process shutdown. This regression concerns failure propagation.
  internals.downloads = {async shutdown() { events.push('download'); throw new Error('download progress disk disappeared'); }};
  internals.shutdownProcesses = async()=>{ events.push('vm'); };
  try {
    await expect(lab.shutdown()).rejects.toThrow('download progress disk disappeared');
    expect(events).toEqual(['download', 'vm']);
  } finally { await removeFixture(root); }
});
