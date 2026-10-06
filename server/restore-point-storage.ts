import {access, rename, rm} from 'node:fs/promises';
import type {Store} from './store';
import {idInput} from './validation';

export interface RestorePointJournal {
  type: 'restore-point-create' | 'restore-point-delete' | 'restore-point-restore';
  kind: 'machines'; id: string; transaction: string; pointId: string;
  previousGeneration?: string;
}
const exists = (path: string) => access(path).then(() => true).catch(error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
export function pointDirectory(store: Store, machineId: string, pointId: string) {
  return store.managed('machines', idInput.parse(machineId), 'restore-points', idInput.parse(pointId));
}
export async function recoverRestorePoint(store: Store, record: RestorePointJournal) {
  idInput.parse(record.pointId);
  const vm = store.data.machines.find(vm => vm.id === record.id);
  const point = vm?.restorePoints?.find(point => point.id === record.pointId);
  const directory = pointDirectory(store, record.id, record.pointId);
  const stage = store.managed('machines', record.id, 'restore-points', `stage-${record.transaction}`);
  const trash = store.managed('machines', record.id, 'restore-points', `trash-${record.transaction}`);
  if (record.type === 'restore-point-create') {
    if (point && !await exists(directory)) throw new Error('已提交的还原点目录缺失，请保留数据排查');
    if (!point) await rm(directory, {recursive: true, force: true});
    await rm(stage, {recursive: true, force: true});
  } else if (record.type === 'restore-point-delete') {
    if (point && await exists(trash)) await rename(trash, directory);
    // If both locations were externally removed, retain the broken point's
    // metadata so the user can remove it explicitly. The VM disk is unaffected.
    if (!point) await rm(trash, {recursive: true, force: true});
  } else {
    if (record.previousGeneration !== 'initial') idInput.parse(record.previousGeneration);
    const disk = store.managed('machines', record.id, 'disk.qcow2');
    const previous = store.managed('machines', record.id, `before-restore-${record.transaction}.qcow2`);
    const next = store.managed('machines', record.id, `restore-${record.transaction}.qcow2`);
    const variables = store.managed('machines', record.id, `uefi-${record.transaction}.fd`);
    if (vm?.diskGeneration === record.transaction) {
      if (!await exists(disk)) throw new Error('已提交的恢复磁盘缺失，已保留回滚副本');
      await rm(previous, {force: true});
      await rm(store.managed('machines', record.id, `uefi-${record.previousGeneration}.fd`), {force: true});
    } else {
      if (await exists(previous)) {await rm(disk, {force: true}); await rename(previous, disk);}
      await rm(variables, {force: true});
    }
    await rm(next, {force: true});
  }
}
