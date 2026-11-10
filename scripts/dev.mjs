import { spawn } from 'node:child_process';
import electron from 'electron';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
let desktop;
const stop = () => { desktop?.kill(); vite.kill(); };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, stop);
try {
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch('http://127.0.0.1:5173')).ok) break; } catch {}
    if (n === 49) throw new Error('Vite 启动超时');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const env = { ...process.env, ANSWERBRIDGE_DEV_URL: 'http://127.0.0.1:5173/desktop' }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = spawn(electron, ['.'], { stdio: 'inherit', env });
  desktop.on('exit', code => { vite.kill(); process.exitCode = code || 0; });
} catch (error) { stop(); console.error(error.message); process.exitCode = 1; }
