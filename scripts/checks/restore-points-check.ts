import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {executable, run} from '../../server/qemu';

const workspace = resolve(import.meta.dir, '../..');
const directory = resolve(process.env.QEMU_TEST_DIR ?? join(workspace, '.runtime/tools/qemu'));
const img = await executable(directory, true);
assert.ok(img, 'Real restore-point acceptance requires QEMU_TEST_DIR/qemu-img; run bun run qemu:prepare first');
const qemuVersion = await run(img, ['--version']);
const startedAt = new Date().toISOString();
const child = Bun.spawn([process.execPath, 'test', 'tests/restore-points.test.ts', 'tests/recovery.test.ts'], {
  cwd: workspace, env: {...process.env, QEMU_TEST_DIR: directory, FORCE_COLOR: '0'}, stdout: 'pipe', stderr: 'pipe',
});
const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
const output = stdout + stderr;
process.stdout.write(output);
const skipped = /\(skip\)|\b[1-9]\d*\s+(?:skip|tests? skipped)\b/i.test(output);
await mkdir(join(workspace, '.runtime/checks'), {recursive: true});
await Bun.write(join(workspace, '.runtime/checks/restore-points-required.log'), output);
await Bun.write(join(workspace, '.runtime/checks/restore-points-required.json'), JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(), bun: Bun.version, qemuVersion, exitCode, skipped,
  passed: exitCode === 0 && !skipped,
}, null, 2));
assert.equal(exitCode, 0, 'Required real restore-point tests failed');
assert.equal(skipped, false, 'Required real restore-point tests must not skip');
console.log('Required restore-point acceptance passed with real QEMU images and no skipped tests.');
