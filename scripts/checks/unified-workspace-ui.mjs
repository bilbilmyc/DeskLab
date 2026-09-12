import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2]??'http://127.0.0.1:3011',api=process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin;
const state=await(await fetch(api+'/api/state')).json(),original=structuredClone(state),checks=[],errors=[],writes=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const template={id:'11111111-1111-4111-8111-111111111111',name:'开发环境模板',family:'ubuntu',description:'常用工具和项目依赖已准备好。',memory:2048,cpus:2,diskGB:24,createdAt:new Date().toISOString()};
state.templates=[template];state.catalogue=state.catalogue.map((t,i)=>({...t,templateId:i===0?template.id:undefined}));
state.machines=Array.from({length:30},(_,i)=>({id:i===0?'22222222-2222-4222-8222-222222222222':String(i).padStart(8,'0')+'-2222-4222-8222-222222222222',name:i===0?'Ubuntu 开发环境':i===1?'数据库测试':'临时测试环境 '+i,family:i%3?'ubuntu':'windows',memory:2048,cpus:2,diskGB:24,state:i%2?'stopped':'running',templateId:template.id,session:i%2?undefined:{pid:123,sshPort:2222+i},network:{mode:'nat'},createdAt:new Date().toISOString()}));
let mappings=Array.from({length:30},(_,i)=>({id:'port-'+i,ownerId:state.machines[i].id,ownerName:state.machines[i].name,ownerType:i%2?'vm':'docker',source:i%2?'vm':'docker',label:i===0?'Web 预览':'测试服务',hostAddress:'127.0.0.1',hostPort:8080+i,targetPort:80,protocol:'tcp',status:i%2?'stopped':'running',editable:i%2===1}));
const browser=await chromium.launch({headless:true}),page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.context().grantPermissions(['clipboard-read','clipboard-write']);
await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let data=state;
 if(path==='/api/network/mappings'&&req.method()==='GET')data=mappings;
 else if(req.method()==='POST'){const body=req.postDataJSON();writes.push({path,body});data={ok:true};
  if(path==='/api/settings'){Object.assign(state.settings,body);if(body.isoDirectory)state.host.isoDirectory=body.isoDirectory;}
  if(path==='/api/files/list')data={path:'D:\\DeskLab\\iso',parent:'D:\\DeskLab',entries:[],roots:[]};
 }
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
const nav=async name=>{await page.getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{level:1,name,exact:true}).waitFor();};
const fits=()=>page.evaluate(()=>({document:document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight,main:document.querySelector('main').scrollHeight<=document.querySelector('main').clientHeight+1,width:document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1}));
await mkdir('.runtime/checks/unified-ui',{recursive:true});
try{
 for(const [width,height]of[[1600,1000],[1366,768],[768,700],[320,480]]){
  await page.setViewportSize({width,height});await page.goto(origin);await page.getByRole('heading',{name:'Ubuntu 开发环境',exact:true}).waitFor();
  let metrics=await fits();check(`${width} environment shell fits`,metrics.document&&metrics.main&&metrics.width);
  const create=await page.getByRole('button',{name:'创建环境',exact:true}).boundingBox();await page.locator('.machine-results').evaluate(e=>e.scrollTop=e.scrollHeight);check(`${width} environment tools fixed`,Math.abs((await page.getByRole('button',{name:'创建环境',exact:true}).boundingBox()).y-create.y)<1);
  await page.getByLabel('搜索环境',{exact:true}).fill('数据库');check(`${width} environment search`,await page.locator('.machine-card').count()===1);await page.getByLabel('搜索环境',{exact:true}).fill('');await page.getByLabel('筛选环境状态').selectOption('stopped');check(`${width} environment state filter`,await page.locator('.machine-card').count()===15);await page.getByLabel('筛选环境状态').selectOption('all');
  await page.locator('.machine-results').evaluate(e=>e.scrollTop=0);await page.screenshot({path:`.runtime/checks/unified-ui/machines-${width}.png`});
  await page.getByRole('button',{name:'Ubuntu 开发环境 更多操作',exact:true}).click();check(`${width} running VM destructive operations protected`,await page.getByRole('dialog').getByRole('button',{name:'删除环境',exact:true}).isDisabled()&&await page.getByRole('button',{name:'保存为模板',exact:true}).isDisabled());await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'数据库测试 更多操作',exact:true}).click();await page.getByRole('button',{name:'保存为模板',exact:true}).click();check(`${width} save template flow accessible`,await page.getByRole('dialog').getByRole('button',{name:'保存为模板',exact:true}).count()>0||await page.getByRole('dialog').getByRole('button',{name:'保存设置',exact:true}).count()>0);await page.keyboard.press('Escape');
  await nav('模板库');metrics=await fits();check(`${width} template shell fits`,metrics.document&&metrics.main&&metrics.width);await page.screenshot({path:`.runtime/checks/unified-ui/templates-${width}.png`});
  await page.getByLabel('筛选模板状态').selectOption('ready');check(`${width} ready template filter`,await page.locator('.tpl-card').count()===1);await page.getByLabel('搜索模板').fill('no-match');await page.getByRole('button',{name:'清除筛选'}).click();check(`${width} template filters clear`,await page.locator('.tpl-card').count()>1);
  await page.getByRole('button',{name:/查看 .* 详情/}).first().click();check(`${width} template detail available`,await page.getByRole('heading',{name:'如何进入系统？'}).isVisible());await page.keyboard.press('Escape');
  const desktopTemplate=state.catalogue.find(t=>t.interface==='desktop'&&t.family!=='windows');if(desktopTemplate){await page.getByLabel('搜索模板').fill(desktopTemplate.name);check(`${width} desktop search result expands`,await page.getByRole('heading',{name:desktopTemplate.name,exact:true}).isVisible());await page.getByLabel('搜索模板').fill('');}
  await nav('本机设置');metrics=await fits();check(`${width} settings shell fits`,metrics.document&&metrics.main&&metrics.width);check(`${width} directory form collapsed`,!await page.getByLabel('ISO 目录',{exact:true}).isVisible());await page.screenshot({path:`.runtime/checks/unified-ui/images-${width}.png`});
  await page.locator('.iso-directory-panel>summary').click();await page.getByLabel('ISO 目录',{exact:true}).fill('D:\\镜像目录-'+width);await page.getByRole('button',{name:'保存并扫描',exact:true}).click();check(`${width} directory save preserved`,writes.at(-1).body.isoDirectory==='D:\\镜像目录-'+width);await page.locator('.iso-directory-panel>summary').click();
  await page.getByRole('button',{name:'运行与存储',exact:true}).click();await page.screenshot({path:`.runtime/checks/unified-ui/settings-${width}.png`});check(`${width} engine form collapsed`,!await page.getByLabel('QEMU 程序目录').isVisible());await page.locator('.engine-advanced>summary').click();await page.getByRole('button',{name:'保存并检测',exact:true}).click();check(`${width} engine settings save preserved`,'accelerator' in writes.at(-1).body);await page.getByRole('button',{name:'管理 ISO 目录',exact:false}).click();check(`${width} storage shortcut opens images`,await page.getByRole('button',{name:'系统镜像',exact:true}).getAttribute('aria-pressed')==='true');
  await nav('端口映射');await page.locator('.port-table tbody tr').first().waitFor();metrics=await fits();check(`${width} ports shell fits`,metrics.document&&metrics.main&&metrics.width);
  const bar=await page.locator('.ports-panel>.list-toolbar').boundingBox();await page.locator('.ports-results').evaluate(e=>e.scrollTop=e.scrollHeight);check(`${width} port tools fixed`,Math.abs((await page.locator('.ports-panel>.list-toolbar').boundingBox()).y-bar.y)<1);await page.locator('.ports-results').evaluate(e=>e.scrollTop=0);await page.screenshot({path:`.runtime/checks/unified-ui/ports-${width}.png`});
  await page.getByLabel('搜索端口映射').fill('8080');check(`${width} port search`,await page.locator('.port-table tbody tr').count()===1);await page.getByRole('button',{name:'复制端口 8080'}).click();check(`${width} Windows endpoint copy`,await page.evaluate(()=>navigator.clipboard.readText())==='127.0.0.1:8080');await page.getByRole('button',{name:'映射说明',exact:true}).click();await page.keyboard.press('Escape');
 }
 check('no browser runtime errors',errors.length===0);
}catch(e){errors.push(e.stack);await page.screenshot({path:'.runtime/checks/unified-ui/failure.png'});throw e;}finally{await browser.close();await writeFile('.runtime/checks/unified-ui/report.json',JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
