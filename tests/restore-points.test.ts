import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdir, mkdtemp, rename, readdir, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {Store} from '../server/store';
import {Lab} from '../server/lab';
import {executable, run} from '../server/qemu';
import {pointDirectory, type RestorePointJournal} from '../server/restore-point-storage';
import {restorePointInput, restoreConfirmation, requireRestoreSpace} from '../server/restore-points';
import {processAlive} from '../server/process-lock';
import type {Machine} from '../shared/types';
import type {RestorePoint} from '../shared/restore-points';

async function fixture() {
  await mkdir('.runtime/tests', {recursive: true});
  const root = await mkdtemp(resolve('.runtime/tests/restore-points-'));
  const store = new Store(join(root, 'data')); await store.init();
  const vm: Machine = {id: crypto.randomUUID(), name: '隔离测试', family: 'linux', state: 'stopped', memory: 512, cpus: 1, diskGB: 8, firmware: 'uefi', backingResolved: true, createdAt: new Date().toISOString()};
  store.data.machines.push(vm); await store.save();
  await mkdir(store.managed('machines', vm.id), {recursive: true});
  await Bun.write(store.managed('machines', vm.id, 'disk.qcow2'), 'original');
  await Bun.write(store.managed('machines', vm.id, 'uefi-initial.fd'), 'original EFI');
  return {root, store, vm, lab: new Lab(store)};
}
const pointRecord = (): RestorePoint => ({id: crypto.randomUUID(), name: '测试前', createdAt: new Date().toISOString(), bytes: 100, diskGB: 8, firmware: 'uefi', diskSha256: 'a'.repeat(64)});

