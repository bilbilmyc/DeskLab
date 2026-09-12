import {afterEach, expect, test} from 'bun:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer, type Socket} from 'node:net';
import {Lab} from '../server/lab';
import {Store} from '../server/store';
import type {Machine} from '../shared/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

// Speak QMP over real loopback sockets, without launching QEMU or opening disks.
// This keeps the event subscription and command-disconnect behavior in the test.
async function fixture(initialStatus: 'running'|'prelaunch'|'shutdown', pid = process.pid) {
  const id = crypto.randomUUID();
  const sockets = new Set<Socket>(), events = new Set<Socket>();
  const commands: string[] = [];
  let status: string = initialStatus, offline = false, failQuit = false;
  async function monitor(channel: 'commands'|'events') {
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {sockets.delete(socket); events.delete(socket);});
      if (offline) {socket.destroy(); return;}
      const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n');
      send({QMP: {version: {qemu: {major: 11, minor: 0, micro: 0}, package: ''}, capabilities: []}});
      let pending = '';
      socket.on('data', data => {
        pending += data.toString();
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          commands.push(`${channel}:${request.execute}`);
          if (request.execute === 'qmp_capabilities' && channel === 'events') events.add(socket);
          if (request.execute === 'quit' && failQuit) {
            offline = true; socket.destroy(); return;
          }
          if (request.execute === 'cont') status = 'running';
          const result = request.execute === 'query-name' ? {name: `DeskLab-${id}`} :
            request.execute === 'query-status' ? {running: status === 'running', status} : {};
          send({return: result, id: request.id});
        }
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return (server.address() as {port: number}).port;
  }
  const qmpPort = await monitor('commands'), eventPort = await monitor('events');
  const store = new Store('unused-reboot-test-data');
  // These scenarios only change lifecycle records; no filesystem is needed.
  store.save = async () => {};
  const machine: Machine = {
    id, name: 'Recovered Windows', family: 'windows', firmware: 'uefi', memory: 512,
    cpus: 1, diskGB: 8, createdAt: new Date().toISOString(), state: 'running', backingResolved: true,
    session: {pid, qmpPort, eventPort, vncPort: 5900},
  };
  store.data.machines.push(machine);
  const lab = new Lab(store);
  return {
    lab, id, commands,
    failNextQuit() {failQuit = true;},
    requestGuestRestart() {
      for (const socket of events) socket.write(JSON.stringify({event: 'SHUTDOWN', data: {guest: true, reason: 'guest-reset'}}) + '\n');
    },
  };
}

test('recovery reports a missed shutdown and keeps the disk protected', async () => {
  const {lab, id, commands} = await fixture('shutdown');
  await lab.recover();
  await lab.refreshRecovered();
  expect(lab.get(id).state).toBe('error');
  expect(lab.get(id).error).toContain('shutdown');
  expect(lab.get(id).session).toBeDefined();
  expect(() => lab.requireStopped(id)).toThrow('请先关闭环境');
  expect(commands).not.toContain('commands:cont');
  expect(commands).not.toContain('commands:quit');
});

test('recovery subscribes to events before continuing an interrupted managed launch', async () => {
  const {lab, id, commands} = await fixture('prelaunch');
  await lab.recover();
  expect(lab.get(id).state).toBe('running');
  expect(commands.indexOf('events:qmp_capabilities')).toBeGreaterThanOrEqual(0);
  expect(commands.indexOf('commands:cont')).toBeGreaterThan(commands.indexOf('events:qmp_capabilities'));
  expect(lab.get(id).session).toBeDefined();
  expect(() => lab.requireStopped(id)).toThrow('请先关闭环境');
});

test('a failed restart quit does not prevent later reconciliation of an exited process', async () => {
  // Obtain a known exited PID instead of assuming an arbitrary PID is unused.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {windowsHide: true, stdio: 'ignore'});
  await once(child, 'exit');
  expect(child.pid).toBeDefined();
  const {lab, id, failNextQuit, requestGuestRestart} = await fixture('running', child.pid!);
  await lab.recover();
  failNextQuit(); requestGuestRestart();
  const deadline = Date.now() + 3000;
  while (lab.get(id).state !== 'error' && Date.now() < deadline) await Bun.sleep(10);
  expect(lab.get(id).state).toBe('error');
  expect(lab.get(id).session).toBeDefined();
  expect(() => lab.requireStopped(id)).toThrow('请先关闭环境');

  await lab.exclusive(() => lab.refreshRecovered());
  expect(lab.get(id).state).toBe('stopped');
  expect(lab.get(id).session).toBeUndefined();
  expect(lab.requireStopped(id).id).toBe(id);
}, 10000);

test('application shutdown cancels a launch paused immediately before process creation', async () => {
  await mkdir('.runtime/tests',{recursive:true});
  const root=await mkdtemp(resolve('.runtime/tests/reboot-'));
  const store = new Store(root);await store.init();
  cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const id = crypto.randomUUID();
  store.data.machines.push({
    id, name: 'Pending Windows launch', family: 'windows', firmware: 'bios', memory: 512,
    cpus: 1, diskGB: 8, createdAt: new Date().toISOString(), state: 'stopped', backingResolved: true,
  });
  let releaseSave!: () => void, reachedSave!: () => void;
  const paused = new Promise<void>(resolve => {reachedSave = resolve;});
  const resume = new Promise<void>(resolve => {releaseSave = resolve;});
  store.save = async () => {
    if (store.data.machines[0].state === 'starting') {reachedSave(); await resume;}
  };
  const lab = new Lab(store);
  // Process creation must never be reached; no real engine is provided.
  lab.tools = async () => ({qemu: 'desklab-test-must-not-spawn.exe', img: 'unused'});
  const starting = lab.exclusive(() => lab.start(id)).then(() => undefined, error => error as Error);
  await paused;
  let shutdownFinished = false;
  const closing = lab.shutdown().then(() => {shutdownFinished = true;});
  await Bun.sleep(10);
  expect(shutdownFinished).toBe(false);
  releaseSave();
  expect((await starting)?.message).toContain('DeskLab 正在退出'); await closing;
  expect(lab.get(id).state).toBe('stopped');
  expect(lab.get(id).session).toBeUndefined();
  expect(lab.requireStopped(id).id).toBe(id);
  await expect(lab.start(id)).rejects.toThrow('DeskLab 正在退出');
});
