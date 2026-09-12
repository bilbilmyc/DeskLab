import { open } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

// Bun 1.3.14 accepts hideConsole but leaves Subsystem=CONSOLE, and leaves its
// original named icon group pointing at the first (16px) replacement image.
// Fix only our generated, unsigned x64 binaries before packaging/signing.
export async function finalizeWindowsExecutable(executable: string) {
  const root = resolve(import.meta.dir, '../..');
  const output = resolve(executable), local = relative(root, output);
  if (!(local === `dist${sep}app${sep}DeskLab.exe` || local.startsWith(`.runtime${sep}`) && local.endsWith(`${sep}DeskLab-fixture.exe`))) {
    throw new Error('Windows branding finalization is restricted to generated DeskLab executables.');
  }
  const file = await open(output, 'r+');
  try {
    const bytes = await file.readFile();
    function bounds(offset: number, length: number) {
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) throw new Error('Invalid PE bounds');
    }
    const u16 = (offset: number) => { bounds(offset, 2); return bytes.readUInt16LE(offset); };
    const u32 = (offset: number) => { bounds(offset, 4); return bytes.readUInt32LE(offset); };
    if (u16(0) !== 0x5a4d) throw new Error('Expected an MZ executable');
    const pe = u32(0x3c);
    if (u32(pe) !== 0x00004550 || u16(pe + 4) !== 0x8664) throw new Error('Expected an AMD64 PE executable');
    const optional = pe + 24, optionalSize = u16(pe + 20);
    bounds(optional, optionalSize);
    if (optionalSize < 152 || u16(optional) !== 0x20b || u32(optional + 108) < 5) throw new Error('Expected a complete PE32+ optional header');
    if (u32(optional + 144) || u32(optional + 148)) throw new Error('Finalize the executable before code signing');
    const subsystem = u16(optional + 68);
    if (![2, 3].includes(subsystem)) throw new Error('Unexpected Windows executable subsystem');
    const sections = u16(pe + 6), sectionTable = optional + optionalSize;
    if (!sections || sections > 96) throw new Error('Invalid PE section count');
    bounds(sectionTable, sections * 40);
    function offsetForRva(rva: number, length: number) {
      for (let index = 0; index < sections; index++) {
        const section = sectionTable + index * 40, virtual = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20);
        if (rva >= virtual && rva - virtual + length <= rawSize) { const offset = raw + rva - virtual; bounds(offset, length); return offset; }
      }
      throw new Error('PE resource RVA is outside the file sections');
    }
    const resourceSize = u32(optional + 132), base = offsetForRva(u32(optional + 128), resourceSize);
    function resourceOffset(offset: number, length: number) {
      if (offset < 0 || offset + length > resourceSize) throw new Error('Invalid PE resource bounds');
      return base + offset;
    }
    const groups: { entry: number; count: number }[] = [];
    function walk(offset: number, ids: number[]) {
      if (ids.length > 3) throw new Error('Invalid PE resource depth');
      const directory = resourceOffset(offset, 16), count = u16(directory + 12) + u16(directory + 14);
      resourceOffset(offset + 16, count * 8);
      for (let index = 0; index < count; index++) {
        const entry = directory + 16 + index * 8, id = u32(entry), child = u32(entry + 4);
        if (child & 0x80000000) walk(child & 0x7fffffff, [...ids, id]);
        else if (ids[0] === 14) {
          const dataEntry = resourceOffset(child, 16), size = u32(dataEntry + 4), data = offsetForRva(u32(dataEntry), size);
          if (size < 6 || u16(data) !== 0 || u16(data + 2) !== 1 || size !== 6 + u16(data + 4) * 14) throw new Error('Invalid PE icon group');
          groups.push({ entry: dataEntry, count: u16(data + 4) });
        }
      }
    }
    walk(0, []);
    const brand = groups.find(group => group.count === 8);
    if (!brand) throw new Error('Compiled executable is missing the DeskLab multi-size icon');
    for (const group of groups) {
      if (group.entry !== brand.entry) await file.write(bytes.subarray(brand.entry, brand.entry + 16), 0, 16, group.entry);
    }
    const gui = Buffer.alloc(2); gui.writeUInt16LE(2);
    await file.write(gui, 0, gui.length, optional + 68);
    // User-mode applications do not require a PE checksum. Clear the stale
    // linker value after modifying the header/resource table.
    await file.write(Buffer.alloc(4), 0, 4, optional + 64);
    await file.sync();
    console.log(`Verified Windows GUI subsystem and ${brand.count}-size DeskLab icon: ${output}`);
  } finally { await file.close(); }
}
