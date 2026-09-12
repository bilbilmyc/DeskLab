import {bundleDirectory,dataDirectory} from './bundle';
import {reportStartupError} from './startup';

let root:string|undefined;
try {
  const bundle=await bundleDirectory();
  root=await dataDirectory(bundle);
  const {startDeskLab}=await import('./app');
  await startDeskLab(bundle,root);
} catch(error) {
  await reportStartupError(error,root);
  process.exit(1);
}
