import {expect,test} from 'bun:test';
import {releaseInfo} from '../scripts/build/release-info';

test('RC tag produces a prerelease with a versioned installer',()=>{
  expect(releaseInfo('1.0.0-rc1','refs/tags/v1.0.0-rc1')).toMatchObject({publish:true,prerelease:true,installer:'DeskLab-Setup-v1.0.0-rc1-windows-x64.exe'});
  expect(releaseInfo('1.0.0-rc.2','refs/tags/v1.0.0-rc.2').prerelease).toBe(true);
});
test('stable tag produces a full release',()=>{
  expect(releaseInfo('1.0.0','refs/tags/v1.0.0')).toMatchObject({publish:true,prerelease:false});
});
test('branches never publish, even with the same name as a release tag',()=>{
  for(const branch of ['master','v1.0.0-rc1'])expect(releaseInfo('1.0.0-rc1',`refs/heads/${branch}`).publish).toBe(false);
});
test('mismatched tags and unsupported versions fail before building',()=>{
  expect(()=>releaseInfo('1.0.0-rc1','refs/tags/v1.0.0')).toThrow('does not match');
  expect(()=>releaseInfo('1.0.0','refs/tags/v2.0.0')).toThrow('does not match');
  for(const version of ['v1.0.0','01.0.0','1.0','1.0.0-rc0','1.0.0-beta1','1.0.0;echo bad'])expect(()=>releaseInfo(version,`refs/tags/v${version}`)).toThrow();
});
