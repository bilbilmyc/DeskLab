import { mkdir, readFile, rename, writeFile, readdir, rm, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Machine, Settings, Template } from '../shared/types';
import {MetadataDatabase} from './database';

interface Database {version: 1; settings: Settings; machines: Machine[]; templates: Template[];}
export interface Journal {type: 'reset'|'delete'; kind: 'machines'|'templates'; id: string; transaction: string;}
async function exists(path: string) { try {await access(path); return true;} catch{return false;} }
export class Store {
  data: Database = {version: 1, settings: {qemuPath: '', accelerator: process.platform === 'win32' ? 'whpx' : 'tcg'}, machines: [], templates: []};
  private committed?: Database;
  readonly db:MetadataDatabase;
  constructor(public root: string) { this.root = resolve(root);this.db=new MetadataDatabase(this.root); }
  async init() {
    await mkdir(this.root, {recursive: true});
    this.data=await this.db.init(this.data);
    this.committed = structuredClone(this.data);
    await this.recoverFiles();
    await this.save();
  }
  managed(...parts: string[]) {
    const target = resolve(this.root, ...parts);
    const rel = relative(this.root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('拒绝访问数据目录之外的路径');
    return target;
  }
  async save() {
    try {
      this.db.save(this.data);
      this.committed = structuredClone(this.data);
    } catch (error) { if (this.committed) this.data = structuredClone(this.committed); throw error; }
  }
  async journal(record: Journal) {
    await mkdir(this.managed('transactions'), {recursive:true});
    const file = this.managed('transactions',record.transaction+'.json');
    await writeFile(file+'.tmp',JSON.stringify(record)); await rename(file+'.tmp',file);
  }
  async finishJournal(record: Journal) { await rm(this.managed('transactions',record.transaction+'.json'),{force:true}); }
  async recoverFiles() {
    await mkdir(this.managed('transactions'),{recursive:true});
    for (const file of await readdir(this.managed('transactions'))) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(this.managed('transactions',file),'utf8')) as Journal;
      if (!/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9-]{36}$/.test(record.transaction) || !['machines','templates'].includes(record.kind)) throw new Error('无效的磁盘恢复记录');
      if (record.type === 'delete') {
        const original = this.managed(record.kind,record.id), trash = this.managed('trash',record.transaction);
        const retained = this.data[record.kind].some(x=>x.id===record.id);
        if (await exists(trash)) { if (retained) await rename(trash,original); else await rm(trash,{recursive:true,force:true}); }
      } else if (record.type === 'reset') {
        const vm = this.data.machines.find(x=>x.id===record.id);
        const disk = this.managed('machines',record.id,'disk.qcow2'), previous = this.managed('machines',record.id,'previous.qcow2'), next = this.managed('machines',record.id,'reset.qcow2');
        if (vm?.diskGeneration === record.transaction) { await rm(previous,{force:true}); await rm(next,{force:true}); }
        else { if (await exists(previous)) { await rm(disk,{force:true}); await rename(previous,disk); } await rm(next,{force:true}); }
      } else throw new Error('未知的磁盘恢复操作');
      await this.finishJournal(record);
    }
  }
}
