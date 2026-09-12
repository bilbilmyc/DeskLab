import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const origin=process.argv[2]??'http://127.0.0.1:3011',state=await(await fetch((process.env.DESKLAB_UI_FIXTURE_ORIGIN??origin)+'/api/state')).json();
state.machines=[];state.templates=[];state.catalogue=state.catalogue.map(t=>({...t,templateId:undefined}));state.isoLibrary.resources=state.isoLibrary.resources.map(t=>({...t,isoPath:undefined}));
const checks=[],errors=[],writes=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
await mkdir('.runtime/checks/iso-inspection',{recursive:true});const browser=await chromium.launch({headless:true});
try{
 for(const [width,height]of[[1366,768],[320,600]]){
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path==='/api/isos/inspect'){
    const input=req.postDataJSON(),rocky=input.path.includes('rocky'),unknown=input.path.includes('custom');
    if(input.path.includes('slow'))await new Promise(r=>setTimeout(r,1200));
    if(input.path.includes('missing'))return route.fulfill({status:400,json:{error:'找不到这个安装盘，请重新选择'}});
    const mismatch=rocky&&input.family!=='rocky'||input.path.includes('old')&&input.recipeId;
    return route.fulfill({json:{status:mismatch?'mismatch':unknown?'unknown':'match',message:mismatch?'所选系统与安装盘不匹配，请更换安装盘或切换系统。':unknown?'无法识别，请确认系统类型。':'安装盘初步匹配，创建前将校验完整性。',label:unknown?'CUSTOM':'Rocky-9-8',detectedFamily:unknown?undefined:rocky?'rocky':'ubuntu',suggestedRecipeId:rocky?'rocky-server':undefined,requiresConfirmation:unknown}}).catch(()=>{});
   }
   if(req.method()==='POST'){writes.push(req.postDataJSON());return route.fulfill({status:400,json:{error:'校验失败：未创建实例'}});}
   return route.fulfill({json:state});
  });
  await page.goto(origin);await page.getByRole('button',{name:'模板库',exact:true}).click();
  await page.locator('.tpl-card').filter({has:page.getByRole('heading',{name:state.catalogue[0].name,exact:true})}).getByRole('button',{name:'选择 ISO 并安装',exact:true}).click();
  const modal=page.locator('.create-dialog'),iso=modal.locator('input[name=isoPath]'),submit=modal.locator('.modal-foot .primary');
  await iso.fill('D:\\outside\\rocky.iso');await modal.getByText('所选系统与安装盘不匹配，请更换安装盘或切换系统。').waitFor();
  check(width+' wrong family blocks submit without creating',await submit.isDisabled()&&writes.length===0);
  check(width+' form remains cancellable during inspection',await modal.getByRole('button',{name:'取消',exact:true}).isEnabled());
  await page.screenshot({path:`.runtime/checks/iso-inspection/mismatch-${width}.png`});
  await modal.getByRole('button',{name:/改用 Rocky.*自动安装/}).click();await modal.getByText('安装盘初步匹配，创建前将校验完整性。').waitFor();
  check(width+' external ISO can switch to matching automatic recipe',await submit.isEnabled()&&await submit.innerText()==='创建并自动安装'&&await iso.inputValue()==='D:\\outside\\rocky.iso');
  await submit.click();await modal.getByRole('alert').waitFor();check(width+' automatic recipe submitted with selected external ISO',writes.at(-1).recipeId==='rocky-server'&&writes.at(-1).family==='rocky');
  await iso.fill('D:\\outside\\old-rocky.iso');await modal.getByText('所选系统与安装盘不匹配，请更换安装盘或切换系统。').waitFor();
  await modal.getByRole('button',{name:/按Rocky Linux手动安装/}).click();await modal.getByText('安装盘初步匹配，创建前将校验完整性。').waitFor();
  check(width+' switch preserves ISO and sets correct family',await iso.inputValue()==='D:\\outside\\old-rocky.iso'&&await modal.getByLabel('要安装的系统').inputValue()==='rocky'&&await submit.isEnabled());
  await iso.fill('D:\\outside\\slow-rocky.iso');await page.waitForTimeout(400);await iso.fill('D:\\outside\\custom.iso');await modal.getByText('无法识别，请确认系统类型。').waitFor();await page.waitForTimeout(1300);
  check(width+' stale inspection cannot overwrite newest selection',await modal.getByText('无法识别，请确认系统类型。').isVisible()&&await submit.isDisabled());
  await modal.getByRole('checkbox',{name:'我已确认系统类型，使用手动安装'}).check();check(width+' unknown manual ISO needs confirmation',await submit.isEnabled());
  await iso.fill('D:\\outside\\custom-2.iso');await modal.getByText('无法识别，请确认系统类型。').waitFor();check(width+' changing ISO resets confirmation',await submit.isDisabled()&&!await modal.getByRole('checkbox').isChecked());
  await modal.getByRole('checkbox').check();await submit.click();await modal.getByRole('alert').waitFor();
  check(width+' manual submission preserves path and sends explicit confirmation',writes.at(-1).isoPath==='D:\\outside\\custom-2.iso'&&writes.at(-1).family==='rocky'&&writes.at(-1).isoTypeConfirmed===true&&!writes.at(-1).recipeId);
  await iso.fill('D:\\outside\\missing.iso');await modal.getByText('找不到这个安装盘，请重新选择').waitFor();check(width+' inaccessible file blocks with retry',await submit.isDisabled()&&await modal.getByRole('button',{name:'重新检查',exact:true}).isVisible());
  await iso.fill('D:\\outside\\rocky.iso');await modal.getByText('安装盘初步匹配，创建前将校验完整性。').waitFor();check(width+' changing to readable ISO recovers',await submit.isEnabled());
  check(width+' footer remains visible with validation feedback',await modal.locator('.modal-foot').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
  await page.close();writes.length=0;
 }
 check('no browser errors',errors.length===0);
}finally{await browser.close();await writeFile('.runtime/checks/iso-inspection/report.json',JSON.stringify({checks,errors},null,2));}
console.log(JSON.stringify({checks:checks.length,errors}));
