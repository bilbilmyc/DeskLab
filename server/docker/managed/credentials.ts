import forge from 'node-forge';
import {generateKeyPairSync,randomBytes,X509Certificate} from 'node:crypto';
import {mkdir,lstat,realpath,chmod,writeFile,rename,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {run} from '../../qemu';

export async function privateDirectory(directory:string){
 await mkdir(directory,{recursive:true,mode:0o700});
 await checkedDirectory(directory);
 if(process.platform==='win32'){
  const script=`$ErrorActionPreference='Stop';$p='${directory.replaceAll("'","''")}';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));[IO.Directory]::SetAccessControl($p,$acl)`;
  await run(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
 }else await chmod(directory,0o700);
}
export async function checkedDirectory(directory:string){if((await lstat(directory)).isSymbolicLink()||(await realpath(directory)).toLowerCase()!==resolve(directory).toLowerCase())throw new Error('引擎数据目录不能是链接');}
function keys(){const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});return {privateKey:forge.pki.privateKeyFromPem(pair.privateKey),publicKey:forge.pki.publicKeyFromPem(pair.publicKey)};}
async function save(path:string,value:string){await writeFile(path+'.tmp',value,{mode:0o600});await rename(path+'.tmp',path);}
export interface Credentials {directory:string;fingerprint:string;expiresAt:string;generation:string;}
export async function ensureCredentials(directory:string,id:string):Promise<Credentials>{
 if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('无效的引擎身份');
 await privateDirectory(directory);
 const metadata=join(directory,'identity.json');
 if(await Bun.file(metadata).exists()){
  const current=await Bun.file(metadata).json() as Credentials;
  const cert=new X509Certificate(await readFile(join(directory,'server.pem')));
  if(current.fingerprint!==cert.fingerprint256)throw new Error('引擎证书与登记身份不匹配');
  if(Date.parse(cert.validTo)>Date.now()+30*86400000){for(const name of ['ca.pem','client.pem','client-key.pem','server-key.pem'])if(!await Bun.file(join(directory,name)).exists())throw new Error('引擎凭据缺失，请恢复备份');return {...current,directory};}
 }
 const caKeys=keys(),ca=forge.pki.createCertificate();ca.publicKey=caKeys.publicKey;ca.serialNumber='01'+randomBytes(15).toString('hex');ca.validity.notBefore=new Date(Date.now()-300000);ca.validity.notAfter=new Date(Date.now()+10*365*86400000);
 const caName=[{name:'commonName',value:'DeskLab '+id}];ca.setSubject(caName);ca.setIssuer(caName);ca.setExtensions([{name:'basicConstraints',cA:true,critical:true},{name:'keyUsage',keyCertSign:true,cRLSign:true,critical:true}]);ca.sign(caKeys.privateKey,forge.md.sha256.create());
 await save(join(directory,'ca.pem'),forge.pki.certificateToPem(ca));
 let serverPem='';
 for(const role of ['server','client'] as const){
  const pair=keys(),cert=forge.pki.createCertificate();cert.publicKey=pair.publicKey;cert.serialNumber='01'+randomBytes(15).toString('hex');cert.validity.notBefore=ca.validity.notBefore;cert.validity.notAfter=new Date(Date.now()+2*365*86400000);cert.setSubject([{name:'commonName',value:`DeskLab-${role}-${id}`}]);cert.setIssuer(caName);
  cert.setExtensions([{name:'basicConstraints',cA:false,critical:true},{name:'keyUsage',digitalSignature:true,keyEncipherment:true,critical:true},{name:'extKeyUsage',serverAuth:role==='server',clientAuth:role==='client'},...(role==='server'?[{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'},{type:7,ip:'10.0.2.15'},{type:2,value:'localhost'}]}]:[])]);
  cert.sign(caKeys.privateKey,forge.md.sha256.create());const pem=forge.pki.certificateToPem(cert);await save(join(directory,role+'.pem'),pem);await save(join(directory,role+'-key.pem'),forge.pki.privateKeyToPem(pair.privateKey));if(role==='server')serverPem=pem;
 }
 // CA signing key is intentionally not persisted. Rotation happens while stopped.
 const cert=new X509Certificate(serverPem),current={directory,fingerprint:cert.fingerprint256,expiresAt:new Date(cert.validTo).toISOString(),generation:randomBytes(16).toString('hex')};
 await save(metadata,JSON.stringify(current));return current;
}
