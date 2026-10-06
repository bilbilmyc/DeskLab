import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Store} from '../../server/store';
import {Lab} from '../../server/lab';
import {executable, run} from '../../server/qemu';
import type {Machine} from '../../shared/types';

await mkdir('.runtime/checks', {recursive: true});
const root = await mkdtemp(resolve('.runtime/checks/restore-process-'));
const img = await executable(process.env.QEMU_TEST_DIR ?? '', true);
assert.ok(img, 'qemu-img is required; this acceptance check must not skip');
const worker = resolve('scripts/checks/restore-points-process-worker.ts'), passed: string[] = [];
async function pattern(path: string, byte: number) {
  await Bun.write(path + '.raw', Buffer.alloc(65536, byte));
  await run(img!, ['convert', '-f', 'raw', '-O', 'qcow2', path + '.raw', path]);
  await run(img!, ['resize', path, '8G']);
}
try {
  for (const action of ['create', 'restore', 'delete']) for (const boundary of ['before-commit', 'after-commit']) {
    const directory = join(root, `${action}-${boundary}`), store = new Store(join(directory, 'data'));
    await store.init(); store.data.settings.qemuPath = process.env.QEMU_TEST_DIR ?? '';
    const vm: Machine = {id: crypto.randomUUID(), name: 'Process recovery fixture', family: 'linux', state: 'stopped', cpus: 1, memory: 512, diskGB: 8, firmware: 'uefi', backingResolved: true, createdAt: new Date().toISOString()};
    store.data.machines.push(vm); await store.save();
    await mkdir(store.managed('machines', vm.id), {recursive: true});
    const lab = new Lab(store), disk = lab.disk(vm.id);
    await pattern(disk, 65); await Bun.write(store.managed('machines', vm.id, 'uefi-initial.fd'), 'EFI A');
    const point = await lab.exclusive(() => lab.restorePoints.create(vm.id, {name: 'Original point'}));
    const original = join(directory, 'expected.qcow2'); await pattern(original, action === 'restore' ? 66 : 65);
    if (action === 'restore') {await pattern(disk, 66); await Bun.write(store.managed('machines', vm.id, 'uefi-initial.fd'), 'EFI B');}
    const child = Bun.spawn([process.execPath, worker, directory, action, boundary, vm.id, point.id], {stdout: 'ignore', stderr: 'pipe'});
    try {
      const until = Date.now() + 60000;
      while (!await Bun.file(join(directory, 'barrier.json')).exists()) {
        if (child.exitCode !== null) throw new Error('Operation failed before barrier: ' + await new Response(child.stderr).text());
        assert.ok(Date.now() < until, 'operation reached commit barrier'); await Bun.sleep(50);
      }
      const barrier = await Bun.file(join(directory, 'barrier.json')).json(); assert.equal(barrier.pid, child.pid);
      child.kill('SIGKILL'); await child.exited;
      await run(process.execPath, [worker, directory, 'recover'], 60000);
      const recovered = await Bun.file(join(directory, 'recovered.json')).json();
      const committed = boundary === 'after-commit';
      assert.equal(recovered.points, action === 'create' && committed ? 2 : action === 'delete' && committed ? 0 : 1);
      const expected = action === 'restore' && committed ? store.managed('machines', vm.id, 'restore-points', point.id, 'disk.qcow2') : original;
      await run(img, ['compare', disk, expected]);
      assert.equal(await Bun.file(store.managed('machines', vm.id, `uefi-${recovered.generation}.fd`)).text(), action === 'restore' && !committed ? 'EFI B' : 'EFI A');
      assert.deepEqual(await readdir(store.managed('transactions')), []);
      const files = await readdir(store.managed('machines', vm.id));
      assert.ok(!files.some(file => /^(?:before-restore|restore)-.*\.qcow2$/.test(file)));
      const points = await readdir(store.managed('machines', vm.id, 'restore-points'));
      assert.ok(!points.some(file => file.startsWith('stage-') || file.startsWith('trash-')));
      passed.push(`${action} ${boundary}: forced process termination, fresh-process recovery, disk/EFI/metadata match`);
      console.log('PASS:', action, boundary);
    } finally {if (child.exitCode === null) child.kill('SIGKILL'); await child.exited;}
  }
} finally {
  await Bun.write(join(root, 'result.json'), JSON.stringify({version: (await Bun.file('package.json').json()).version, bun: Bun.version, passed, complete: passed.length === 6}, null, 2));
}
console.log('Process interruption acceptance:', root);
