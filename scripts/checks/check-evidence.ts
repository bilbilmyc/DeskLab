import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

const workspace = resolve(import.meta.dir, '../..');
export interface EvidenceFile {path: string; sha256: string; bytes: number;}
export interface CheckEvidence {
  capturedAt: string;
  version: string;
  flavor: 'application-only' | 'basic' | 'full';
  sourceAtCheck: {commit: string; dirty: boolean};
  runtime: {bun: string; platform: string; arch: string};
  executable: EvidenceFile;
  installer?: EvidenceFile;
  manifest?: EvidenceFile & {builtAt: string};
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function identify(path: string): Promise<EvidenceFile> {
  path = resolve(path);
  return {path, sha256: await hashFile(path), bytes: (await stat(path)).size};
}
async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {cwd: workspace, stdout: 'pipe', stderr: 'pipe'});
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `Cannot identify source revision: ${error}`);
  return output.trim();
}

// The Git fields describe the checkout at check time, not an unrecorded build revision.
export async function captureEvidence(options: {executable: string; installer?: string; manifest?: string}): Promise<CheckEvidence> {
  const version = (await Bun.file(join(workspace, 'package.json')).json()).version as string;
  const evidence: CheckEvidence = {
    capturedAt: new Date().toISOString(), version, flavor: 'application-only',
    sourceAtCheck: {commit: await git(['rev-parse', 'HEAD']), dirty: !!await git(['status', '--porcelain'])},
    runtime: {bun: Bun.version, platform: process.platform, arch: process.arch},
    executable: await identify(options.executable),
  };
  if (options.installer) {
    evidence.installer = await identify(options.installer);
    const manifestPath = options.manifest ?? join(dirname(options.installer), 'DeskLab-Setup.build.json');
    const manifest = await Bun.file(manifestPath).json();
    assert.equal(manifest.appVersion, version, 'Installer manifest version differs from package.json');
    assert.equal(manifest.executable.sha256, evidence.executable.sha256, 'Installer manifest does not describe the tested EXE');
    assert.equal(manifest.installer.sha256, evidence.installer.sha256, 'Installer manifest does not describe the tested installer');
    assert.equal(typeof manifest.managedDockerComponent, 'boolean', 'Installer manifest must identify its flavor');
    evidence.flavor = manifest.managedDockerComponent ? 'full' : 'basic';
    evidence.manifest = {...await identify(manifestPath), builtAt: manifest.builtAt};
  } else assert.ok(!options.manifest, '--manifest requires --installer');
  return evidence;
}

export async function verifyEvidence(evidence: CheckEvidence): Promise<void> {
  for (const [name, file] of Object.entries({executable: evidence.executable, installer: evidence.installer, manifest: evidence.manifest})) {
    if (file) assert.equal(await hashFile(file.path), file.sha256, `${name} changed during acceptance; rerun against the final artifacts`);
  }
}

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  const value = (name: string) => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
  if (operation === 'capture') {
    const executable = value('--exe'); assert.ok(executable, 'capture requires --exe');
    console.log(JSON.stringify(await captureEvidence({executable, installer: value('--installer'), manifest: value('--manifest')}), null, 2));
  } else if (operation === 'verify') {
    const path = value('--evidence'); assert.ok(path, 'verify requires --evidence');
    await verifyEvidence(await Bun.file(path).json());
    console.log('Acceptance artifacts remain unchanged.');
  } else throw new Error('Usage: check-evidence.ts capture --exe FILE [--installer FILE] [--manifest FILE] | verify --evidence FILE');
}
