import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2]??'http://127.0.0.1:43210',snapshot=await(await fetch((process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin)+'/api/state')).json();
const checks=[],errors=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
await mkdir('.runtime/checks/shutdown-confirm',{recursive:true});const browser=await chromium.launch({headless:true});
try{
 for(const [width,height]of[[1440,900],[320,600]]){
  const state=structuredClone(snapshot);state.machines=[0,1].map(i=>({id:`11111111-1111-4111-8111-11111111111${i}`,name:i?'正在安装的测试环境':'Ubuntu 关机测试',family:'ubuntu',memory:2048,cpus:2,diskGB:40,state:'running',createdAt:new Date().toISOString(),...(i?{installation:{recipeId:'ubuntu-server',phase:'installing',message:'正在安装系统'}}:{})}));
  const page=await browser.newPage({viewport:{width,height}}),writes=[];let finish;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request();if(req.method()==='POST'){
    writes.push(new URL(req.url()).pathname);const success=await new Promise(resolve=>{finish=resolve;});
    if(!success)return route.fulfill({status:400,json:{error:'关机请求未发送，请重试'}});
    state.machines[0].state='stopping';return route.fulfill({json:state.machines[0]});
   }return route.fulfill({json:state});
  });
  await page.goto(origin);const power=page.getByRole('button',{name:'关闭 Ubuntu 关机测试',exact:true}),dialog=page.getByRole('dialog',{name:'确认关机',exact:true});
  await power.click();await dialog.waitFor();check(width+' click only opens named confirmation',writes.length===0&&await dialog.getByText(/确定关闭“Ubuntu 关机测试”吗/).isVisible());
  check(width+' cancel receives initial focus',await dialog.getByRole('button',{name:'取消',exact:true}).evaluate(e=>e===document.activeElement));
  check(width+' dialog fits viewport',await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth;}));
  await page.screenshot({path:`.runtime/checks/shutdown-confirm/dialog-${width}.png`});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();check(width+' cancel leaves VM running',writes.length===0&&await power.isEnabled());
  await power.click();await page.keyboard.press('Escape');check(width+' Escape cancels and restores focus',writes.length===0&&await dialog.count()===0&&await power.evaluate(e=>e===document.activeElement));
  await power.click();await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();check(width+' close icon sends nothing',writes.length===0&&await dialog.count()===0);
  await power.click();await page.keyboard.press('Enter');check(width+' default Enter cancels instead of shutdown',writes.length===0&&await dialog.count()===0);
  await page.getByRole('button',{name:'关闭 正在安装的测试环境',exact:true}).click();check(width+' unfinished installation warning',await dialog.getByText(/关机会中断安装/).isVisible());await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await power.click();await dialog.getByRole('button',{name:'确认关机',exact:true}).click();await dialog.getByRole('button',{name:'正在处理…',exact:true}).waitFor();
  check(width+' confirmed request targets correct VM and uses normal shutdown',writes.length===1&&writes[0]===`/api/machines/${state.machines[0].id}/stop`);
  check(width+' pending request disables repeat submission',await dialog.getByRole('button',{name:'正在处理…',exact:true}).isDisabled());await page.keyboard.press('Enter');check(width+' repeated Enter sends no duplicate',writes.length===1);
  finish(false);await dialog.getByRole('alert').waitFor();check(width+' failure remains visible and can retry',await dialog.getByText('关机请求未发送，请重试',{exact:true}).isVisible()&&await dialog.getByRole('button',{name:'确认关机',exact:true}).isEnabled());
  await dialog.getByRole('button',{name:'确认关机',exact:true}).click();await dialog.getByRole('button',{name:'正在处理…',exact:true}).waitFor();finish(true);await dialog.waitFor({state:'hidden'});
  check(width+' success closes confirmation and reports requested shutdown',writes.length===2&&writes.every(p=>p===writes[0])&&await page.getByText('已发送关机请求，请等待系统正常退出。',{exact:true}).isVisible());
  check(width+' second VM untouched',state.machines[1].state==='running');await page.close();
 }
 check('no browser errors',errors.length===0);
}finally{await browser.close();await writeFile('.runtime/checks/shutdown-confirm/report.json',JSON.stringify({checks,errors},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
