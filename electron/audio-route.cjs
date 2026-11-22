const fs=require('node:fs'),path=require('node:path'),{spawnSync,execFile}=require('node:child_process');
const { promisify } = require('node:util');
const runAsync = promisify(execFile);
function createRoute({userData,scriptPath,run=spawnSync,platform=process.platform}){
 const stateFile=path.join(userData,'audio-route-pending.json');let owned=false;
 function call(action,operations,fallbackLabel){if(platform!=='win32')throw Error('自动音频切换仅支持 Windows');const script=fs.readFileSync(scriptPath,'utf8');const encoded=Buffer.from(script,'utf16le').toString('base64');const result=run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{encoding:'utf8',windowsHide:true,timeout:12000,maxBuffer:256000,env:{...process.env,AB_ROUTE_ACTION:action,AB_ROUTE_OPERATIONS:JSON.stringify(operations||[]),AB_ROUTE_FALLBACK:fallbackLabel||''}});if(result.error||result.status!==0)throw Error('无法自动切换 Windows 播放设备，请检查 CABLE 是否已安装');try{return JSON.parse(result.stdout.trim())}catch{throw Error('无法读取 Windows 音频设备状态')}}
 function snapshot(fallbackLabel){return call('snapshot',null,fallbackLabel)}
 function save(state){fs.mkdirSync(userData,{recursive:true});const temp=stateFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,stateFile)}
 function restore(){if(!fs.existsSync(stateFile)){owned=false;return}const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));const now=snapshot();const ops=[];for(let i=0;i<3;i++){const previous=saved.roles[i]===saved.cable?(saved.phase==='active'?saved.fallback:null):saved.roles[i];if(now.roles[i]===saved.cable&&previous&&previous!==saved.cable)ops.push({id:previous,role:i})}if(ops.length)call('set',ops);fs.unlinkSync(stateFile);owned=false;}
 function enable(outputLabel){if(owned)return;if(fs.existsSync(stateFile))restore();const current=snapshot(outputLabel);if(!current.cable)throw Error('未找到 CABLE Input，请先安装虚拟音频驱动');if(!Array.isArray(current.roles)||current.roles.length!==3||current.roles.some(x=>!x))throw Error('无法读取当前播放设备，未进行切换');save({...current,phase:'starting'});try{const ops=current.roles.map((id,role)=>({id:current.cable,role})).filter((_,i)=>current.roles[i]!==current.cable);if(ops.length)call('set',ops);const check=snapshot();if(check.roles.some(id=>id!==current.cable))throw Error('切换播放设备未完成');save({...current,phase:'active'});owned=true;}catch(error){try{restore()}catch{}throw error}}
 async function devices() {
  if (platform !== 'win32') throw Error('自动检测音频设备仅支持 Windows');
  try {
   const script = await fs.promises.readFile(scriptPath, 'utf8');
   const encoded = Buffer.from(script, 'utf16le').toString('base64');
   const { stdout } = await runAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 256000,
    env: { ...process.env, AB_ROUTE_ACTION: 'devices' }
   });
   return JSON.parse(stdout);
  } catch {
   throw Error('无法读取 Windows 音频设备，请检查耳机和虚拟声卡是否已连接。');
  }
 }
 return {enable,restore,snapshot,devices};
}
module.exports={createRoute};
