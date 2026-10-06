// Cross-version acceptance: a metadata database written by the real previous
// release code (git tag below) must upgrade to schema v3 with a consistent
// backup, must recover a pending v1.1.0 disk journal, and must then be rejected
// by that previous release's own code. Requires the tag in the local clone;
// this acceptance check must not skip.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Database} from 'bun:sqlite';
import {Store} from '../../server/store';
import type {Machine, Template} from '../../shared/types';

const tag = 'v1.1.0';
await mkdir('.runtime/checks', {recursive: true});
const root = await mkdtemp(resolve('.runtime/checks/schema-upgrade-'));
const previous = join(root, 'previous-release');
await mkdir(previous, {recursive: true});
for (const file of ['server/store.ts', 'server/database.ts']) {
  const child = Bun.spawn(['git', 'show', `${tag}:${file}`], {stdout: 'pipe', stderr: 'pipe'});
  const [source, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `git show ${tag}:${file}: ${error}`);
  await writeFile(join(previous, file.split('/').pop()!), source);
}
const previousStore: typeof Store = (await import(Bun.pathToFileURL(join(previous, 'store.ts')).href)).Store;
const previousDatabase: new (root: string) => {init(fallback: unknown): Promise<unknown>} = (await import(Bun.pathToFileURL(join(previous, 'database.ts')).href)).MetadataDatabase;
const machine: Machine = {id: crypto.randomUUID(), name: '1.1.0 数据迁移环境', family: 'ubuntu', memory: 2048, cpus: 2, diskGB: 20,
  state: 'stopped', createdAt: '2026-09-01T00:00:00.000Z', firmware: 'uefi', backingResolved: true, diskGeneration: crypto.randomUUID(), sshPort: 2222,
  network: {mode: 'nat'}, installation: {recipeId: 'ubuntu-server', phase: 'ready', message: '', startedAt: '2026-09-01T00:00:00.000Z'}};
const template: Template = {id: crypto.randomUUID(), name: '1.1.0 模板', family: 'ubuntu', diskGB: 20, createdAt: '2026-08-01T00:00:00.000Z', firmware: 'uefi'};
const passed: string[] = [];
try {
  // Build genuine v1.1.0 data with the previous release's own code, leaving a
  // crashed reset behind: journal committed to disk, metadata not yet updated.
  const data = join(root, 'data'), writer = new previousStore(data);
  await writer.init();
  writer.data.settings = {qemuPath: '', accelerator: 'whpx', isoDirectory: join(root, 'iso')};
  writer.data.machines.push(machine); writer.data.templates.push(template);
  await writer.save();
  await mkdir(writer.managed('machines', machine.id), {recursive: true});
  await Bun.write(writer.managed('machines', machine.id, 'disk.qcow2'), 'interrupted generation');
  await Bun.write(writer.managed('machines', machine.id, 'previous.qcow2'), 'rollback generation');
  await writer.journal({type: 'reset', kind: 'machines', id: machine.id, transaction: crypto.randomUUID()});
  assert.deepEqual(writer.db.with(db => db.query('PRAGMA user_version').get()), {user_version: 2});

  const upgraded = new Store(data);
  await upgraded.init();
  assert.deepEqual(upgraded.data.machines[0], machine);
  assert.deepEqual(upgraded.data.templates[0], template);
  assert.equal(upgraded.data.settings.accelerator, 'whpx');
  assert.deepEqual(upgraded.db.with(db => db.query('PRAGMA user_version').get()), {user_version: 3});
  assert.deepEqual(JSON.parse(await Bun.file(join(data, 'lab.json')).text()), {version: 2, database: 'desklab.sqlite', note: 'Metadata migrated to SQLite. Original JSON is in backups/lab.pre-sqlite.json.'});
  const backups = (await readdir(join(data, 'backups'))).filter(name => name.startsWith('before-restore-points-v3-'));
  assert.equal(backups.length, 1);
  const backup = new Database(join(data, 'backups', backups[0]), {readonly: true});
  try {assert.equal((backup.query('PRAGMA user_version').get() as {user_version: number}).user_version, 2); assert.equal((backup.query('SELECT id FROM machines').get() as {id: string}).id, machine.id);} finally {backup.close();}
  assert.equal(await Bun.file(upgraded.managed('machines', machine.id, 'disk.qcow2')).text(), 'rollback generation');
  assert.equal(await Bun.file(upgraded.managed('machines', machine.id, 'previous.qcow2')).exists(), false);
  assert.deepEqual(await readdir(upgraded.managed('transactions')), []);
  assert.equal(upgraded.needsRecovery, false);
  passed.push(`${tag} data upgraded to schema v3: documents preserved, backup consistent, pending reset journal recovered`);

  await new Store(data).init();
  assert.equal((await readdir(join(data, 'backups'))).filter(name => name.startsWith('before-restore-points-v3-')).length, 1);
  passed.push('repeat opens do not create additional backups');

  await assert.rejects(() => new previousDatabase(data).init({version: 1, settings: {qemuPath: '', accelerator: 'whpx'}, machines: [], templates: []}), /数据库版本高于当前程序/);
  passed.push(`${tag} executable rejects the upgraded database instead of using stale metadata`);
} finally {
  await Bun.write(join(root, 'result.json'), JSON.stringify({version: (await Bun.file('package.json').json()).version, previousTag: tag, bun: Bun.version, passed, complete: passed.length === 3}, null, 2));
}
console.log('Cross-version schema upgrade acceptance:', root);
