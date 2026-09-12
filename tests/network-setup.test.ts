import {describe,expect,test} from 'bun:test';
import {NetworkSetup,readOperation,setupRequest} from '../server/network-setup';
import {run} from '../server/qemu';
import {resolve} from 'node:path';
describe('network setup privilege boundary',()=>{
  test('paused bridge setup never launches the administrator helper',async()=>{
    const setup=new NetworkSetup('.runtime/tests/network-setup');
    await expect(setup.start({action:'validate'})).rejects.toThrow('桥接配置已停用');
  });
  test('accepts only fixed operations and GUID references',()=>{
    expect(setupRequest.parse({action:'validate'}).action).toBe('validate');
    for(const request of [{action:'run',command:'whoami'},{action:'validate',script:'evil.ps1'},{action:'rollback',operationId:'../elsewhere'},{action:'prepare',adapterId:'Ethernet; command'}])expect(setupRequest.safeParse(request).success).toBe(false);
  });
  test('cannot read arbitrary journal paths',async()=>{
    expect(await readOperation('../file')).toBeUndefined();
    expect(await readOperation('C:\\Windows\\win.ini')).toBeUndefined();
  });
  test('physical bridging stays disabled until complete rollback validation',async()=>{
    const setup=new NetworkSetup('.runtime/tests/network-setup');
    await expect(setup.start({action:'prepare',adapterId:'11111111-1111-4111-8111-111111111111'})).rejects.toThrow();
  });
  test('rollback refuses unknown operation without elevating',async()=>{
    const setup=new NetworkSetup('.runtime/tests/network-setup');
    await expect(setup.start({action:'rollback',operationId:'11111111-1111-4111-8111-111111111111'})).rejects.toThrow();
  });
  test.skipIf(process.platform!=='win32')('native rollback waits for bridge deletion and retries transient CIM failures before deleting TAP',async()=>{
    const output=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('tests/windows/network-rollback.ps1')]);
    const events=JSON.parse(output);
    expect(events.indexOf('bridge-gone')).toBeLessThan(events.indexOf('tap-deleted'));
    expect(events.at(-1)).toBe('status:rolled-back');
  });
  test.skipIf(process.platform!=='win32')('native membership repair uses only an advertised command for the missing requested member',async()=>{
    const output=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('tests/windows/network-membership.ps1')]);
    expect(JSON.parse(output)).toEqual({repairOffered:true,missingCommandRejected:true});
  });
});
