import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2];
const snapshot=await(await fetch((process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin)+'/api/state')).json();
const vm={id:'11111111-1111-4111-8111-111111111111',name:'Ubuntu fixture',family:'linux',memory:512,cpus:1,diskGB:8,state:'stopped',createdAt:new Date().toISOString()};snapshot.machines=[vm];
const docker={available:true,contexts:[{name:'desktop-linux',current:true}],engine:{context:'desktop-linux'},images:[{id:'123',name:'nginx:alpine',size:'50 MB'}],projects:[],operations:[],containers:[{id:'a'.repeat(64),name:'existing-service',image:'nginx:alpine',state:'running',owned:false,ports:[]}]};
let mappings=[];const writes=[],checks=[];
const browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let data=snapshot;
 if(path==='/api/docker')data=docker;
 else if(path==='/api/network/mappings'&&req.method()==='GET')data=mappings;
 else if(req.method()==='POST'){const body=req.postDataJSON();writes.push({path,body});data={id:'operation'};
  if(path==='/api/network/mappings'){mappings=[{...body,id:'mapping',ownerType:'vm',ownerName:vm.name,hostAddress:'127.0.0.1',source:'vm',status:'stopped',editable:true}];}
  if(path.endsWith('/mapping/delete'))mappings=[];
 }await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
await mkdir('.runtime/checks/docker-ui',{recursive:true});
try {
 for(const [width,height] of [[1440,900],[768,700],[320,480]]){
  await page.setViewportSize({width,height});await page.goto(origin);await page.getByRole('button',{name:'Docker 容器',exact:true}).click();await page.getByRole('heading',{name:/existing-service/}).waitFor();
  check(`${width} external containers are read-only`,await page.locator('.container-row').first().locator('button').count()===0);
  check(`${width} Docker document fits`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
  await page.getByRole('button',{name:'创建容器',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('名称',{exact:true}).fill('ui-service');await dialog.getByLabel('端口映射',{exact:true}).fill('8088:80\n5354:53/udp');
  check(`${width} container dialog fits horizontally`,await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));
  await dialog.getByRole('button',{name:'创建并启动',exact:true}).click();await dialog.waitFor({state:'hidden'});
  check(`${width} container form preserves TCP and UDP`,writes.at(-1).body.ports[1].protocol==='udp'&&writes.at(-1).body.ports[0].hostPort===8088);
  await page.getByRole('button',{name:'端口映射',exact:true}).click();await page.getByRole('button',{name:'添加虚拟机映射',exact:true}).click();
  await page.getByRole('dialog').getByLabel('本机端口',{exact:true}).fill('8089');await page.getByRole('dialog').getByRole('button',{name:'保存映射',exact:true}).click();
  await page.getByRole('cell',{name:'127.0.0.1:8089 → 80/TCP',exact:true}).waitFor();check(`${width} mapping is saved and shown`,writes.at(-1).body.hostPort===8089);
  check(`${width} mapping document fits`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
  if(width===1440)await page.screenshot({path:'.runtime/checks/docker-ui/ports.png'});
  await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('heading',{name:'暂无匹配的端口映射'}).waitFor();
 }
 check('no browser errors',errors.length===0);
}catch(error){errors.push(error.message);await page.screenshot({path:'.runtime/checks/docker-ui/failure.png'});throw error;}finally{await browser.close();await writeFile('.runtime/checks/docker-ui/report.json',JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