test('restore point inputs reject blank names, controls, path injection and unconfirmed destructive actions', () => {
  for (const name of ['', ' ', 'a\nb', 'x'.repeat(65)]) expect(restorePointInput.safeParse({name}).success).toBe(false);
  expect(restorePointInput.safeParse({name: '正常', path: '../outside'}).success).toBe(false);
  for (const input of [{}, {confirm: false}, {confirm: 'true'}]) expect(restoreConfirmation.safeParse(input).success).toBe(false);
});
test('running, uncertain and installing machines cannot produce restore points', async () => {
  const {lab, vm, store} = await fixture();
  vm.state = 'running'; await expect(lab.restorePoints.create(vm.id, {name: '禁止'})).rejects.toThrow('正常关闭');
  vm.state = 'stopped'; vm.session = {qmpPort: 12345, vncPort: 12346};
  await expect(lab.restorePoints.create(vm.id, {name: '禁止'})).rejects.toThrow('正常关闭');
  vm.session = undefined; vm.installation = {recipeId: 'ubuntu-server', phase: 'installing', message: '', startedAt: ''};
  await expect(lab.restorePoints.create(vm.id, {name: '禁止'})).rejects.toThrow('完成自动安装');
  vm.installation = undefined; vm.isoPath = 'external.iso';
  await expect(lab.restorePoints.create(vm.id, {name: '禁止'})).rejects.toThrow('弹出 ISO');
  await expect(lab.restorePoints.restore(vm.id, crypto.randomUUID(), {})).rejects.toThrow();
  expect(await Bun.file(lab.disk(vm.id)).text()).toBe('original');
  await expect(requireRestoreSpace(store.root, Number.MAX_SAFE_INTEGER)).rejects.toThrow('空间不足');
  expect(() => pointDirectory(store, vm.id, '../outside')).toThrow();
});
test('v2 metadata upgrade preserves machines and creates a consistent backup before blocking old executables', async () => {
  const {store, vm} = await fixture();
  store.db.with(db => db.query('PRAGMA user_version=2').run());
  const upgraded = new Store(store.root); await upgraded.init();
  expect(upgraded.data.machines[0].id).toBe(vm.id);
  expect(upgraded.db.with(db => db.query('PRAGMA user_version').get())).toEqual({user_version: 3});
  const copies = (await readdir(join(store.root, 'backups'))).filter(name => name.startsWith('before-restore-points-v3-'));
  expect(copies).toHaveLength(1);
  const backup = new Database(join(store.root, 'backups', copies[0]), {readonly: true});
  try {expect(backup.query('PRAGMA user_version').get()).toEqual({user_version: 2}); expect(backup.query('SELECT id FROM machines').get()).toEqual({id: vm.id});} finally {backup.close();}
  await new Store(store.root).init();
  expect((await readdir(join(store.root, 'backups'))).filter(name => name.startsWith('before-restore-points-v3-'))).toHaveLength(1);
});
for (const committed of [false, true]) test(`interrupted restore point creation ${committed ? 'keeps committed data' : 'removes uncommitted files'}`, async () => {
  const {store, vm} = await fixture(), point = pointRecord(), transaction = crypto.randomUUID();
  const directory = pointDirectory(store, vm.id, point.id);
  await store.journal({type: 'restore-point-create', kind: 'machines', id: vm.id, transaction, pointId: point.id});
  await mkdir(directory, {recursive: true}); await Bun.write(join(directory, 'disk.qcow2'), 'snapshot');
  if (committed) {vm.restorePoints = [point]; await store.save();}
  const restarted = new Store(store.root); await restarted.init(); await restarted.recoverFiles();
  expect(await Bun.file(join(directory, 'disk.qcow2')).exists()).toBe(committed);
  expect(await Bun.file(restarted.managed('machines', vm.id, 'disk.qcow2')).text()).toBe('original');
  expect(await readdir(restarted.managed('transactions'))).toEqual([]);
});
for (const committed of [false, true]) test(`interrupted restore point deletion ${committed ? 'cleans committed trash' : 'restores the directory'}`, async () => {
  const {store, vm} = await fixture(), point = pointRecord(), transaction = crypto.randomUUID();
  const directory = pointDirectory(store, vm.id, point.id), trash = store.managed('machines', vm.id, 'restore-points', `trash-${transaction}`);
  await mkdir(directory, {recursive: true}); await Bun.write(join(directory, 'disk.qcow2'), 'snapshot'); vm.restorePoints = [point]; await store.save();
  await store.journal({type: 'restore-point-delete', kind: 'machines', id: vm.id, transaction, pointId: point.id});
  await rename(directory, trash);
  if (committed) {vm.restorePoints = []; await store.save();}
  const restarted = new Store(store.root); await restarted.init(); await restarted.recoverFiles();
  expect(await Bun.file(join(directory, 'disk.qcow2')).exists()).toBe(!committed);
  expect(await Bun.file(join(trash, 'disk.qcow2')).exists()).toBe(false);
});
for (const phase of ['journal', 'prepared', 'moved', 'replaced', 'committed']) test(`restore interruption at ${phase} keeps disk and EFI in the same generation`, async () => {
  const {store, vm} = await fixture(), transaction = crypto.randomUUID();
  const record: RestorePointJournal = {type: 'restore-point-restore', kind: 'machines', id: vm.id, transaction, pointId: crypto.randomUUID(), previousGeneration: 'initial'};
  const next = store.managed('machines', vm.id, `restore-${transaction}.qcow2`), disk = store.managed('machines', vm.id, 'disk.qcow2');
  await store.journal(record);
  if (phase !== 'journal') {await Bun.write(next, 'replacement'); await Bun.write(store.managed('machines', vm.id, `uefi-${transaction}.fd`), 'replacement EFI');}
  if (['moved', 'replaced', 'committed'].includes(phase)) await rename(disk, store.managed('machines', vm.id, `before-restore-${transaction}.qcow2`));
  if (['replaced', 'committed'].includes(phase)) await rename(next, disk);
  if (phase === 'committed') {vm.diskGeneration = transaction; await store.save();}
  const restarted = new Store(store.root); await restarted.init(); await restarted.recoverFiles();
  expect(await Bun.file(disk).text()).toBe(phase === 'committed' ? 'replacement' : 'original');
  const generation = restarted.data.machines[0].diskGeneration ?? 'initial';
  expect(await Bun.file(restarted.managed('machines', vm.id, `uefi-${generation}.fd`)).text()).toBe(phase === 'committed' ? 'replacement EFI' : 'original EFI');
  expect(await readdir(restarted.managed('transactions'))).toEqual([]);
  expect(await Bun.file(next).exists()).toBe(false);
});

