import { test, expect } from 'bun:test';
import { createInput, qemuValue } from '../server/validation';
import { Store } from '../server/store';
const valid = {name:'Ubuntu', family:'ubuntu', cpus:2, memory:2048, diskGB:32, isoPath:'D:\\images\\ubuntu.iso'};
test('requires exactly one boot source and bounded resource allocation', () => {
  expect(createInput.safeParse(valid).success).toBe(true);
  expect(createInput.safeParse({...valid, isoPath: undefined}).success).toBe(false);
  expect(createInput.safeParse({...valid, templateId: crypto.randomUUID()}).success).toBe(false);
  expect(createInput.safeParse({...valid, memory: -1}).success).toBe(false);
  expect(createInput.safeParse({...valid, cpus: 0}).success).toBe(false);
});
test('managed deletion paths cannot escape the data directory', () => {
  const store = new Store('D:/workspace/bun-demo/.runtime/test-paths');
  expect(() => store.managed('..','escape')).toThrow();
  expect(() => store.managed('')).toThrow();
  expect(() => store.managed('D:/outside')).toThrow();
  expect(store.managed('machines',crypto.randomUUID())).toContain('machines');
});
test('QEMU key-value paths escape literal commas', () => {
  expect(qemuValue('D:/a,b/disk.qcow2')).toBe('D:/a,,b/disk.qcow2');
});
