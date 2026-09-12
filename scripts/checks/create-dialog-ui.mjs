import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2]??'http://127.0.0.1:3011';
const state=await(await fetch((process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin)+'/api/state')).json();
state.machines=[];state.templates=[];state.catalogue=state.catalogue.map(t=>({...t,templateId:undefined}));
state.isoLibrary.resources=state.isoLibrary.resources.map(t=>({...t,isoPath:undefined}));
const recipe=state.catalogue.find(t=>t.family==='rocky'&&t.autoInstall),isoPath='D:\\fixtures\\rocky.iso';
const checks=[],errors=[],writes=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const output='.runtime/checks/create-dialog';await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height]of[[1920,1080],[1366,768],[1024,768],[768,600],[320,480]]){
  const page=await browser.newPage({viewport:{width,height}}),label=`${width}x${height}`;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path==='/api/isos/inspect')return route.fulfill({json:{status:'match',message:'安装盘初步匹配，创建前将校验完整性。',requiresConfirmation:false}});
   if(path.endsWith('/files/list'))return route.fulfill({json:{path:'D:\\fixtures',parent:'D:\\',shortcuts:[],entries:[{name:'rocky.iso',path:isoPath,directory:false}],truncated:false}});
   if(req.method()==='POST'){writes.push(req.postDataJSON());return route.fulfill({status:400,json:{error:'测试拦截：不创建实际环境'}});}
   return route.fulfill({json:state});
  });
  await page.goto(origin);await page.getByRole('button',{name:'模板库',exact:true}).click();
  const trigger=page.locator('.tpl-card').filter({has:page.getByRole('heading',{name:recipe.name,exact:true})}).getByRole('button',{name:'选择 ISO 并安装',exact:true});
  await trigger.click();const modal=page.locator('.create-dialog'),body=modal.locator('.create-dialog-body'),footer=modal.locator('.modal-foot');
  const fits=()=>modal.evaluate(e=>{const r=e.getBoundingClientRect(),h=e.querySelector('.modal-head').getBoundingClientRect(),f=e.querySelector('.modal-foot').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth&&h.top>=r.top&&f.bottom<=r.bottom&&f.height>=44;});
  check(label+' header and actions fit without dialog overflow',await fits());
  if(width>=1024){check(label+' default content needs no scrolling',await body.evaluate(e=>e.scrollHeight<=e.clientHeight+1));check(label+' dialog is compact',await modal.evaluate(e=>e.getBoundingClientRect().height<660));}
  check(label+' resource inputs directly available',await modal.locator('input[name=cpus]').isVisible()&&await modal.locator('input[name=memory]').isVisible()&&await modal.locator('input[name=diskGB]').isVisible());
  await page.screenshot({path:`${output}/install-${label}.png`});
  await footer.getByRole('button',{name:'创建并自动安装',exact:true}).click();
  check(label+' empty ISO blocks creation and focuses field',await modal.locator('input[name=isoPath]').evaluate(e=>e===document.activeElement&&!e.validity.valid));
  check(label+' validation retains visible actions',await fits());
  await modal.getByRole('button',{name:'选择文件',exact:true}).click();
  let picker=page.getByRole('dialog',{name:'选择 ISO 安装盘',exact:true});await picker.getByRole('button',{name:'取消',exact:true}).click();
  check(label+' cancelling picker preserves form and actions',await modal.isVisible()&&await footer.getByRole('button',{name:'取消',exact:true}).isEnabled());
  await modal.getByRole('button',{name:'选择文件',exact:true}).click();picker=page.getByRole('dialog',{name:'选择 ISO 安装盘',exact:true});
  await picker.getByRole('button',{name:/rocky.iso/}).click();await picker.getByRole('button',{name:'使用此文件',exact:true}).click();
  check(label+' ISO selection fills original form',await modal.locator('input[name=isoPath]').inputValue()===isoPath);
  await modal.locator('input[name=cpus]').fill('3');await modal.locator('input[name=memory]').fill('4096');await modal.locator('input[name=diskGB]').fill('80');
  await modal.locator('.create-connection>summary').click();check(label+' SSH help available on demand',await modal.getByText(/默认使用本机 Ed25519/).isVisible());
  const before=await footer.boundingBox();await body.evaluate(e=>{e.scrollTop=e.scrollHeight;});const after=await footer.boundingBox();
  check(label+' scrolling keeps footer fixed',Math.abs(before.y-after.y)<1&&await fits());
  await footer.getByRole('button',{name:'创建并自动安装',exact:true}).click();await modal.getByRole('alert').waitFor();
  check(label+' correct installation payload',writes.at(-1).recipeId===recipe.id&&writes.at(-1).isoPath===isoPath&&writes.at(-1).cpus===3&&writes.at(-1).memory===4096&&writes.at(-1).diskGB===80&&writes.at(-1).network.mode==='nat');
  check(label+' submission error visible beside actions',await modal.getByRole('alert').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})&&await fits());
  await page.keyboard.press('Escape');check(label+' Escape closes and returns focus',await modal.count()===0&&await trigger.evaluate(e=>e===document.activeElement));
  await trigger.click();await modal.getByRole('button',{name:'重新选择系统',exact:true}).click();
  check(label+' system selection actions fit',await fits());
  await modal.getByRole('button',{name:'已有 ISO 安装盘？从 ISO 安装',exact:true}).click();await modal.getByRole('button',{name:'下一步',exact:false}).click();
  check(label+' manual ISO actions fit',await fits());
  await modal.getByLabel('要安装的系统').selectOption('linux');
  check(label+' manual firmware selection retained',await modal.getByLabel('启动方式').inputValue()==='bios');
  await modal.getByRole('button',{name:'取消',exact:true}).click();await page.close();
 }
 check('no browser errors',errors.length===0);
}finally{await browser.close();await writeFile(`${output}/report.json`,JSON.stringify({checks,errors,writes},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
