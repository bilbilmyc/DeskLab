// Local acceptance requires a prepared guest with automatic root/Administrator login.
// Import creates an independent copy. The source disk is only read and hashed.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Store} from '../../server/store';
import {Lab} from '../../server/lab';
import {qmp, run} from '../../server/qemu';
import {authorizeKeyCommand} from '../../shared/ssh';
import type {LabSnapshot} from '../../shared/types';
import {captureEvidence, hashFile, verifyEvidence} from './check-evidence';

const [kind, sourceArg] = process.argv.slice(2);
assert.ok(['linux', 'windows'].includes(kind) && sourceArg, 'Usage: restore-points-guest.ts linux|windows PREPARED_QCOW2');
const source = resolve(sourceArg), executable = resolve(process.env.DESKLAB_TEST_EXE ?? 'dist/app/DeskLab.exe');
const evidence = await captureEvidence({executable}), sourceHash = await hashFile(source);
await mkdir('.runtime/checks', {recursive: true});
const root = await mkdtemp(resolve(`.runtime/checks/restore-guest-${kind}-`));
const store = new Store(join(root, 'data')); await store.init();
store.data.settings = {qemuPath: resolve(process.env.QEMU_TEST_DIR ?? '.runtime/tools/qemu'), accelerator: 'whpx', isoDirectory: join(root, 'iso')};
await store.save();
const lab = new Lab(store), firmware = kind === 'windows' ? 'uefi' : 'bios';
console.log('Importing independent guest copy:', kind, root);
const template = await lab.exclusive(() => lab.importTemplate({name: 'Acceptance source', family: kind, firmware, path: source}));
const vm = await lab.exclusive(() => lab.create({name: 'Restore acceptance guest', family: kind, firmware, cpus: 2, memory: kind === 'windows' ? 4096 : 2048, diskGB: template.diskGB, templateId: template.id}));
const sshKey = kind === 'linux' ? await lab.sshKeys.ensure() : undefined;
const secret = crypto.randomUUID(), events: Array<{phase: string; marker: string; user: string; boot: string; explorer?: boolean}> = [];
const passed: string[] = [];
const callback: Bun.Server<undefined> = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === `/${secret}/result` && request.method === 'POST') {events.push(await request.json()); return new Response('ok');}
  const phase = path.split('/')[2]?.split('.')[0];
  if (!path.startsWith(`/${secret}/`) || !['A', 'B', 'restored'].includes(phase)) return new Response('missing', {status: 404});
  const endpoint = `http://10.0.2.2:${callback.port}/${secret}/result`;
  if (kind === 'windows') return new Response(`$ErrorActionPreference='Stop'
${phase === 'restored' ? '' : `[IO.File]::WriteAllText('C:\\desklab-restore-acceptance.txt','${phase}')`}
$data=@{phase='${phase}';marker=[IO.File]::ReadAllText('C:\\desklab-restore-acceptance.txt');user=$env:USERNAME;boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');explorer=[bool](Get-Process explorer -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress
(New-Object Net.WebClient).UploadString('${endpoint}',$data)|Out-Null
`);
  return new Response(`set -eu
${phase === 'restored' ? '' : `printf '%s' '${phase}' > /root/desklab-restore-acceptance.txt`}
${phase === 'A' ? authorizeKeyCommand(sshKey!.publicKey) : ''}
sync
payload=$(printf '{"phase":"%s","marker":"%s","user":"%s","boot":"%s"}' '${phase}' "$(cat /root/desklab-restore-acceptance.txt)" "$(id -un)" "$(cat /proc/sys/kernel/random/boot_id)")
curl -fsS -H 'Content-Type: application/json' -d "$payload" '${endpoint}'
`);
}});
const child = Bun.spawn([executable], {env: {...process.env, LAB_DATA_DIR: store.root, LAB_PORT: '0', LAB_OPEN: '0', LAB_TRAY: '0'}, stdout: 'ignore', stderr: 'pipe'});
let origin = '', token = '', succeeded = false;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api/' + path, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', 'x-lab-token': token}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600000)});
  const result = await response.json(); assert.ok(response.ok, `${path}: ${result.error ?? response.status}`); return result;
}
async function machine() {return (await api<LabSnapshot>('state')).machines.find(item => item.id === vm.id)!;}
async function command(text: string) {
  const current = await machine(); assert.ok(current.session?.qmpPort);
  const send = async (keys: string) => {await qmp(current.session!.qmpPort, 'human-monitor-command', {'command-line': `sendkey ${keys} 20`}); await Bun.sleep(45);};
  const keys: Record<string, string> = {' ': 'spc', '\\': 'backslash', '/': 'slash', ':': 'shift-semicolon', ';': 'semicolon', '.': 'dot', ',': 'comma', '-': 'minus', '_': 'shift-minus', '=': 'equal', '+': 'shift-equal', '"': 'shift-apostrophe', "'": 'apostrophe', '$': 'shift-4', '(': 'shift-9', ')': 'shift-0', '&': 'shift-7', '|': 'shift-backslash', '>': 'shift-dot', '<': 'shift-comma', '!': 'shift-1', '@': 'shift-2', '?': 'shift-slash'};
  if (kind === 'windows') {await send('meta_l-r'); await Bun.sleep(700);} else {await send('ctrl-c'); await Bun.sleep(200);}
  for (const letter of text) await send(keys[letter] ?? (/[A-Z]/.test(letter) ? `shift-${letter.toLowerCase()}` : letter));
  await send('ret');
}
async function stop() {
  if (!(await machine()).session) return;
  await api(`machines/${vm.id}/stop`, {});
  const until = Date.now() + 120000;
  while ((await machine()).state !== 'stopped') {assert.ok(Date.now() < until, 'guest must shut down normally'); await Bun.sleep(1000);}
  assert.equal((await machine()).session, undefined);
}
async function probe(phase: string) {
  await api(`machines/${vm.id}/start`, {});
  console.log('Booting guest:', kind, phase);
  await Bun.sleep(kind === 'windows' ? 60000 : 30000);
  for (let attempt = 0; attempt < 3 && !events.some(item => item.phase === phase); attempt++) {
    const script = `http://10.0.2.2:${callback.port}/${secret}/${phase}.${kind === 'windows' ? 'ps1' : 'sh'}`;
    await command(kind === 'windows' ? `powershell -nop -ep bypass -c "iex ((New-Object Net.WebClient).DownloadString('${script}'))"` : `curl -fsS '${script}' | sh`);
    for (let n = 0; n < 45 && !events.some(item => item.phase === phase); n++) await Bun.sleep(1000);
  }
  const current = await machine();
  await qmp(current.session!.qmpPort, 'screendump', {filename: join(root, `${phase}.png`), format: 'png'});
  const event = events.find(item => item.phase === phase);
  assert.ok(event, `${kind} ${phase} must execute an actual guest command`);
  assert.equal(event.marker, phase === 'restored' ? 'A' : phase);
  assert.equal(event.user, kind === 'windows' ? 'Administrator' : 'root');
  if (kind === 'windows') assert.equal(event.explorer, true);
  if (sshKey) {
    const result = await run('ssh', ['-i', sshKey.privateKeyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(root, 'known_hosts')}`, '-p', String(current.sshPort), 'root@127.0.0.1', 'cat /root/desklab-restore-acceptance.txt']);
    assert.ok(result.endsWith(event.marker), 'SSH reads the actual restored marker');
  }
  passed.push(`${phase}: cold boot, guest marker ${event.marker}${sshKey ? ', SSH public key access' : ', Administrator Explorer'}`);
  await stop(); console.log('PASS:', kind, phase, 'normal shutdown');
}
try {
  for (let n = 0; n < 240; n++) {
    if (await Bun.file(join(store.root, 'instance.json')).exists()) {const instance = await Bun.file(join(store.root, 'instance.json')).json(); assert.equal(instance.pid, child.pid); origin = `http://127.0.0.1:${instance.port}`; break;}
    assert.equal(child.exitCode, null, 'packaged app stays alive'); await Bun.sleep(250);
  }
  assert.ok(origin); token = (await api<LabSnapshot & {token: string}>('state')).token;
  await probe('A');
  const point = await api<{id: string}>(`machines/${vm.id}/restore-points`, {name: 'Guest state A'});
  await probe('B');
  await api(`machines/${vm.id}/restore-points/${point.id}/restore`, {confirm: true});
  assert.equal((await machine()).state, 'stopped');
  await probe('restored');
  assert.notEqual(events[0].boot, events.at(-1)?.boot);
  assert.equal(await hashFile(source), sourceHash, 'source image remains byte-identical');
  await verifyEvidence(evidence); succeeded = true;
} finally {
  if (origin && token && child.exitCode === null) {
    await stop().catch(error => console.error('Isolated guest shutdown requires attention:', error.message));
    if (!(await machine()).session) {await api('app/quit', {}); await Promise.race([child.exited, Bun.sleep(20000)]);}
    // Preserve a live guest for diagnosis instead of killing it during cleanup.
  }
  callback.stop(true);
  await Bun.write(join(root, 'result.json'), JSON.stringify({evidence, kind, sourceSha256: sourceHash, passed, complete: succeeded && child.exitCode === 0, events, processExited: child.exitCode}, null, 2));
  console.log('Guest acceptance evidence:', root);
}
assert.equal(child.exitCode, 0, 'packaged app exits cleanly');
