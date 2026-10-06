import {z} from 'zod';
import {copyFile, mkdir, open, rename, stat, statfs} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {Lab} from './lab';
import {idInput, label} from './validation';
import {run} from './qemu';
import {pointDirectory, type RestorePointJournal} from './restore-point-storage';
import type {RestorePoint, RestorePointOperation} from '../shared/restore-points';

export const restorePointInput = z.object({name: label}).strict();
export const restoreConfirmation = z.object({confirm: z.literal(true)}).strict();
async function hash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function flush(path: string) {const file = await open(path, 'r+'); try {await file.sync();} finally {await file.close();}}
export async function requireRestoreSpace(directory: string, required: number) {
  if (!Number.isSafeInteger(required) || required < 0) throw new Error('无法确认还原点所需空间');
  const space = await statfs(directory);
  if (Number(space.bavail) * Number(space.bsize) < required + 64 * 1048576) throw new Error('磁盘可用空间不足，请先清理空间；原环境未修改');
}
export class RestorePoints {
  operation?: RestorePointOperation;
  constructor(private lab: Lab) {}
  private stopped(id: string) {
    const vm = this.lab.requireStopped(idInput.parse(id));
    if (vm.state !== 'stopped' || vm.session) throw new Error('请先正常关闭环境，确认进程已退出');
    return vm;
  }
  private ready(id: string) {
    const vm = this.stopped(id);
    if (vm.installation && vm.installation.phase !== 'ready') throw new Error('请先完成自动安装');
    return vm;
  }
  private async performing<T>(machineId: string, kind: RestorePointOperation['kind'], work: () => Promise<T>) {
    if (this.operation) throw new Error('请等待当前还原点操作完成');
    this.operation = {machineId, kind, stage: 'preparing', startedAt: new Date().toISOString()};
    try {return await work();} finally {this.operation = undefined;}
  }
  private stage(stage: RestorePointOperation['stage']) {
    if (this.operation) this.operation = {...this.operation, stage};
  }
  // Callers serialize these methods through Lab.exclusive, including all VM
  // start/reset/delete actions. The disk cannot be reopened during conversion.
  async create(machineId: string, input: unknown) {
    const {name} = restorePointInput.parse(input), vm = this.ready(machineId);
    if (vm.isoPath) throw new Error('请先完成系统安装并弹出 ISO，再创建还原点');
    return this.performing(machineId, 'create', async () => {
      const {img} = await this.lab.tools(), store = this.lab.store;
      const measure = JSON.parse(await run(img, ['measure', '--output=json', '-O', 'qcow2', this.lab.disk(machineId)]));
      await requireRestoreSpace(store.root, measure.required);
      const pointId = crypto.randomUUID(), transaction = crypto.randomUUID();
      const record: RestorePointJournal = {type: 'restore-point-create', kind: 'machines', id: machineId, pointId, transaction};
      const stage = store.managed('machines', machineId, 'restore-points', `stage-${transaction}`);
      await store.journal(record);
      try {
        await mkdir(stage, {recursive: true});
        const disk = join(stage, 'disk.qcow2');
        this.stage('copying');
        await run(img, ['convert', '-f', 'qcow2', '-O', 'qcow2', this.lab.disk(machineId), disk], 600000);
        this.stage('verifying');
        await run(img, ['check', '-f', 'qcow2', disk], 600000);
        const info = JSON.parse(await run(img, ['info', '--output=json', disk]));
        if (info['backing-filename'] || info.format !== 'qcow2' || !Number.isSafeInteger(info['virtual-size']) || info['virtual-size'] <= 0) throw new Error('还原点磁盘未能独立保存');
        await flush(disk);
        const point: RestorePoint = {id: pointId, name, createdAt: new Date().toISOString(), bytes: (await stat(disk)).size, diskGB: Math.ceil(info['virtual-size'] / 1073741824), firmware: vm.firmware ?? 'bios', diskSha256: await hash(disk), sshPublicKey: vm.sshPublicKey, sshKeyFingerprint: vm.sshKeyFingerprint};
        if (point.firmware === 'uefi') {
          const variables = store.managed('machines', machineId, `uefi-${vm.diskGeneration ?? 'initial'}.fd`);
          try {await copyFile(variables, join(stage, 'uefi.fd'));}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
          if (await Bun.file(join(stage, 'uefi.fd')).exists()) {
            await flush(join(stage, 'uefi.fd')); point.uefiSha256 = await hash(join(stage, 'uefi.fd')); point.bytes += (await stat(join(stage, 'uefi.fd'))).size;
          }
        }
        await rename(stage, pointDirectory(store, machineId, pointId));
        vm.restorePoints = [...(vm.restorePoints ?? []), point];
        this.stage('committing');
        await store.save(); this.stage('cleaning'); await store.recoverFiles(); return point;
      } catch (error) {await store.recoverFiles(); throw error;}
    });
  }
  async restore(machineId: string, pointId: string, input: unknown) {
    restoreConfirmation.parse(input);
    const vm = this.ready(machineId), point = vm.restorePoints?.find(point => point.id === idInput.parse(pointId));
    if (!point) throw new Error('此环境的还原点不存在');
    return this.performing(machineId, 'restore', async () => {
      const store = this.lab.store, directory = pointDirectory(store, machineId, pointId);
      const disk = join(directory, 'disk.qcow2'), variables = join(directory, 'uefi.fd');
      this.stage('verifying');
      if (await hash(disk) !== point.diskSha256 || (point.uefiSha256 && await hash(variables) !== point.uefiSha256)) throw new Error('还原点校验失败，原环境未修改');
      await requireRestoreSpace(store.root, point.bytes);
      const transaction = crypto.randomUUID();
      const record: RestorePointJournal = {type: 'restore-point-restore', kind: 'machines', id: machineId, pointId, transaction, previousGeneration: vm.diskGeneration ?? 'initial'};
      const next = store.managed('machines', machineId, `restore-${transaction}.qcow2`);
      const previous = store.managed('machines', machineId, `before-restore-${transaction}.qcow2`);
      await store.journal(record);
      try {
        this.stage('copying');
        await copyFile(disk, next); await flush(next);
        this.stage('verifying');
        if (await hash(next) !== point.diskSha256) throw new Error('恢复副本校验失败，原环境未修改');
        if (point.uefiSha256) {
          const target = store.managed('machines', machineId, `uefi-${transaction}.fd`);
          await copyFile(variables, target); await flush(target);
          if (await hash(target) !== point.uefiSha256) throw new Error('启动信息副本校验失败');
        }
        this.stage('committing');
        await rename(this.lab.disk(machineId), previous); await rename(next, this.lab.disk(machineId));
        Object.assign(vm, {diskGeneration: transaction, diskGB: point.diskGB, firmware: point.firmware, backingTemplateId: undefined, backingResolved: true,
          isoPath: undefined, error: undefined, sshError: undefined, sshPublicKey: point.sshPublicKey, sshKeyFingerprint: point.sshKeyFingerprint, state: 'stopped'});
        await store.save(); this.stage('cleaning'); await store.recoverFiles(); return vm;
      } catch (error) {await store.recoverFiles(); throw error;}
    });
  }
  async remove(machineId: string, pointId: string, input: unknown) {
    restoreConfirmation.parse(input);
    const vm = this.stopped(machineId);
    if (!vm.restorePoints?.some(point => point.id === idInput.parse(pointId))) throw new Error('此环境的还原点不存在');
    return this.performing(machineId, 'delete', async () => {
      const store = this.lab.store, transaction = crypto.randomUUID();
      const directory = pointDirectory(store, machineId, pointId);
      const missing = await stat(directory).then(() => false).catch(error => {
        if (error.code === 'ENOENT') return true;
        throw new Error(`无法访问还原点目录，请关闭占用它的程序后重试（${error.code ?? '未知错误'}）`);
      });
      // A user may be removing a broken point whose files are already gone.
      // Metadata-only deletion needs no filesystem transaction or VM disk access.
      if (missing) {
        vm.restorePoints = vm.restorePoints!.filter(point => point.id !== pointId);
        this.stage('committing');
        await store.save(); return {ok: true};
      }
      const record: RestorePointJournal = {type: 'restore-point-delete', kind: 'machines', id: machineId, pointId, transaction};
      await store.journal(record);
      try {
        await rename(directory, store.managed('machines', machineId, 'restore-points', `trash-${transaction}`));
        vm.restorePoints = vm.restorePoints!.filter(point => point.id !== pointId);
        this.stage('committing');
        await store.save(); this.stage('cleaning'); await store.recoverFiles(); return {ok: true};
      } catch (error) {await store.recoverFiles(); throw error;}
    });
  }
}
