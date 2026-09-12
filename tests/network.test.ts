import {expect,test} from 'bun:test';
import {networkInput,createInput} from '../server/validation';
import {networkArguments} from '../server/network';
test('existing create requests keep NAT and new bridge requests are rejected',()=>{
  expect(createInput.parse({name:'legacy',family:'linux',memory:512,cpus:1,diskGB:8,isoPath:'x.iso'}).network).toBeUndefined();
  expect(networkInput.safeParse({mode:'bridged'}).success).toBe(false);
  expect(networkInput.safeParse({mode:'bridged',adapterId:crypto.randomUUID()}).success).toBe(false);
  expect(networkInput.parse({mode:'nat'})).toEqual({mode:'nat'});
  expect(networkInput.safeParse({mode:'bridged',adapterId:crypto.randomUUID(),address:'127.0.0.1;evil'}).success).toBe(false);
});
test('NAT is loopback-only and legacy bridge settings cannot launch TAP',()=>{
  const nat=networkArguments(undefined,2222);expect(nat).toEqual(['-nic','user,model=e1000,hostfwd=tcp:127.0.0.1:2222-:22']);
  const id=crypto.randomUUID(),network={mode:'bridged' as const,adapterId:id};
  expect(()=>networkArguments(network,2222)).toThrow();
  expect(()=>networkArguments(network,2222,{id,name:'tap',description:'TAP',bridged:false})).toThrow();
  expect(()=>networkArguments(network,2222,{id,name:'DeskLab,TAP',description:'TAP',bridged:true})).toThrow('桥接功能已停用');
  expect(networkArguments({mode:'nat'},2223,undefined,'02:12:34:56:78:90')).toEqual(['-nic','user,model=e1000,mac=02:12:34:56:78:90,hostfwd=tcp:127.0.0.1:2223-:22']);
});
