import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));const origin=process.argv[2];const state=await(await fetch((process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin)+'/api/state')).json();state.machines=[];
const browser=await chromium.launch({headless:true}),page=await browser.newPage(),checks=[],errors=[],writes=[];
page.on('pageerror',e=>errors.push(e.message));let data;
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname;let result=state;
 if(path==='/api/docker')result=data;
 else if(request.method()==='POST'){const body=request.postDataJSON();writes.push({path,body});result={id:'operation'};
  if(path.endsWith('/enable')){data.engine={id:'engine',name:'DeskLab 内置引擎',kind:'managed'};data.managed.engine={id:'engine',state:'running',pid:123,initialized:true,cpus:body.cpus,memoryMB:body.memoryMB,diskGB:body.diskGB,directory:'D:\\DeskLab\\data\\engines\\fixture',diskBytes:128*1048576,diskFreeBytes:60*1024**3,imageAvailable:true};}
  if(path.endsWith('/stop')||path.endsWith('/force-stop')){data.managed.engine.state='stopped';delete data.managed.engine.pid;}
  if(path.endsWith('/configure'))Object.assign(data.managed.engine,body);
  if(path.endsWith('/backup'))data.managed.backups=[{id:'backup',label:'测试备份',createdAt:new Date().toISOString(),bytes:128*1048576}];
 }await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
});
await mkdir('.runtime/checks/docker-managed/ui',{recursive:true});
try {
 for(const [width,height] of [[1440,900],[768,700],[320,600]]){
  data={available:true,contexts:[],containers:[],images:[],projects:[],operations:[],managed:{available:true,imageId:'fixture',backups:[]}};
  await page.setViewportSize({width,height});await page.goto(origin);await page.getByRole('button',{name:'Docker 容器',exact:true}).click();await page.getByRole('button',{name:'启用内置引擎',exact:true}).click();
  let modal=page.getByRole('dialog');await modal.getByLabel('CPU 核数').fill('3');await modal.getByLabel('内存（MB）').fill('3072');check(`${width} setup dialog fits`,await modal.evaluate(e=>e.scrollWidth<=e.clientWidth));await modal.getByRole('button',{name:'准备并启动'}).click();await modal.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'引擎设置',exact:true}).waitFor();check(`${width} initialization submits resources`,writes.at(-1).body.memoryMB===3072&&writes.at(-1).body.diskGB===64);
  check(`${width} document and footer fit`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight&&document.querySelector('.app-footer').getBoundingClientRect().bottom<=innerHeight+1));
  await page.getByRole('button',{name:'引擎设置',exact:true}).click();
  check(`${width} running engine cannot be backed up`,await page.getByRole('button',{name:'停机备份',exact:true}).isDisabled());
  await page.keyboard.press('Escape');
  if(width===1440)await page.screenshot({path:'.runtime/checks/docker-managed/ui/desktop.png'});
  await page.getByRole('button',{name:'正常停止',exact:true}).click();await page.getByRole('button',{name:'引擎设置',exact:true}).click();await page.getByRole('button',{name:'调整资源',exact:true}).click();modal=page.getByRole('dialog');await modal.getByLabel('内存（MB）').fill('4096');await modal.getByRole('button',{name:'保存配置'}).click();await modal.waitFor({state:'hidden'});check(`${width} resource edit does not resize the disk`,writes.at(-1).body.memoryMB===4096&&!('diskGB' in writes.at(-1).body));
  await page.getByRole('button',{name:'引擎设置',exact:true}).click();await page.getByRole('button',{name:'停机备份',exact:true}).click();await page.getByText('备份与恢复 · 1 份',{exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();check(`${width} restore requires explicit dialog`,await page.getByRole('dialog').getByRole('button',{name:'确认恢复'}).isVisible());await page.getByRole('button',{name:'取消',exact:true}).click();
  data.managed.engine.state='error';data.managed.engine.pid=123;await page.reload();await page.getByRole('button',{name:'Docker 容器',exact:true}).click();await page.getByRole('button',{name:'引擎设置',exact:true}).click();await page.getByRole('button',{name:'强制停止引擎',exact:true}).click();const before=writes.length;check(`${width} force stop does not submit before confirmation`,writes.length===before);await page.getByRole('button',{name:'确认强制停止',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});check(`${width} force stop uses explicit confirmation`,writes.at(-1).body.confirm===true);
 }
 check('no browser errors',errors.length===0);
}catch(error){errors.push(error.message);await page.screenshot({path:'.runtime/checks/docker-managed/ui/failure.png'});throw error;}finally{await browser.close();await writeFile('.runtime/checks/docker-managed/ui/report.json',JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
