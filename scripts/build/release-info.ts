import {appendFile} from 'node:fs/promises';
import {version} from '../../package.json';

export function releaseInfo(packageVersion:string, ref:string) {
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.?[1-9]\d*)?$/.test(packageVersion)) {
    throw new Error('Release version must be X.Y.Z or X.Y.Z-rcN (also accepts rc.N).');
  }
  const tag=`v${packageVersion}`;
  const publish=ref.startsWith('refs/tags/');
  if(publish&&ref!==`refs/tags/${tag}`)throw new Error(`Tag ${ref} does not match package.json version ${packageVersion}.`);
  return {tag,version:packageVersion,publish,prerelease:packageVersion.includes('-'),artifact:`DeskLab-${packageVersion}-windows-x64-basic`,installer:`DeskLab-Setup-${tag}-windows-x64.exe`};
}

if(import.meta.main) {
  const info=releaseInfo(version,process.env.GITHUB_REF??'');
  console.log(JSON.stringify(info,null,2));
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`artifact=${info.artifact}\n`);
}
