import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
const command=Bun.spawn(['git','ls-files','--cached','--others','--exclude-standard','-z'],{stdout:'pipe',stderr:'inherit'});
const files=[...new Set((await new Response(command.stdout).text()).split('\0').filter(Boolean))];
assert.equal(await command.exited,0);assert.ok(files.length>0,'repository has source files');
const forbidden=/(^|\/)(?:node_modules|\.runtime|\.data|data|dist|iso|\.next)(\/|$)|\.(?:exe|dll|iso|qcow2|vhdx|vmdk|vdi|sqlite(?:-wal|-shm)?|pem|key|pfx|p12)$/i;
for(const file of files){assert.ok(!forbidden.test(file),'private/generated file tracked: '+file);assert.ok((await stat(file)).size<5*1024*1024,'unexpected large repository file: '+file);}
const documents=files.filter(f=>f.endsWith('.md')&&!/^docs\/(?:plans|ui)\//.test(f)&&!['docs/verification.md','docs/managed-docker-verification.md','docs/network-setup.md'].includes(f));
let links=0;
for(const file of documents){
 const text=await Bun.file(file).text();
 for(const match of text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)){
  const href=match[1].replace(/^<|>$/g,'').split('#')[0];if(!href||/^[a-z][a-z0-9+.-]*:/i.test(href))continue;
  assert.ok(await Bun.file(resolve(dirname(file),decodeURIComponent(href))).exists(),`${file}: broken local link ${href}`);links++;
 }
}
console.log(`Repository check: ${files.length} source files, ${documents.length} current documents, ${links} local links; no runtime/media files tracked.`);
