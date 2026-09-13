import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {version} from '../../package.json';
import {releaseInfo} from './release-info';

type ReleaseContext={version:string;ref:string;event:string;repository:string;sha:string;runId:string;directory:string};
async function runGh(args:string[]) {
  const child=Bun.spawn(['gh',...args],{stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code!==0)throw new Error(`gh ${args[0]} ${args[1]} failed: ${stderr}`);
  return stdout;
}

export async function publishRelease(context:ReleaseContext,gh:typeof runGh=runGh) {
  const {version,ref,event,repository,sha,runId,directory}=context;
  const info=releaseInfo(version,ref);
  assert.ok(info.publish&&event==='push','Only a tag push may publish a release.');
  assert.ok(repository,'GITHUB_REPOSITORY is required.');
  const files=[info.installer,'DeskLab.exe','DeskLab-Setup.build.json','SHA256SUMS.txt'];
  const manifest=await Bun.file(join(directory,'DeskLab-Setup.build.json')).json();
  assert.equal(manifest.appVersion,version,'Installer version must match the tag.');
  async function hash(file:string) {
    const digest=createHash('sha256');
    for await(const chunk of createReadStream(join(directory,file)))digest.update(chunk);
    return digest.digest('hex');
  }
  assert.equal(await hash(info.installer),manifest.installer.sha256,'Installer digest mismatch.');
  assert.equal(await hash('DeskLab.exe'),manifest.executable.sha256,'Executable digest mismatch.');

  // Read the complete list so a network or permission error cannot be mistaken for a missing release.
  const pages=JSON.parse(await gh(['api','--paginate','--slurp',`repos/${repository}/releases?per_page=100`])) as {id:number;tag_name:string;draft:boolean}[][];
  const existing=pages.flat().find(release=>release.tag_name===info.tag);
  assert.ok(!existing||existing.draft,'This version is already published. Create a new version instead of replacing release assets.');
  const notes=join(directory,'release-notes.md');
  await Bun.write(notes,`DeskLab ${info.tag}${info.prerelease?' 候选版本':' 正式版本'}\n\n下载 \`${info.installer}\` 安装。程序内显示 \`${info.tag}\`。\n\nWindows x64 基础包，内置 QEMU，不包含系统 ISO 或独立 Docker Linux 镜像。\n\n已通过类型检查、单元测试和成品启动/版本检查。\`SHA256SUMS.txt\` 与构建清单用于校验附件。\n\n源码提交：${sha}\n构建记录：https://github.com/${repository}/actions/runs/${runId}\n`);
  if(!existing)await gh(['release','create',info.tag,'--repo',repository,'--verify-tag','--draft','--title',`DeskLab ${info.tag}`,'--notes-file',notes,...(info.prerelease?['--prerelease']:[])]);
  await gh(['release','upload',info.tag,'--repo',repository,'--clobber',...files.map(file=>join(directory,file))]);
  const release=JSON.parse(await gh(['api',`repos/${repository}/releases/tags/${info.tag}`])) as {id:number;assets:{name:string;state:string;digest:string}[]};
  for(const file of files) {
    const asset=release.assets.find(asset=>asset.name===file);
    assert.equal(asset?.state,'uploaded',`${file} was not uploaded.`);
    assert.equal(asset?.digest,`sha256:${await hash(file)}`,`${file} GitHub digest mismatch.`);
  }
  // Keep uploads private until all assets have been verified. RCs never become Latest.
  await gh(['api','--method','PATCH',`repos/${repository}/releases/${release.id}`,'-F','draft=false','-F',`prerelease=${info.prerelease}`,'-f',`make_latest=${info.prerelease?'false':'legacy'}`,'-f',`body=${await Bun.file(notes).text()}`]);
  console.log(`Published https://github.com/${repository}/releases/tag/${info.tag}`);
}

if(import.meta.main)await publishRelease({version,ref:process.env.GITHUB_REF??'',event:process.env.GITHUB_EVENT_NAME??'',repository:process.env.GITHUB_REPOSITORY??'',sha:process.env.GITHUB_SHA??'',runId:process.env.GITHUB_RUN_ID??'',directory:'dist/release'});
