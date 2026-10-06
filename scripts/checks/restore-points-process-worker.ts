import assert from 'node:assert/strict';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {Store} from '../../server/store';
import {Lab} from '../../server/lab';

const [directory, action, boundary, machineId, pointId] = process.argv.slice(2);
const root = resolve(directory), inside = relative(resolve('.runtime/checks'), root);
assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'worker requires isolated check data');
const store = new Store(join(root, 'data')); await store.init();
if (action === 'recover') {
  await Bun.write(join(root, 'recovered.json'), JSON.stringify({points: store.data.machines[0].restorePoints?.length ?? 0, generation: store.data.machines[0].diskGeneration ?? 'initial'}));
} else {
  assert.ok(['create', 'restore', 'delete'].includes(action));
  assert.ok(['before-commit', 'after-commit'].includes(boundary));
  const lab = new Lab(store), save = store.save.bind(store);
  // Stop inside the real operation, after file changes and immediately before or
  // after the actual SQLite commit. Only this test process has the barrier.
  store.save = async () => {
    assert.equal(lab.restorePoints.operation?.stage, 'committing');
    if (boundary === 'after-commit') await save();
    await Bun.write(join(root, 'barrier.json'), JSON.stringify({pid: process.pid, action, boundary}));
    await new Promise<void>(() => {setInterval(() => {}, 1000);});
  };
  await lab.exclusive<unknown>(() => action === 'create' ? lab.restorePoints.create(machineId, {name: 'Interrupted point'}) :
    action === 'restore' ? lab.restorePoints.restore(machineId, pointId, {confirm: true}) : lab.restorePoints.remove(machineId, pointId, {confirm: true}));
  throw new Error('The parent must kill this process at the commit barrier');
}
