import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2]??'http://127.0.0.1:3011',api=process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin;
const state=await(await fetch(api+'/api/state')).json();state.machines=[];
const live=await(await fetch(api+'/api/docker')).json();
const engine={...live.managed.engine,id:'fixture',state:'stopped',pid:undefined,initialized:true,cpus:2,memoryMB:2048,diskGB:64,directory:'D:\\DeskLab\\data\\engines\\fixture'};
const base=()=>({available:true,contexts:[{name:'desktop-linux',current:true}],engine:{id:'fixture',kind:'managed'},managed:{available:true,engine:{...engine},backups:[]},containers:[],images:[],projects:[],operations:[]});
let data=base();const checks=[],errors=[],writes=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const browser=await chromium.launch({headless:true}),page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname;let result=state;
 if(path==='/api/docker')result=data;
 else if(request.method()==='POST'){const body=request.postDataJSON();writes.push({path,body});result={id:'op',text:'fixture logs'};
  if(path.endsWith('/configure'))Object.assign(data.managed.engine,body);
  if(path.endsWith('/backup'))data.managed.backups=[{id:'backup',label:'界面测试备份',createdAt:new Date().toISOString(),bytes:128*1048576}];
  if(path.endsWith('/stop')||path.endsWith('/force-stop')){data.managed.engine.state='stopped';delete data.managed.engine.pid;}
  if(path.endsWith('/connect'))data.engine={id:'external',kind:'external',context:body.context};
 }await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
});
const visit=async()=>{await page.goto(origin);await page.getByRole('button',{name:'Docker 容器',exact:true}).click();await page.getByRole('button',{name:'引擎设置',exact:true}).waitFor();};
const refresh=async()=>{await page.getByRole('button',{name:'刷新 Docker',exact:true}).click();};
await mkdir('.runtime/checks/docker-workspace',{recursive:true});
try {
 for(const [width,height] of [[1600,1000],[1366,768],[768,700],[320,480]]){
  data=base();await page.setViewportSize({width,height});await visit();
  check(`${width} empty state fits viewport`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
  check(`${width} maintenance hidden by default`,await page.getByRole('button',{name:'停机备份',exact:true}).count()===0);
  if(width===1600)await page.screenshot({path:'.runtime/checks/docker-workspace/empty.png'});
  data.containers=Array.from({length:45},(_,i)=>({id:'container-'+i,name:i===0?'frontend-preview':i===1?'postgres-development-database-with-a-long-name':'worker-'+String(i).padStart(2,'0'),image:i===0?'nginx:alpine':i===1?'postgres:17':'redis:7-alpine',state:i%3?'running':'exited',owned:i!==2,ports:i<2?[{hostAddress:'127.0.0.1',hostPort:8080+i,targetPort:80,protocol:'tcp'}]:[]}));
  await refresh();await page.getByRole('heading',{name:'frontend-preview',exact:true}).waitFor();
  const toolbar=await page.locator('.docker-resource-toolbar').boundingBox();await page.locator('.docker-results').evaluate(e=>e.scrollTop=e.scrollHeight);
  check(`${width} resource list scrolls`,await page.locator('.docker-results').evaluate(e=>e.scrollTop>0));
  check(`${width} toolbar remains fixed`,Math.abs((await page.locator('.docker-resource-toolbar').boundingBox()).y-toolbar.y)<1);
  check(`${width} shell does not scroll`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight&&document.querySelector('#main-content').scrollHeight<=document.querySelector('#main-content').clientHeight+1));
  await page.getByRole('searchbox',{name:'搜索 Docker 资源'}).fill('8080');check(`${width} port search`,await page.locator('.docker-results .container-row').count()===1);
  await page.getByRole('searchbox',{name:'搜索 Docker 资源'}).fill('');await page.getByLabel('筛选容器状态').selectOption('readonly');check(`${width} external read-only actions hidden`,await page.locator('.docker-results .container-row').count()===1&&await page.locator('.docker-results .container-row button').count()===0);
  await page.getByLabel('筛选容器状态').selectOption('all');await page.getByRole('searchbox',{name:'搜索 Docker 资源'}).fill('does-not-exist');await page.getByRole('button',{name:'清除筛选'}).click();check(`${width} clear filters`,await page.locator('.docker-results .container-row').count()===45);
  await page.locator('.docker-results').evaluate(e=>e.scrollTop=0);await page.screenshot({path:`.runtime/checks/docker-workspace/list-${width}.png`});
  await page.getByRole('button',{name:'创建容器',exact:true}).click();let modal=page.getByRole('dialog');await modal.getByLabel('名称',{exact:true}).fill('new-service');await modal.getByLabel('端口映射',{exact:true}).fill('8088:80\n5354:53/udp');check(`${width} create dialog fits`,await modal.evaluate(e=>e.scrollWidth<=e.clientWidth));await modal.getByRole('button',{name:'创建并启动',exact:true}).click();await modal.waitFor({state:'hidden'});check(`${width} port protocol preserved`,writes.at(-1).body.ports[1].protocol==='udp');
  await page.getByRole('button',{name:'引擎设置',exact:true}).click();await page.getByRole('button',{name:'调整资源',exact:true}).click();modal=page.getByRole('dialog');await modal.getByLabel('内存（MB）').fill('4096');await modal.getByRole('button',{name:'保存配置'}).click();await modal.waitFor({state:'hidden'});check(`${width} resource settings work`,writes.at(-1).body.memoryMB===4096);
  await page.getByRole('button',{name:'引擎设置',exact:true}).click();await page.getByRole('button',{name:'停机备份',exact:true}).click();await page.getByText('备份与恢复 · 1 份',{exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();check(`${width} restore confirmation preserved`,await page.getByRole('button',{name:'确认恢复'}).isVisible());await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'操作记录',exact:true}).click();check(`${width} history opens on demand`,await page.getByRole('dialog',{name:'Docker 操作记录'}).isVisible());await page.keyboard.press('Escape');check(`${width} escape closes and returns focus`,await page.getByRole('button',{name:'操作记录',exact:true}).evaluate(e=>e===document.activeElement));
 }
 await page.setViewportSize({width:1366,height:768});data=base();data.managed.engine.state='running';data.managed.engine.pid=123;await visit();await page.getByRole('button',{name:'引擎设置',exact:true}).click();check('running engine backup remains disabled',await page.getByRole('button',{name:'停机备份'}).isDisabled());await page.keyboard.press('Escape');
 data.managed.engine.state='error';data.managed.engine.message='启动失败，请检查引擎日志。';await refresh();await page.getByRole('button',{name:'检查引擎 →'}).click();await page.getByRole('button',{name:'强制停止引擎'}).click();const before=writes.length;check('force stop waits for confirmation',writes.length===before);await page.getByRole('button',{name:'确认强制停止'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});check('force stop confirmation submitted',writes.at(-1).body.confirm===true);
 data=base();data.images=[{id:'sha256:fixture',name:'nginx:alpine',size:'50 MB'}];data.projects=[{id:'project',name:'web-stack',filePath:'D:\\项目\\compose.yaml',composeName:'web-stack'}];await refresh();await page.getByRole('button',{name:'镜像 1',exact:true}).click();await page.getByRole('cell',{name:'nginx:alpine sha256:fixture'}).waitFor();check('images remain usable',await page.getByRole('button',{name:'创建容器',exact:true}).isVisible());await page.getByRole('button',{name:'Compose 1',exact:true}).click();await page.getByRole('heading',{name:'web-stack'}).waitFor();check('compose controls remain visible',await page.getByRole('button',{name:'启动 / 更新'}).isVisible());
 await page.getByRole('button',{name:'外部 Docker',exact:true}).click();await page.getByRole('button',{name:'连接引擎',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'连接引擎',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});check('external engine connection preserved',writes.at(-1).body.context==='desktop-linux');
 check('no browser errors',errors.length===0);
}catch(error){errors.push(error.message);await page.screenshot({path:'.runtime/checks/docker-workspace/failure.png'});throw error;}finally{await browser.close();await writeFile('.runtime/checks/docker-workspace/report.json',JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
