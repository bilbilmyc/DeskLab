import {appendFile,mkdir,readFile,rename,rm} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';

export function preferredPort(value=process.env.LAB_PORT) {
  if(value!==undefined&&!/^\d+$/.test(value))throw new Error('LAB_PORT 必须是有效的端口数字');
  const port=Number(value??43210);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('LAB_PORT 必须在 0 到 65535 之间');
  return port;
}
export function bindAvailable<T>(port:number,bind:(port:number)=>T):T {
  try{return bind(port);}catch(error){
    if(!port||!['EADDRINUSE','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;
    return bind(0);
  }
}
const samePath=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
export async function existingInstance(root:string,fallbackPort:number):Promise<string|undefined> {
  try {
    const owner=Number((await readFile(join(root,'owner.lock'),'utf8')).trim());
    if(!Number.isSafeInteger(owner)||owner<=0)return;
    const ports=new Set<number>([fallbackPort]);
    try {
      const record=JSON.parse(await readFile(join(root,'instance.json'),'utf8'));
      if(record.version===1&&record.pid===owner&&Number.isInteger(record.port)&&record.port>0&&record.port<=65535)ports.add(record.port);
    }catch{}
    for(const port of ports){
      if(!port)continue;
      try {
        const origin=`http://127.0.0.1:${port}`;
        const response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(500)});
        const health=await response.json();
        if(response.ok&&health.ok===true&&health.pid===owner&&typeof health.dataDirectory==='string'&&samePath(health.dataDirectory,root))return origin;
      }catch{}
    }
  }catch{}
}
export async function publishInstance(root:string,port:number) {
  const path=join(root,'instance.json'),temporary=join(root,`instance-${crypto.randomUUID()}.tmp`);
  await Bun.write(temporary,JSON.stringify({version:1,pid:process.pid,port}));
  try{await rename(temporary,path);}finally{await rm(temporary,{force:true});}
  return async()=>{
    try{if(JSON.parse(await readFile(path,'utf8')).pid===process.pid)await rm(path,{force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  };
}
export function wantsBrowser() {
  return process.env.LAB_OPEN!=='0'&&(process.env.LAB_OPEN==='1'||process.argv.includes('--open')||basename(process.execPath).toLowerCase()==='desklab.exe');
}
export async function openBrowser(origin:string) {
  if(process.platform!=='win32')return;
  await new Promise<void>((done,reject)=>{
    const child=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','rundll32.exe'),['url.dll,FileProtocolHandler',origin],{windowsHide:true,stdio:'ignore'});
    const timeout=setTimeout(()=>{child.unref();done();},5000);
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',code=>{clearTimeout(timeout);code===0?done():reject(new Error(`无法打开默认浏览器，请手动访问 ${origin}`));});
  });
}
export async function reportStartupError(error:unknown,root?:string,show=wantsBrowser()) {
  const message=error instanceof Error?error.message:String(error);
  const fallback=join(process.env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'DeskLab','data');
  let logPath='';
  for(const directory of [...new Set([root,fallback].filter((x):x is string=>!!x))]){
    try {
      await mkdir(join(directory,'logs'),{recursive:true});logPath=join(directory,'logs','startup.log');
      await appendFile(logPath,`${new Date().toISOString()} ${message}\n`);break;
    }catch{logPath='';}
  }
  const text=`DeskLab 启动失败\n\n${message}${logPath?`\n\n详细记录：${logPath}`:''}`;
  console.error(text);
  if(show&&process.platform==='win32'){
    const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
    const script=`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.MessageBox]::Show(${literal(text)},'DeskLab',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null`;
    await new Promise<void>(done=>{
      const child=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
      child.on('error',()=>done());child.on('close',()=>done());
    });
  }
  return {message,logPath};
}
