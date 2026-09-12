import { test, expect } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { uefiDrives } from '../server/firmware';
import { createInput, importInput } from '../server/validation';

test('old requests retain BIOS and invalid firmware is rejected', () => {
  const input = {name: 'VM', family: 'windows', memory: 4096, cpus: 2, diskGB: 64, isoPath: 'D:/windows.iso'};
  expect(createInput.parse(input).firmware).toBe('bios');
  expect(createInput.parse({...input, firmware: 'uefi'}).firmware).toBe('uefi');
  expect(importInput.safeParse({name: 'VM', family: 'windows', path: 'D:/vm.qcow2', firmware: '../../outside'}).success).toBe(false);
});

test('UEFI variables survive boots but are isolated across clones and resets', async () => {
  await mkdir('.runtime/tests/tests', {recursive: true});
  const root = await mkdtemp(resolve('.runtime/tests/tests', 'firmware-'));
  await mkdir(join(root, 'share'));
  await Bun.write(join(root, 'share', 'edk2-x86_64-code.fd'), 'firmware code');
  await Bun.write(join(root, 'share', 'edk2-i386-vars.fd'), 'factory variables');
  const qemu = join(root, 'qemu.exe'), first = join(root, 'first.fd');
  const args = await uefiDrives(qemu, first);
  expect(args[1]).toContain('readonly=on');
  await Bun.write(first, 'machine-specific boot entry');
  await uefiDrives(qemu, first);
  expect(await Bun.file(first).text()).toBe('machine-specific boot entry');
  for (const name of ['clone.fd', 'reset-generation.fd']) {
    await uefiDrives(qemu, join(root, name));
    expect(await Bun.file(join(root, name)).text()).toBe('factory variables');
  }
  await expect(uefiDrives(join(root, 'missing', 'qemu.exe'), join(root, 'missing.fd'))).rejects.toThrow('缺少 UEFI 固件');
  expect(await Bun.file(join(root, 'missing.fd')).exists()).toBe(false);
});
