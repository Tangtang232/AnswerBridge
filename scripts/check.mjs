import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
for (const dir of ['server','electron','scripts','tests']) for (const name of fs.readdirSync(dir)) {
  if (!/\.(cjs|mjs|js)$/.test(name)) continue;
  const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { encoding: 'utf8' });
  if (result.status) { console.error(result.stderr); process.exitCode = 1; }
}
if (!process.exitCode) console.log('Node/Electron scripts: syntax OK');
