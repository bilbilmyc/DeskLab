import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Diagnostics, collectDiagnostics, diskSpaceCheck, virtualizationChecks, probeDirectoryWrite, type DiagnosticContext} from '../server/diagnostics';
import {DiagnosticEvents} from '../server/diagnostic-events';
import type {DiagnosticReport} from '../shared/diagnostics';

test('unknown virtualization is never reported as available; TCG does not require WHPX', () => {
  expect(virtualizationChecks({firmware: null, whpx: null}, 'whpx').map(c => c.status)).toEqual(['unknown', 'unknown']);
  expect(virtualizationChecks({firmware: false, whpx: false}, 'whpx').map(c => c.status)).toEqual(['fail', 'fail']);
  expect(virtualizationChecks({firmware: false, whpx: false}, 'tcg').map(c => c.status)).toEqual(['warning', 'warning']);
  expect(virtualizationChecks({firmware: true, whpx: true}, 'whpx').map(c => c.status)).toEqual(['pass', 'pass']);
});
test('disk failures and low-space thresholds are explicit', () => {
  expect(diskSpaceCheck('disk', 'disk', null).status).toBe('unknown');
  expect(diskSpaceCheck('disk', 'disk', 0).status).toBe('fail');
  expect(diskSpaceCheck('disk', 'disk', 1024 ** 3).status).toBe('warning');
  expect(diskSpaceCheck('disk', 'disk', 10 * 1024 ** 3).status).toBe('pass');
});
test('directory write probe preserves existing files and removes only its temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desklab-permissions-'));
  try {
    await Bun.write(join(root, 'keep.txt'), 'unchanged');
    expect(await probeDirectoryWrite(root)).toBe(true);
    expect(await readdir(root)).toEqual(['keep.txt']);
    expect(await Bun.file(join(root, 'keep.txt')).text()).toBe('unchanged');
    expect(await probeDirectoryWrite(join(root, 'missing'))).toBe(false);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('operation diagnostics contain only allowlisted labels, not attacker-controlled errors or paths', () => {
  const events = new DiagnosticEvents();
  const secret = 'SENSITIVE_password_token_username';
  events.record(`/api/machines/${secret}/start`, 400, new Error(`ENOENT C:\\Users\\${secret}\\secret.pem Bearer ${secret}`));
  events.record(`/api/docker/managed/start`, 202);
  events.record(`/api/${secret}`, 400, new Error(secret));
  expect(events.snapshot()).toHaveLength(2);
  expect(events.snapshot()[1].outcome).toBe('accepted');
  expect(JSON.stringify(events.snapshot())).not.toContain(secret);
  events.snapshot()[0].operation = secret;
  expect(JSON.stringify(events.snapshot())).not.toContain(secret);
  for (let i = 0; i < 110; i++) events.record('/api/settings', 200);
  expect(events.snapshot()).toHaveLength(100);
});
test('concurrent probes coalesce; changed settings invalidate cached results', async () => {
  const context: DiagnosticContext = {root: 'private', isoDirectory: 'private', settings: {qemuPath: '', accelerator: 'whpx'}, requestedPort: 1, actualPort: 1};
  let count = 0, release!: () => void;
  const gate = new Promise<void>(done => {release = done;});
  const diagnostics = new Diagnostics(() => structuredClone(context), async () => {
    count++; await gate;
    return {schemaVersion: 1, checkedAt: new Date().toISOString(), checks: [], summary: {pass: 0, fail: 0, unknown: 0, warning: 0}};
  });
  const first = diagnostics.check(), second = diagnostics.check(true);
  expect(count).toBe(1); release();
  await Promise.all([first, second]); expect(count).toBe(1);
  context.settings.accelerator = 'tcg'; await diagnostics.check(); expect(count).toBe(2);
  await diagnostics.check(true); expect(count).toBe(2);
  expect(JSON.stringify(await diagnostics.export())).not.toContain('private');
});
test('actual probes report missing engine and directory without exporting their paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desklab-diagnostics-'));
  try {
    const report = await collectDiagnostics({root, isoDirectory: join(root, 'missing-secret-iso'), settings: {qemuPath: join(root, 'secret-engine'), accelerator: 'whpx'}, requestedPort: 43210, actualPort: 54321});
    expect(report.checks.find(c => c.id === 'qemu')?.status).toBe('fail');
    expect(report.checks.find(c => c.id === 'iso-access')?.status).toBe('fail');
    expect(report.checks.find(c => c.id === 'iso-space')?.status).toBe('unknown');
    expect(report.checks.find(c => c.id === 'service-port')?.status).toBe('warning');
    expect(Object.values(report.summary).reduce((a, b) => a + b, 0)).toBe(report.checks.length);
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain('secret');
  } finally {await rm(root, {recursive: true, force: true});}
}, 25000);
test('diagnostic endpoints enforce token and origin; exporting preserves instance data', async () => {
  await mkdir('.runtime/checks', {recursive: true});
  const root = await mkdtemp(resolve('.runtime/checks/diagnostics-api-'));
  const child = Bun.spawn([process.execPath, resolve('server/index.ts')], {env: {...process.env, LAB_DATA_DIR: root, LAB_PORT: '0', LAB_OPEN: '0', LAB_TRAY: '0'}, stdout: 'ignore', stderr: 'pipe'});
  try {
    let origin = '';
    for (let n = 0; n < 200; n++) {
      try {const instance = await Bun.file(join(root, 'instance.json')).json(); origin = `http://127.0.0.1:${instance.port}`; break;} catch {}
      if (child.exitCode !== null) throw new Error('isolated server exited');
      await Bun.sleep(50);
    }
    expect(origin).not.toBe('');
    const before = await (await fetch(origin + '/api/state')).json();
    const request = {method: 'POST', headers: {'Content-Type': 'application/json', 'x-lab-token': before.token}, body: '{}'};
    for (const endpoint of ['check', 'export']) {
      expect((await fetch(`${origin}/api/diagnostics/${endpoint}`, {...request, headers: {'Content-Type': 'application/json'}})).status).toBe(403);
      expect((await fetch(`${origin}/api/diagnostics/${endpoint}`, {...request, headers: {...request.headers, Origin: 'https://example.com'}})).status).toBe(403);
    }
    const report = await (await fetch(origin + '/api/diagnostics/check', request)).json() as DiagnosticReport;
    expect(report.checks.length).toBeGreaterThan(10);
    const rejected = await fetch(origin + '/api/settings', {...request, body: JSON.stringify({accelerator: 'PRIVATE_INPUT_MUST_NOT_BE_LOGGED'})});
    expect(rejected.status).toBe(400);
    const exported = await fetch(origin + '/api/diagnostics/export', request);
    expect(exported.status).toBe(200); expect(exported.headers.get('cache-control')).toBe('no-store');
    const text = await exported.text();
    expect(text).not.toContain('PRIVATE_INPUT_MUST_NOT_BE_LOGGED');
    expect(JSON.parse(text).events).toContainEqual(expect.objectContaining({operation: 'settings.save', outcome: 'failed', code: 'INVALID_INPUT'}));
    for (const secret of [root, root.replaceAll('\\', '\\\\'), before.token]) expect(text).not.toContain(secret);
    const after = await (await fetch(origin + '/api/state')).json();
    expect(after.settings).toEqual(before.settings); expect(after.machines).toEqual(before.machines); expect(after.templates).toEqual(before.templates);
    await fetch(origin + '/api/app/quit', request);
    expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => -1)])).toBe(0);
  } finally {if (child.exitCode === null) child.kill(); await child.exited;}
}, 45000);
