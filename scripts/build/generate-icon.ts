import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

export const windowsIconPath = resolve(import.meta.dir, '../../installer/DeskLab.ico');
export const windowsIconSizes = [16, 20, 24, 32, 48, 64, 128, 256];

// ICO uses bottom-up BGRA bitmaps with an AND mask. Keep the largest image
// PNG-compressed; smaller DIB images also work in Windows shell icon pickers.
function bitmapIcon(rgba: Buffer, size: number) {
  const stride = Math.ceil(size / 32) * 4;
  const bytes = Buffer.alloc(40 + size * size * 4 + stride * size);
  bytes.writeUInt32LE(40, 0);
  bytes.writeInt32LE(size, 4);
  bytes.writeInt32LE(size * 2, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(32, 14);
  bytes.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = 40 + ((size - y - 1) * size + x) * 4;
      bytes[target] = rgba[source + 2]!;
      bytes[target + 1] = rgba[source + 1]!;
      bytes[target + 2] = rgba[source]!;
      bytes[target + 3] = rgba[source + 3]!;
      if (rgba[source + 3] === 0) {
        const mask = 40 + size * size * 4 + (size - y - 1) * stride + Math.floor(x / 8);
        bytes[mask] = bytes[mask]! | (0x80 >> (x % 8));
      }
    }
  }
  return bytes;
}

export async function generateWindowsIcon() {
  const svg = Buffer.from(await Bun.file(resolve(import.meta.dir, '../../public/icon.svg')).arrayBuffer());
  const images: Buffer[] = [];
  for (const size of windowsIconSizes) {
    const render = sharp(svg, { density: 768 }).resize(size, size).ensureAlpha();
    images.push(size === 256 ? await render.png().toBuffer() : bitmapIcon(await render.raw().toBuffer(), size));
  }
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [index, image] of images.entries()) {
    const size = windowsIconSizes[index]!;
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }
  await mkdir(dirname(windowsIconPath), { recursive: true });
  await Bun.write(windowsIconPath, Buffer.concat([header, ...images]));
  return windowsIconPath;
}

if (import.meta.main) console.log(`Generated ${await generateWindowsIcon()} (${windowsIconSizes.join(', ')} px)`);
