import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2]??'http://127.0.0.1:3011',api=process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin;
const state=await(await fetch(api+'/api/state')).json();state.machines=[];
const template={id:'11111111-1111-4111-8111-111111111111',builtinId:state.catalogue[0].id,name:state.catalogue[0].name,family:'ubuntu',memory:2048,cpus:2,diskGB:16,createdAt:new Date().toISOString()};
state.templates=[template];state.catalogue=state.catalogue.map((t,i)=>({...t,templateId:i===0?template.id:undefined}));
state.isoLibrary.resources=state.isoLibrary.resources.map(i=>({...i,isoPath:'D:\\fixtures\\'+i.file}));
const checks=[],errors=[],writes=[];const check=(name,pass)=>{assert.ok(pass,name);checks.push(name);};
await mkdir('.runtime/checks/readability',{recursive:true});const browser=await chromium.launch({headless:true});
try{
 for(const [width,height,scale]of[[3840,1765,1],[2560,1280,1.5],[2560,1280,1],[1920,960,2],[1920,1080,1],[1280,720,1],[320,600,1]]){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:scale}),page=await context.newPage(),label=`${width}x${height}@${scale}`;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{const req=route.request();if(new URL(req.url()).pathname==='/api/isos/inspect')return route.fulfill({json:{status:'match',message:'安装盘初步匹配，创建前将校验完整性。',requiresConfirmation:false}});if(req.method()==='POST'){writes.push({path:new URL(req.url()).pathname,body:req.postDataJSON()});await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'测试拦截：不创建实际环境'})});}else await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(state)});});
  await page.goto(origin);await page.getByRole('button',{name:'模板库',exact:true}).click();await page.locator('.tpl-card').first().waitFor();
  check(`${label} document fits`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
  const metrics=await page.locator('.tpl-card').first().evaluate(el=>({border:parseFloat(getComputedStyle(el).borderLeftWidth),weight:Number(getComputedStyle(el.querySelector('p')).fontWeight)}));check(`${label} readable borders and body weight`,metrics.border>=1.3&&metrics.weight>=500);
  await page.screenshot({animations:'disabled',path:`.runtime/checks/readability/templates-${width}-${scale}.png`});
  await page.getByRole('button',{name:'创建环境',exact:true}).click();let modal=page.getByRole('dialog');
  check(`${label} resources directly visible`,await modal.getByLabel('处理器（核）',{exact:true}).isVisible()&&await modal.getByLabel('内存（MB）',{exact:true}).isVisible()&&await modal.getByLabel('磁盘容量（GB）',{exact:true}).isVisible());
  await modal.getByLabel('磁盘容量（GB）',{exact:true}).fill('8');check(`${label} shrink blocked in form`,!await modal.locator('form').evaluate(f=>f.checkValidity()));
  await modal.getByLabel('处理器（核）',{exact:true}).fill('3');await modal.getByLabel('内存（MB）',{exact:true}).fill('3072');await modal.getByLabel('磁盘容量（GB）',{exact:true}).fill('80');
  check(`${label} dialog fits horizontally`,await modal.evaluate(e=>e.scrollWidth<=e.clientWidth));await page.screenshot({animations:'disabled',path:`.runtime/checks/readability/resources-${width}-${scale}.png`});
  await modal.getByRole('button',{name:'创建并启动',exact:true}).click();await modal.getByText('测试拦截：不创建实际环境',{exact:true}).waitFor();check(`${label} custom resources sent`,writes.at(-1).body.cpus===3&&writes.at(-1).body.memory===3072&&writes.at(-1).body.diskGB===80&&writes.at(-1).body.templateId===template.id);await modal.getByRole('button',{name:'取消',exact:true}).click();
  const recipe=state.catalogue.find(t=>!t.templateId&&t.autoInstall);if(recipe){await page.locator('.tpl-card').filter({has:page.getByRole('heading',{name:recipe.name,exact:true})}).getByRole('button',{name:'自动安装系统',exact:true}).click();modal=page.getByRole('dialog');check(`${label} installation minimum retained`,Number(await modal.getByLabel('内存（MB）',{exact:true}).getAttribute('min'))===recipe.memory&&Number(await modal.getByLabel('磁盘容量（GB）',{exact:true}).getAttribute('min'))===recipe.diskGB);await modal.getByRole('button',{name:'取消',exact:true}).click();}
  await context.close();
 }
 check('no browser errors',errors.length===0);
}finally{await browser.close();await writeFile('.runtime/checks/readability/report.json',JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
