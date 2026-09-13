import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {version} from '../../package.json';
await mkdir('.runtime/checks',{recursive:true});const root=await mkdtemp(resolve('.runtime/checks/ci-startup-'));
const app=spawn(resolve('dist/app/DeskLab.exe'),[],{windowsHide:true,stdio:'inherit',env:{...process.env,LAB_DATA_DIR:root,LAB_PORT:'0',LAB_OPEN:'0',LAB_TRAY:'0'}});
let origin='',token='';
try{
  for(let i=0;i<120;i++){try{const info=await Bun.file(join(root,'instance.json')).json();origin=`http://127.0.0.1:${info.port}`;const state=await(await fetch(origin+'/api/state')).json();token=state.token;break;}catch{}if(app.exitCode!==null)throw new Error('Packaged process exited');await Bun.sleep(500);}
  assert.ok(token,'packaged API ready');assert.equal((await(await fetch(origin+'/api/health')).json()).version,version);
  const page=await fetch(origin);assert.ok(page.ok,'embedded UI ready');
  const visibleText=(await page.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]*>/g,'');
  assert.ok(visibleText.includes(`DeskLab v${version}`),'embedded UI displays the package version');
  const response=await fetch(origin+'/api/app/quit',{method:'POST',headers:{'content-type':'application/json','x-lab-token':token},body:'{}'});assert.ok(response.ok);
  for(let i=0;i<40&&app.exitCode===null;i++)await Bun.sleep(250);assert.equal(app.exitCode,0);
  console.log('Packaged startup, version, embedded UI and clean exit passed; no VM started.');
}finally{if(app.exitCode===null)app.kill();}
