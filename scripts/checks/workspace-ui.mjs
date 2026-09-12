import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=process.env.PLAYWRIGHT_MODULE_PATH?await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH)):createRequire(import.meta.url)('playwright');
const origin=process.argv[2]??'http://127.0.0.1:43213';
const snapshot=await(await fetch((process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin)+'/api/state')).json();
snapshot.sshKey??={publicKey:'ssh-ed25519 '+ 'A'.repeat(68)+' ui-fixture',fingerprint:'SHA256:ui-fixture',privateKeyPath:'D:\\DeskLab\\fixture\\id_ed25519'};
const id='11111111-1111-4111-8111-111111111111',adapterId='22222222-2222-4222-8222-222222222222';
const vm={id,name:'Ubuntu UI fixture',family:'ubuntu',memory:2048,cpus:2,diskGB:20,state:'running',session:{sshPort:2222},network:{mode:'nat'},createdAt:'2026-09-12T00:00:00Z'};
snapshot.machines=[vm];
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();const checks=[],errors=[],writes=[];
page.on('pageerror',e=>errors.push(e.message));
await page.context().grantPermissions(['clipboard-read','clipboard-write']);
await page.route('**/api/**',route=>{
 const req=route.request(),path=new URL(req.url()).pathname;
 let data=snapshot;
 if(path==='/api/isos/inspect')return route.fulfill({json:{status:'match',message:'安装盘初步匹配，创建前将校验完整性。',requiresConfirmation:false}});
 if(path==='/api/network')data={adapters:[{id:adapterId,name:'DeskLab TAP',description:'TAP fixture',bridged:true}]};
 else if(path==='/api/network/setup')data={physicalAdapters:[{id:adapterId,name:'以太网',description:'Physical fixture',status:'Up',wireless:false}],canPrepare:false,message:'自动桥接正在进行本机兼容性验证'};
 else if(path==='/api/ssh/key')data=snapshot.sshKey;
 else if(req.method()==='POST'){
  writes.push({path,body:req.postDataJSON()});data={ticket:'fixture'};
  if(path.endsWith('/network')){vm.network=req.postDataJSON();data=vm;}
 }
 return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
await page.routeWebSocket('**/vnc?*',ws=>ws.close());
const check=(name,pass,data)=>{checks.push({name,pass:!!pass,data});};
const metrics=()=>page.evaluate(()=>{
 const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,scroll:e.scrollHeight,client:e.clientHeight,width:e.scrollWidth,clientWidth:e.clientWidth};};
 return{height:innerHeight,width:innerWidth,doc:box(document.documentElement),main:box(document.querySelector('main')),footer:box(document.querySelector('.app-footer')),screen:box(document.querySelector('.desktop-screen')),caption:box(document.querySelector('.desktop-caption'))};
});
function shell(name,m){check(name+' document fits',m.doc.scroll<=m.height&&m.doc.width<=m.width,m);check(name+' footer visible',m.footer.bottom<=m.height+.5,m.footer);}
await mkdir('.runtime/checks/workspace-ui',{recursive:true});
try{
 for(const [width,height]of[[2560,1280],[1920,1080],[1440,900],[1024,768],[768,900],[320,800],[1440,500],[768,500],[320,480]]){
  const key=width+'x'+height;await page.setViewportSize({width,height});await page.goto(origin);await page.getByRole('button',{name:'打开系统',exact:true}).waitFor();
  await page.getByRole('button',{name:'打开系统',exact:true}).click();let m=await metrics();shell(key+' console',m);check(key+' console fits with connection bar',m.main.scroll<=m.main.client&&m.screen.height>=60&&m.caption.bottom<=m.footer.top,m);
  await page.getByRole('button',{name:'连接信息与网络设置',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'SSH 密钥连接'}).waitFor();
  check(key+' live network selection protected',await dialog.getByLabel('网络类型',{exact:true}).isDisabled());
  await dialog.getByLabel('复制密钥 SSH 命令',{exact:true}).click();const command=await page.evaluate(()=>navigator.clipboard.readText());check(key+' key SSH command copied',command.includes(' -i ')&&command.includes('-o IdentitiesOnly=yes -p 2222 root@127.0.0.1'));
  check(key+' legacy authorization guidance shown',await dialog.getByText('已有镜像需先授权公钥',{exact:false}).isVisible());
  check(key+' dialog has no horizontal overflow',await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));
  if(width===1440&&height===900)await page.screenshot({path:'.runtime/checks/workspace-ui/connection.png'});
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'本机设置',exact:true}).click();m=await metrics();shell(key+' settings',m);if(width===2560)check('large default settings no internal scroll',m.main.scroll<=m.main.client,m);
  await page.locator('.extra-templates>summary').click();await page.locator('#settings-images .iso-card').last().locator('button').last().focus();check(key+' last card keyboard accessible',await page.locator('#settings-images .iso-card').last().locator('button').last().evaluate(e=>{const r=e.getBoundingClientRect(),m=document.querySelector('main').getBoundingClientRect();return r.top>=m.top&&r.bottom<=m.bottom;}));
 }
 await page.setViewportSize({width:1440,height:1000});vm.state='stopped';delete vm.session;await page.goto(origin);await page.getByRole('button',{name:'连接与网络',exact:true}).click();
 const dialog=page.getByRole('dialog');
 check('only NAT is offered',await dialog.getByLabel('网络类型',{exact:true}).locator('option').count()===1&&await dialog.getByLabel('网络类型',{exact:true}).inputValue()==='nat');
 check('no bridge setup entry remains',await dialog.locator('.network-setup').count()===0);
 await dialog.getByRole('button',{name:'保存网络配置',exact:true}).click();await dialog.getByText('网络配置已保存',{exact:true}).waitFor();
 check('stopped NAT configuration persists',writes.at(-1)?.body.mode==='nat'&&Object.keys(writes.at(-1)?.body).length===1);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'创建环境',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/Ubuntu 24/}).first().click();await page.getByRole('dialog').getByRole('button',{name:/下一步/}).click();
 check('new instance has NAT default',await page.getByRole('dialog').getByLabel('网络类型',{exact:true}).inputValue()==='nat');
 await page.getByRole('dialog').locator('.create-connection>summary').click();
 check('create flow explains default key authentication',await page.getByRole('dialog').getByText(/默认使用本机 Ed25519/).isVisible());
 await page.screenshot({path:'.runtime/checks/workspace-ui/create.png'});
 check('only expected intercepted requests',writes.every(x=>x.path.endsWith('/network')||x.path.endsWith('/console')));
}catch(e){errors.push(e.stack);}finally{await browser.close();await writeFile('.runtime/checks/workspace-ui/report.json',JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,failures:checks.filter(x=>!x.pass),errors},null,2));process.exitCode=checks.some(x=>!x.pass)||errors.length?1:0;
