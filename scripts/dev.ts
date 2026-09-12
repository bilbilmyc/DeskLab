import { spawn } from 'node:child_process';
const web = spawn(process.execPath, ['--bun', 'next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'], {stdio: 'inherit', windowsHide: true});
const api = spawn(process.execPath, ['server/index.ts'], {stdio: 'inherit', windowsHide: true, env: {...process.env, LAB_DEV: '1', LAB_DATA_DIR: process.env.LAB_DATA_DIR ?? '.data'}});
let quitting = false;
function stop() { if (quitting) return; quitting = true; web.kill(); api.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
web.on('exit', stop); api.on('exit', stop);
