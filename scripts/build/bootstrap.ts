import {mkdir} from 'node:fs/promises';
export async function bootstrap(){
  await mkdir('server/generated',{recursive:true});
  // A fresh source checkout has no embedded build output. Development proxies Next.
  const placeholders:Record<string,string>={
    'web.ts':'export default {} as Record<string, {type:string;body:string}>;\n',
    'engine.ts':"export const engineVersion='';\nexport default {} as Record<string,string>;\n",
    'tray.ts':"export const trayVersion='';\nexport default '';\n",
    'network.ts':"export const networkVersion='';\nexport default '';\n",
  };
  for(const [name,content]of Object.entries(placeholders))if(!await Bun.file('server/generated/'+name).exists())await Bun.write('server/generated/'+name,content);
}
if(import.meta.main)await bootstrap();