const img = await executable(process.env.QEMU_TEST_DIR ?? '', true);
test.skipIf(!img)('restore point operations expose their commit stage and clear status after success or failure', async () => {
  const {store, lab, vm} = await fixture();
  await rm(lab.disk(vm.id)); await diskWithPattern(lab.disk(vm.id), 'A');
  const save = store.save.bind(store), stages: unknown[] = [];
  store.save = async () => {stages.push({...lab.restorePoints.operation}); await save();};
  const point = await lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'A'}));
  await lab.exclusive(() => lab.restorePoints.restore(vm.id, point.id, {confirm: true}));
  await lab.exclusive(() => lab.restorePoints.remove(vm.id, point.id, {confirm: true}));
  expect(stages).toHaveLength(3);
  for (const [index, kind] of ['create', 'restore', 'delete'].entries()) {
    expect(stages[index]).toMatchObject({machineId: vm.id, kind, stage: 'committing'});
  }
  expect(lab.restorePoints.operation).toBeUndefined();
  store.save = save;
  store.db.with(db => db.exec("CREATE TRIGGER reject_save BEFORE DELETE ON machines BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END"));
  await expect(lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'failed'}))).rejects.toThrow('injected metadata failure');
  expect(lab.restorePoints.operation).toBeUndefined();
}, 60000);
async function diskWithPattern(path: string, letter: string) {
  await Bun.write(path + '.raw', Buffer.alloc(65536, letter.charCodeAt(0)));
  await run(img!, ['convert', '-f', 'raw', '-O', 'qcow2', path + '.raw', path]);
  await run(img!, ['resize', path, '8G']);
  await rm(path + '.raw');
}
test.skipIf(!img)('independent restore points round-trip disk contents and EFI, and deletion preserves other points', async () => {
  const {store, lab, vm, root} = await fixture();
  await diskWithPattern(join(root, 'base.qcow2'), 'A');
  const template = await lab.importTemplate({name: 'base', family: 'linux', firmware: 'uefi', path: join(root, 'base.qcow2')});
  await rm(lab.disk(vm.id)); await run(img!, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', lab.base(template.id), lab.disk(vm.id)]);
  vm.templateId = template.id; vm.backingTemplateId = template.id; await store.save();
  const a = await lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'A'}));
  const aDisk = join(pointDirectory(store, vm.id, a.id), 'disk.qcow2');
  expect(JSON.parse(await run(img!, ['info', '--output=json', aDisk]))['backing-filename']).toBeUndefined();
  await run(img!, ['compare', aDisk, lab.base(template.id)]);
  await diskWithPattern(join(root, 'changed.qcow2'), 'B'); await rm(lab.disk(vm.id)); await rename(join(root, 'changed.qcow2'), lab.disk(vm.id));
  await Bun.write(store.managed('machines', vm.id, 'uefi-initial.fd'), 'B EFI');
  const b = await lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'B'}));
  await lab.exclusive(() => lab.restorePoints.restore(vm.id, a.id, {confirm: true}));
  await run(img!, ['compare', lab.disk(vm.id), lab.base(template.id)]);
  expect(await Bun.file(store.managed('machines', vm.id, `uefi-${vm.diskGeneration}.fd`)).text()).toBe('original EFI');
  expect(vm.backingTemplateId).toBeUndefined(); expect(vm.backingResolved).toBe(true);
  await lab.exclusive(() => lab.restorePoints.restore(vm.id, b.id, {confirm: true}));
  await run(img!, ['compare', lab.disk(vm.id), join(pointDirectory(store, vm.id, b.id), 'disk.qcow2')]);
  expect(await Bun.file(store.managed('machines', vm.id, `uefi-${vm.diskGeneration}.fd`)).text()).toBe('B EFI');
  expect(vm.restorePoints).toHaveLength(2);
  await lab.exclusive(() => lab.restorePoints.remove(vm.id, a.id, {confirm: true}));
  expect(vm.restorePoints?.map(point => point.id)).toEqual([b.id]);
  expect(await Bun.file(aDisk).exists()).toBe(false);
  const restarted = new Store(store.root); await restarted.init(); expect(restarted.data.machines[0].restorePoints?.[0].id).toBe(b.id);
  await lab.exclusive(() => lab.remove(vm.id));
  expect(await Bun.file(join(pointDirectory(store, vm.id, b.id), 'disk.qcow2')).exists()).toBe(false);
}, 60000);
test.skipIf(!img)('corruption and failed metadata writes preserve the current disk and all committed restore points', async () => {
  const {store, lab, vm} = await fixture();
  await rm(lab.disk(vm.id)); await diskWithPattern(lab.disk(vm.id), 'A');
  const point = await lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'A'}));
  const bytes = await Bun.file(lab.disk(vm.id)).bytes();
  store.db.with(db => db.exec("CREATE TRIGGER reject_save BEFORE DELETE ON machines BEGIN SELECT RAISE(ABORT,'test write failure'); END"));
  await expect(lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'failed'}))).rejects.toThrow('test write failure');
  await expect(lab.exclusive(() => lab.restorePoints.restore(vm.id, point.id, {confirm: true}))).rejects.toThrow('test write failure');
  await expect(lab.exclusive(() => lab.restorePoints.remove(vm.id, point.id, {confirm: true}))).rejects.toThrow('test write failure');
  expect(store.data.machines[0].restorePoints).toHaveLength(1);
  expect(await Bun.file(lab.disk(vm.id)).bytes()).toEqual(bytes);
  expect(await Bun.file(store.managed('machines', vm.id, 'uefi-initial.fd')).text()).toBe('original EFI');
  expect(await readdir(store.managed('machines', vm.id, 'restore-points'))).toEqual([point.id]);
  await Bun.write(join(pointDirectory(store, vm.id, point.id), 'disk.qcow2'), 'tampered');
  await expect(lab.exclusive(() => lab.restorePoints.restore(vm.id, point.id, {confirm: true}))).rejects.toThrow('校验失败');
  expect(await Bun.file(lab.disk(vm.id)).bytes()).toEqual(bytes);
}, 60000);
test('pending recovery blocks unsafe direct disk actions until exclusive recovery succeeds', async () => {
  const {store, lab, vm} = await fixture();
  await store.journal({type: 'restore-point-create', kind: 'machines', id: vm.id, transaction: crypto.randomUUID(), pointId: crypto.randomUUID()});
  await expect(lab.start(vm.id)).rejects.toThrow('事务尚未恢复');
  expect(() => lab.requireStopped(vm.id)).toThrow('事务尚未恢复');
  await lab.exclusive(async () => {expect(lab.requireStopped(vm.id).id).toBe(vm.id);});
  expect(store.needsRecovery).toBe(false);
});
test('externally removed committed restore point files stop recovery instead of dropping metadata', async () => {
  const {store, vm} = await fixture(), point = pointRecord();
  vm.restorePoints = [point]; await store.save();
  await store.journal({type: 'restore-point-create', kind: 'machines', id: vm.id, transaction: crypto.randomUUID(), pointId: point.id});
  const restarted = new Store(store.root);
  await expect(restarted.init()).rejects.toThrow('已提交的还原点目录缺失');
  expect(await Bun.file(restarted.managed('machines', vm.id, 'disk.qcow2')).text()).toBe('original');
  expect(await readdir(restarted.managed('transactions'))).toHaveLength(1);
});
test('externally removed committed restore disk keeps the rollback copy and blocks startup', async () => {
  const {store, vm} = await fixture(), transaction = crypto.randomUUID();
  const record: RestorePointJournal = {type: 'restore-point-restore', kind: 'machines', id: vm.id, transaction, pointId: crypto.randomUUID(), previousGeneration: 'initial'};
  await store.journal(record);
  const previous = store.managed('machines', vm.id, `before-restore-${transaction}.qcow2`);
  await Bun.write(previous, 'rollback copy'); await rm(store.managed('machines', vm.id, 'disk.qcow2'));
  vm.diskGeneration = transaction; await store.save();
  const restarted = new Store(store.root);
  await expect(restarted.init()).rejects.toThrow('已提交的恢复磁盘缺失');
  expect(await Bun.file(previous).text()).toBe('rollback copy');
  expect(await Bun.file(store.managed('machines', vm.id, `uefi-initial.fd`)).text()).toBe('original EFI');
  expect(await readdir(restarted.managed('transactions'))).toHaveLength(1);
});
test('a restore point with missing files can be explicitly removed without blocking the VM', async () => {
  const {store, lab, vm} = await fixture(), point = pointRecord();
  vm.restorePoints = [point]; await store.save();
  await store.journal({type: 'restore-point-delete', kind: 'machines', id: vm.id, transaction: crypto.randomUUID(), pointId: point.id});
  await store.recoverFiles();
  expect(vm.restorePoints).toHaveLength(1);
  await lab.exclusive(() => lab.restorePoints.remove(vm.id, point.id, {confirm: true}));
  expect(vm.restorePoints).toEqual([]); expect(store.needsRecovery).toBe(false);
  expect(await Bun.file(lab.disk(vm.id)).text()).toBe('original');
});
test('timed-out image tool calls settle only after their process exits', async () => {
  const {root} = await fixture(), pidFile = join(root, 'tool.pid'), script = join(root, 'tool.ts');
  await Bun.write(script, 'await Bun.write(process.argv[2],String(process.pid));setInterval(()=>{},1000);');
  await expect(run(process.execPath, [script, pidFile], 1500)).rejects.toThrow('超时');
  const pid = Number(await Bun.file(pidFile).text());
  expect(pid).toBeGreaterThan(0); expect(processAlive(pid)).toBe(false);
}, 10000);
test('restore point APIs enforce token, origin, confirmation and ownership without modifying disks', async () => {
  const {root, store, vm} = await fixture(), point = pointRecord();
  vm.restorePoints = [point]; await store.save();
  const child = Bun.spawn([process.execPath, resolve('server/index.ts')], {env: {...process.env, LAB_DATA_DIR: store.root, LAB_PORT: '0', LAB_OPEN: '0', LAB_TRAY: '0'}, stdout: 'ignore', stderr: 'pipe'});
  try {
    let origin = '';
    for (let n = 0; n < 200; n++) {
      try {const instance = await Bun.file(join(store.root, 'instance.json')).json(); origin = `http://127.0.0.1:${instance.port}`; break;} catch {}
      if (child.exitCode !== null) throw new Error('isolated server exited');
      await Bun.sleep(50);
    }
    expect(origin).not.toBe('');
    const state = await (await fetch(origin + '/api/state')).json();
    const request = {method: 'POST', headers: {'Content-Type': 'application/json', 'x-lab-token': state.token}, body: JSON.stringify({confirm: true})};
    const prefix = `/api/machines/${vm.id}/restore-points`;
    for (const route of [prefix, `${prefix}/${point.id}/restore`, `${prefix}/${point.id}/delete`]) {
      expect((await fetch(origin + route, {...request, headers: {'Content-Type': 'application/json'}})).status).toBe(403);
      expect((await fetch(origin + route, {...request, headers: {...request.headers, Origin: 'https://example.com'}})).status).toBe(403);
    }
    for (const action of ['restore', 'delete']) {
      expect((await fetch(`${origin}${prefix}/${point.id}/${action}`, {...request, body: '{}'})).status).toBe(400);
      expect((await fetch(`${origin}${prefix}/${crypto.randomUUID()}/${action}`, request)).status).toBe(400);
    }
    expect(await Bun.file(store.managed('machines', vm.id, 'disk.qcow2')).text()).toBe('original');
    expect((await (await fetch(origin + '/api/state')).json()).machines[0].restorePoints).toHaveLength(1);
    await fetch(origin + '/api/app/quit', request);
    expect(await Promise.race([child.exited, Bun.sleep(10000).then(() => -1)])).toBe(0);
  } finally {if (child.exitCode === null) child.kill(); await child.exited;}
}, 45000);
