import { access, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { qemuValue } from './validation';

// Each machine (and restored disk generation) owns its writable EFI variables.
export async function uefiDrives(qemu: string, variables: string) {
  const share = join(dirname(qemu), 'share');
  const code = join(share, 'edk2-x86_64-code.fd');
  const seed = join(share, 'edk2-i386-vars.fd');
  try { await access(code); await access(seed); }
  catch { throw new Error('QEMU 目录缺少 UEFI 固件，请使用包含 share/edk2-x86_64-code.fd 和 edk2-i386-vars.fd 的完整发行包'); }
  try { await copyFile(seed, variables, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return ['-drive', `if=pflash,format=raw,readonly=on,file=${qemuValue(code)}`,
    '-drive', `if=pflash,format=raw,file=${qemuValue(variables)}`];
}
