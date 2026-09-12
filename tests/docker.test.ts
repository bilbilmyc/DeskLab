import {test,expect} from 'bun:test';
import {containerInput} from '../server/docker/service';
import {validateCompose} from '../server/docker/compose';
test('container requests have resource defaults and reject host CLI flag injection',()=>{
  const value=containerInput.parse({name:'web',image:'alpine:3.20'});expect(value.memoryMB).toBe(512);expect(value.cpus).toBe(1);
  for(const input of [{name:'--privileged',image:'alpine'},{name:'web',image:'--privileged'},{name:'web',image:'alpine',privileged:true},{name:'web',image:'alpine',ports:[{hostPort:8080,targetPort:80,hostAddress:'0.0.0.0'}]}])expect(containerInput.safeParse(input).success).toBe(false);
});
test('Compose accepts named-volume services and rejects unsupported host access and ambiguous ports',()=>{
  const base={services:{web:{image:'alpine',ports:[{published:'18080',target:80}],volumes:[{type:'volume',source:'data',target:'/data'}]}},volumes:{data:{}}};
  expect(validateCompose(base)).toEqual([{service:'web',hostPort:18080,targetPort:80,protocol:'tcp'}]);
  for(const change of [{privileged:true},{build:'.'},{network_mode:'host'},{container_name:'external-user-container'},{volumes:[{type:'bind',source:'/var/run/docker.sock',target:'/var/run/docker.sock'}]},{ports:[{published:'8080-8085',target:80}]}])expect(()=>validateCompose({services:{web:{image:'alpine',...change}}})).toThrow();
});
