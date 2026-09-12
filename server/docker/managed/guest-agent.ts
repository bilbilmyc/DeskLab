import {createConnection} from 'node:net';
import {randomInt} from 'node:crypto';
// Only the fixed read-only command is exported. QGA is not exposed through HTTP.
export function guestFilesystems(port:number):Promise<Array<{mountpoint:string;'total-bytes'?:number;'used-bytes'?:number}>>{
 return new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port}),sync=randomInt(1,2**48-1);let buffer=Buffer.alloc(0),synchronized=false,finished=false;
  const done=(error?:Error,value?:any)=>{if(finished)return;finished=true;socket.destroy();error?reject(error):resolve(value);};
  socket.setTimeout(5000,()=>done(new Error('客体状态读取超时')));socket.on('error',e=>done(e));socket.on('close',()=>{if(!finished)done(new Error('客体状态连接已断开'));});
  socket.on('connect',()=>{socket.write(Buffer.from([255]));socket.write(JSON.stringify({execute:'guest-sync-delimited',arguments:{id:sync}})+'\n');});
  socket.on('data',chunk=>{const sentinel=chunk.lastIndexOf(255);if(sentinel>=0)buffer=chunk.subarray(sentinel+1);else buffer=Buffer.concat([buffer,chunk]);if(buffer.length>1048576)return done(new Error('客体状态返回过大'));let end:number;
   while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+1);let reply;try{reply=JSON.parse(line);}catch{continue;}
    if(!synchronized){if(reply.return===sync){synchronized=true;socket.write('{"execute":"guest-get-fsinfo"}\n');}continue;}
    if(reply.error)return done(new Error(reply.error.desc));if(Array.isArray(reply.return))return done(undefined,reply.return);
   }
  });
 });
}
