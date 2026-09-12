import {expect,test} from 'bun:test';
import {createServer,type Socket} from 'node:net';
import {allocateSshPort,ensureSshForward,forwardedSshPort} from '../server/ssh-network';
const row=(port:number,host='127.0.0.1')=>`Hub -1 (#net080):\n  TCP[HOST_FORWARD] 1628 ${host} ${port} 10.0.2.15 22 0 0\n`;
test('only loopback SSH forwarding is advertised, not other ports or active sessions',()=>{
  expect(forwardedSshPort(row(2222))).toBe(2222);
  expect(forwardedSshPort(row(2222).replace('1628','c14'))).toBe(2222);
  expect(forwardedSshPort(row(2222,'0.0.0.0'))).toBeUndefined();
  expect(forwardedSshPort(row(2222).replace(' 22 ',' 80 '))).toBeUndefined();
  expect(forwardedSshPort(row(2222).replace('HOST_FORWARD','ESTABLISHED'))).toBeUndefined();
});
test('port allocation preserves a free preference and skips occupied or reserved ports',async()=>{
  const occupied=createServer();await new Promise<void>(r=>occupied.listen(0,'127.0.0.1',r));
  try {
    const busy=(occupied.address() as {port:number}).port;
    const available=await allocateSshPort(undefined,[2222]);
    expect(available).not.toBe(2222);
    expect(await allocateSshPort(available)).toBe(available);
    expect(await allocateSshPort(busy)).not.toBe(busy);
  }finally{occupied.close();}
});
test('recovery adopts live QEMU forwarding and never installs it twice',async()=>{
  let info='Hub -1 (#net080):\n',adds=0;const sockets=new Set<Socket>();
  const monitor=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('{"QMP":{}}\n');let input='';
    socket.on('data',data=>{input+=data;let end:number;while((end=input.indexOf('\n'))>=0){const request=JSON.parse(input.slice(0,end));input=input.slice(end+1);let result='';
      if(request.arguments?.['command-line']==='info usernet')result=info;
      else if(request.arguments?.['command-line']?.startsWith('hostfwd_add')){adds++;const port=Number(request.arguments['command-line'].match(/127\.0\.0\.1:(\d+)/)[1]);info=row(port);}
      socket.write(JSON.stringify({id:request.id,return:result})+'\n');
    }});
  });
  await new Promise<void>(r=>monitor.listen(0,'127.0.0.1',r));
  try{const port=(monitor.address() as {port:number}).port;const ssh=await ensureSshForward(port);expect(await ensureSshForward(port)).toBe(ssh);expect(adds).toBe(1);}
  finally{for(const s of sockets)s.destroy();monitor.close();}
});
