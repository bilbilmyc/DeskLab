import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
await mkdir('.runtime/checks/installed-ui',{recursive:true});
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:43210');await page.getByRole('button',{name:'Docker 容器',exact:true}).click();await page.locator('.container-row').first().waitFor();
 assert.equal(await page.locator('.container-row').count(),18);assert.equal(await page.locator('.container-row button').count(),0);
 await page.screenshot({path:'.runtime/checks/installed-ui/docker.png'});
 await page.getByRole('button',{name:'端口映射',exact:true}).click();await page.getByRole('cell',{name:'127.0.0.1:2222 → 22/TCP',exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight));await page.screenshot({path:'.runtime/checks/installed-ui/ports.png'});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({installedDockerPage:'18 external containers read-only',sshMapping:'127.0.0.1:2222',layout:'fits',errors}));
}finally{await browser.close();}
