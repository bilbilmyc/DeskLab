import {spawn} from 'node:child_process';
import {join} from 'node:path';

export function dockerExecutable() {
  return Bun.which('docker',{PATH:process.env.PATH})??(process.platform==='win32'&&Bun.file(join(process.env.ProgramFiles??'C:\\Program Files','Docker/Docker/resources/bin/docker.exe')).size>0?join(process.env.ProgramFiles??'C:\\Program Files','Docker/Docker/resources/bin/docker.exe'):undefined);
}
export function dockerRun(args:string[],timeout=30000,includeStderr=false,options?:{executable:string;env?:Record<string,string>}):Promise<string> {
  const executable=options?.executable??dockerExecutable();if(!executable)return Promise.reject(new Error('未找到 Docker CLI，请先安装并启动 Docker Desktop。'));
  return new Promise((resolve,reject)=>{
    const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,...options?.env,DOCKER_CLI_HINTS:'false'}});
    let stdout='',stderr='',settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve((stdout+(includeStderr?stderr:'')).trim());};
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>4*1024*1024){child.kill();finish(new Error('Docker 返回内容过大，请缩小操作范围'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);});
    const timer=setTimeout(()=>{child.kill();finish(new Error('Docker 操作超时，请检查引擎状态；正在拉取的镜像可重试。'));},timeout);
    child.once('error',e=>finish(e));child.once('close',code=>finish(code===0?undefined:new Error(stderr.trim()||`Docker 操作失败 (${code})`)));
  });
}
export function jsonLines<T>(text:string):T[]{return text?text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[];}
