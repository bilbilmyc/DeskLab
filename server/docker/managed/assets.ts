import {join,resolve} from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {bundleDirectory} from '../../bundle';
import {z} from 'zod';
const manifestInput=z.object({version:z.literal(1),id:z.string().regex(/^[a-zA-Z0-9._-]+$/),os:z.string(),docker:z.string(),compose:z.string(),architecture:z.literal('amd64'),files:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/))}).passthrough();
export type EngineManifest=z.infer<typeof manifestInput>;
export async function fileHash(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function findEngineAssets(){
 const bundle=await bundleDirectory();
 const candidates=process.env.DESKLAB_ENGINE_ASSETS?[resolve(process.env.DESKLAB_ENGINE_ASSETS)]:[join(bundle,'runtime','docker-engine'),join(bundle,'dist','engines','docker')];
 for(const directory of candidates){if(await Bun.file(join(directory,'manifest.json')).exists()){const manifest=manifestInput.parse(await Bun.file(join(directory,'manifest.json')).json());return {directory,manifest};}}
 return undefined;
}
export async function verifiedEngineAssets(){
 const assets=await findEngineAssets();if(!assets)throw new Error('未安装独立 Docker 引擎组件，请使用完整安装包安装此组件');
 for(const name of ['system.qcow2','tools/docker.exe','tools/cli-plugins/docker-compose.exe']){
  if(!assets.manifest.files[name]||await fileHash(join(assets.directory,name))!==assets.manifest.files[name])throw new Error('独立引擎组件校验失败：'+name);
 }
 return assets;
}
