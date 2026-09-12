import {expect,test} from 'bun:test';
import {assertCanQuit,trayAction,wantsTray} from '../server/tray';
test('tray accepts only defined menu events without evaluating command text',()=>{
  expect(trayAction('{"action":"open"}')).toBe('open');
  expect(trayAction('{"action":"quit"}')).toBe('quit');
  expect(trayAction('{"action":"ready"}')).toBe('ready');
  for(const input of ['null','{}','not json','{"action":"exec"}','{"action":"http://example.com"}'])expect(trayAction(input)).toBeUndefined();
});
test('tray and browser exit protect all active or unverified guests',()=>{
  for(const state of ['running','starting','stopping'])expect(()=>assertCanQuit([{state}],0)).toThrow('正常关机');
  expect(()=>assertCanQuit([{state:'error'}],1)).toThrow('正常关机');
  expect(()=>assertCanQuit([{state:'stopped'},{state:'error'}],0)).not.toThrow();
});
test('headless tests can explicitly disable the tray',()=>{
  const previous=process.env.LAB_TRAY;process.env.LAB_TRAY='0';
  try{expect(wantsTray()).toBe(false);}finally{if(previous===undefined)delete process.env.LAB_TRAY;else process.env.LAB_TRAY=previous;}
});
