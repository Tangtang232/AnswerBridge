const { app, BrowserWindow, Menu, Tray, ipcMain, desktopCapturer, screen, globalShortcut, session, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { AnswerHistory, VoiceTurns } = require('./answer-history.cjs');
const { selectDevices } = require('./realtime-setup.cjs');
let window, service, overlay, selection, answerWindow, capturing = false, closing = false, editingInput = false;
let quitRequested = false;
let realtimeVoice = null;
let audioRoute = null;
let tray;
const answerHistory = new AnswerHistory(sendAnswerUpdate);
let voiceTurns;
let shortcuts = { full: 'Ctrl', region: 'Alt+D' };
let shortcutStatus = {};
let keyboardHook,ctrlTap,settingsTools,modelTest,resolveModel;
if(process.env.ANSWERBRIDGE_PROFILE)app.setPath('userData',process.env.ANSWERBRIDGE_PROFILE);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const trusted = sender => sender === window?.webContents;
const verify = event => { if (!trusted(event.sender) || event.senderFrame !== window.webContents.mainFrame) throw new Error('未授权的桌面调用'); };
function registerShortcuts(next = shortcuts) {
  if (!next || !['full','region'].every(k => typeof next[k] === 'string' && next[k].length > 0 && next[k].length <= 100) || next.full === next.region) throw new Error('两个快捷键必须有效且不同');
  globalShortcut.unregisterAll(); shortcuts = next;
  for (const kind of ['full','region']) {
    if(kind==='full'&&shortcuts.full==='Ctrl'){shortcutStatus.full=!!keyboardHook;continue;}
    try { shortcutStatus[kind] = globalShortcut.register(shortcuts[kind], () => capture(kind).catch(reportError)); }
    catch { shortcutStatus[kind] = false; }
  }
  return { shortcuts, status: shortcutStatus };
}
function installCloseChoice(target) {
  let promptOpen = false;
  target.on('close', async event => {
    if (quitRequested || closing) return;
    event.preventDefault();
    if (promptOpen) return;
    promptOpen = true;
    try {
      const response = await showCloseChoice(target);
      if (target.isDestroyed() || quitRequested || closing) return;
      if (response === 0) {
        if (tray) target.hide();
        else target.minimize();
      }
      else if (response === 1) app.quit();
    } catch (error) {
      if (!target.isDestroyed()) reportError(error);
    } finally {
      promptOpen = false;
    }
  });
}
function showMainWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function installTray(target) {
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    if (icon.isEmpty()) return;
    tray = new Tray(icon);
    tray.setToolTip('答桥');
    tray.on('click', showMainWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开答桥', click: showMainWindow },
      { label: '打开答案小窗', click: () => void openAnswerWindow().catch(reportError) },
      { type: 'separator' },
      { label: '直接退出', click: () => app.quit() }
    ]));
    target.on('minimize', () => target.hide());
  } catch (error) {
    tray?.destroy();
    tray = null;
    console.warn('答桥通知区图标不可用：', error.message);
  }
}

function showCloseChoice(target) {
  return new Promise((resolve,reject)=>{
    const child=new BrowserWindow({parent:target,modal:true,show:false,width:460,height:270,resizable:false,minimizable:false,maximizable:false,backgroundColor:'#ffffff',title:'关闭答桥',webPreferences:{preload:path.join(__dirname,'close-choice-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    child.setContentProtection(service?.config?.screenProtection !== false);child.setMenuBarVisibility(false);child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.webContents.on('will-navigate',event=>event.preventDefault());
    let settled=false;
    const finish=choice=>{if(settled)return;settled=true;ipcMain.removeListener('close-choice:select',select);resolve(choice);if(!child.isDestroyed())child.destroy();};
    const select=(event,choice)=>{if(event.sender!==child.webContents||event.senderFrame!==child.webContents.mainFrame||![0,1,2].includes(choice))return;finish(choice);};
    ipcMain.on('close-choice:select',select);child.on('closed',()=>finish(2));
    child.loadFile(path.join(__dirname,'close-choice.html')).then(()=>{if(!child.isDestroyed())child.show();}).catch(error=>{if(!settled){settled=true;ipcMain.removeListener('close-choice:select',select);if(!child.isDestroyed())child.destroy();reject(error);}});
  });
}
function toggleWindow(){
  if(!window||window.isDestroyed()||capturing||selection)return;
  if(window.isMinimized()||!window.isVisible()){showMainWindow();return;}
  if(window.isFocused() && editingInput)return;
  if(window.isFocused())window.hide();else{window.show();window.focus();}
}
function startCtrlHook(){
  try{
    const {uIOhook,UiohookKey}=require('uiohook-napi');
    const {createCtrlTap}=require('./ctrl-tap.cjs');
    ctrlTap=createCtrlTap({ctrlCodes:[UiohookKey.Ctrl,UiohookKey.CtrlRight],trigger:()=>{if(shortcuts.full==='Ctrl'&&!capturing)void capture('full').catch(reportError);}});
    let homeDown=false;
    const plain=e=>!e.altKey&&!e.shiftKey&&!e.metaKey;
    // Physical Home reports UiohookKey.Home; the numpad Home key reports its own code.
    const homeCodes=new Set([UiohookKey.Home,UiohookKey.NumpadHome]);
    const isHome=e=>homeCodes.has(e.keycode);
    uIOhook.on('keydown',e=>{
      if(isHome(e)&&e.ctrlKey)homeDown=false;
      else if(isHome(e))homeDown=plain(e);
      ctrlTap.down(e);
    });
    uIOhook.on('keyup',e=>{
      if(isHome(e)){const fire=homeDown&&plain(e);homeDown=false;if(fire)toggleWindow();}
      ctrlTap.up(e);
    });
    uIOhook.on('mousedown',()=>{homeDown=false;ctrlTap.cancel();});uIOhook.on('wheel',()=>ctrlTap.cancel());
    uIOhook.start();keyboardHook=uIOhook;
  }catch(error){keyboardHook=null;reportError(new Error('全局快捷键监听启动失败，可点击桌面按钮操作'));}
}
async function persistSettings(next){
  if(!safeStorage.isEncryptionAvailable())throw Error('Windows 凭据加密不可用，设置尚未保存');
  const {port,publicBase,modelTimeout,...saved}=next;
  const target=path.join(app.getPath('userData'),'settings.enc');
  await fs.promises.mkdir(path.dirname(target),{recursive:true});
  const oldProtection=service.config.screenProtection !== false;
  const protectedWindows=[window,answerWindow].filter(w=>w && !w.isDestroyed());
  try { for(const w of protectedWindows) w.setContentProtection(next.screenProtection !== false);
    await fs.promises.writeFile(target+'.tmp',safeStorage.encryptString(JSON.stringify(saved)));
    await fs.promises.rename(target+'.tmp',target);
  } catch(error) { for(const w of protectedWindows) if(!w.isDestroyed()) w.setContentProtection(oldProtection); throw error; }
  Object.assign(service.config,next);
  sendAnswerUpdate();
  service.notifySettings();
  return settingsTools.viewSettings(service.config);
}
function reportError(error) { window?.webContents.send('app:error', error.message || '操作失败'); }
function sendAnswerUpdate(update = {}) {
  if (answerWindow && !answerWindow.isDestroyed()) {
    answerWindow.webContents.send('answer:update', {
      ...update, protection: service.config.screenProtection !== false
    });
  }
}
function stopRealtime() {
  realtimeVoice?.stop();
  realtimeVoice = null;
  voiceTurns?.stop();
  voiceTurns = null;
}
async function openAnswerWindow() {
  if(answerWindow && !answerWindow.isDestroyed()){if(answerWindow.isMinimized())answerWindow.restore();answerWindow.show();answerWindow.focus();return;}
  const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());const area=display.workArea;
  const child=new BrowserWindow({x:Math.max(area.x,area.x+area.width-470),y:area.y+32,width:430,height:340,minWidth:300,minHeight:180,show:false,alwaysOnTop:true,skipTaskbar:false,backgroundColor:'#ffffff',title:'答桥 · 答案小窗',webPreferences:{preload:path.join(__dirname,'answer-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  answerWindow=child;
  child.setContentProtection(service.config.screenProtection !== false);
  child.setMenuBarVisibility(false);
  child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  child.webContents.on('will-navigate',event=>event.preventDefault());
  child.on('closed',()=>{if(answerWindow===child)answerWindow=null;stopRealtime();try{audioRoute?.restore()}catch(error){reportError(error)}});
  try { await child.loadFile(path.join(__dirname,'answer.html'));if(!child.isDestroyed()){sendAnswerUpdate({ history: answerHistory.snapshot() });child.show();} }
  catch(error){if(!child.isDestroyed())child.destroy();throw error;}
}
function imageData(image) {
  const size = image.getSize();
  const resized = size.width > 2560 ? image.resize({ width: 2560 }) : image;
  return `data:image/jpeg;base64,${resized.toJPEG(88).toString('base64')}`;
}
function sendImage(image) {
  window?.webContents.send('capture:ready', { image: imageData(image), createdAt: Date.now() });
}
async function capture(kind, remote = false) {
  if (capturing) { if (remote) throw new Error('电脑正在截图，请稍后再试'); return; }
  if (remote && (!window || window.isDestroyed())) throw new Error('桌面尚未就绪，请稍后再试');
  if (!remote && !resolveModel(service.config, service.config.defaultProvider, true).ready) {
    throw Error('请先在软件设置中配置支持图片的回答模型。');
  }
  capturing = true;
  const wasVisible = window?.isVisible(); const minimized = window?.isMinimized(); const answerWasVisible=answerWindow?.isVisible();
  try {
    window?.hide(); if(answerWasVisible)answerWindow?.hide(); await pause(180);
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
    const source = sources.find(s => s.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取当前显示器截图，请检查屏幕录制权限');
    if (kind === 'full') {
      if (remote) return imageData(source.thumbnail);
      sendImage(source.thumbnail);
    }
    else {
      await new Promise((resolve, reject) => {
        selection = { image: source.thumbnail, bounds: display.bounds, resolve, reject };
        overlay = new BrowserWindow({ ...display.bounds, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#10131a', webPreferences: { preload: path.join(__dirname, 'selection-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        overlay.setMenuBarVisibility(false);
        overlay.on('closed', () => { overlay = null; const s = selection; selection = null; s?.resolve(); });
        overlay.loadFile(path.join(__dirname, 'selection.html')).catch(reject);
        overlay.once('ready-to-show', () => { overlay.show(); overlay.focus(); });
      });
    }
  } finally {
    capturing = false;
    if(answerWasVisible && answerWindow && !answerWindow.isDestroyed())answerWindow.showInactive();
    if (!window || window.isDestroyed()) return;
    // isVisible() reports false for a minimized window too, so decide on isMinimized() first.
    if (minimized) { window.showInactive(); window.minimize(); }
    else if (wasVisible) window.showInactive();
  }
}
function setupIPC() {
  const isAnswer = event => event.sender === answerWindow?.webContents && event.senderFrame === answerWindow.webContents.mainFrame;
  ipcMain.handle('realtime:config', event => { if(!isAnswer(event))throw Error('未授权');const r=service.config.realtime||{};return {hasKey:!!r.key,inputLabel:r.inputLabel||'CABLE Output (VB-Audio Virtual Cable)',outputLabel:r.outputLabel||''}; });
  ipcMain.handle('realtime:open-settings', event => {
    if (!isAnswer(event) || !window || window.isDestroyed()) throw Error('无法打开软件设置');
    answerWindow.minimize();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send('settings:open-realtime');
  });
  ipcMain.handle('realtime:route-enable',event=>{if(!isAnswer(event))throw Error('未授权');audioRoute.enable(service.config.realtime?.outputLabel);return true;});
  ipcMain.handle('realtime:route-restore',event=>{if(!isAnswer(event))throw Error('未授权');audioRoute.restore();return true;});
  ipcMain.handle('realtime:start', (event) => {
    if (!isAnswer(event)) throw Error('未授权');
    const key=service.config.realtime?.key;
    if (typeof key !== 'string' || !key.trim()) throw Error('请先在软件设置中填写并保存实时语音 API Key');
    stopRealtime();
    voiceTurns = new VoiceTurns(answerHistory);
    const { RealtimeVoice } = require('./realtime-voice.cjs');
    const client = new RealtimeVoice({
      key: key.trim(),
      prompt: settingsTools.realtimeInstructions(service.config),
      onEvent: data => {
        if (realtimeVoice !== client || !answerWindow || answerWindow.isDestroyed()) return;
        voiceTurns.handle(data);
        if (['session.created', 'input_audio_buffer.committed', 'error'].includes(data.type)) {
          answerWindow.webContents.send('realtime:event', data);
        }
      }
    });
    realtimeVoice=client; client.start(); return true;
  });
  ipcMain.on('realtime:audio', (event, data) => { if(isAnswer(event) && data instanceof ArrayBuffer && data.byteLength <= 12800 && data.byteLength % 2 === 0) realtimeVoice?.send(data); });
  ipcMain.handle('realtime:commit', event => { if(!isAnswer(event))throw Error('未授权');return realtimeVoice?.commit() || false; });
  ipcMain.on('realtime:stop', event => { if (isAnswer(event)) stopRealtime(); });
  ipcMain.on('desktop:editing', (event, value) => { if (trusted(event.sender) && event.senderFrame === window.webContents.mainFrame) editingInput = value === true; });
  ipcMain.on('answer:publish', (event, task) => {
    if (trusted(event.sender) && event.senderFrame === window.webContents.mainFrame) {
      answerHistory.addDesktop(task);
    }
  });
  ipcMain.handle('answer:open',async event=>{verify(event);await openAnswerWindow();});
  ipcMain.on('answer:opacity',(event,value)=>{if(event.sender!==answerWindow?.webContents||event.senderFrame!==answerWindow.webContents.mainFrame||typeof value!=='number'||!Number.isFinite(value))return;answerWindow.setOpacity(Math.max(0.6,Math.min(1,value)));});
  ipcMain.handle('desktop:info', event => { verify(event); return { serverUrl: service.baseUrl, desktopToken: service.desktopToken, platform: process.platform, ...registerInfo() }; });
  ipcMain.handle('desktop:capture', async (event, kind) => { verify(event); if (!['full','region'].includes(kind)) throw new Error('截图类型错误'); await capture(kind); return true; });
  ipcMain.handle('desktop:shortcuts', (event, next) => {
    verify(event); const info = registerShortcuts(next);
    fs.writeFileSync(path.join(app.getPath('userData'), 'shortcuts.json'), JSON.stringify(shortcuts)); return info;
  });
  ipcMain.handle('desktop:settings', event => { verify(event); const envFile = app.isPackaged ? path.join(path.dirname(process.execPath), '.env') : path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envFile)) { const example = app.isPackaged ? path.join(path.dirname(process.execPath), '.env.example') : path.join(__dirname, '..', '.env.example'); fs.copyFileSync(example, envFile); }
    return shell.openPath(envFile);
  });
  ipcMain.handle('settings:get',event=>{verify(event);return settingsTools.viewSettings(service.config);});
  ipcMain.handle('settings:save',async(event,draft)=>{verify(event);return persistSettings(settingsTools.mergeSettings(service.config,draft));});
  ipcMain.handle('settings:realtime-setup', async (event, draft) => {
    verify(event);
    const update = { key: draft?.key, prompt: draft?.prompt, skillId: draft?.skillId };
    if (!settingsTools.mergeRealtime(service.config.realtime, update).key) {
      throw Error('请先填写豆包实时语音 API Key。');
    }
    const devices = await audioRoute.devices();
    const selection = selectDevices(devices, service.config.realtime?.outputLabel, draft?.outputLabel, draft?.chooseOutput === true);
    if (selection.choices) return { choices: selection.choices };
    const realtime = settingsTools.mergeRealtime(service.config.realtime, {
      ...update, outputLabel: selection.outputLabel
    });
    if (!realtime.key) throw Error('请先填写豆包实时语音 API Key。');
    if (realtime.skillId && !service.config.skills.some(skill => skill.id === realtime.skillId)) {
      throw Error('找不到所选语音 Skill，请重新选择。');
    }
    realtime.inputLabel = selection.inputLabel;
    const saved = await persistSettings({ ...service.config, realtime });
    return { realtime: saved.realtime };
  });
  ipcMain.handle('settings:models',async(event,id,draft)=>{verify(event);return settingsTools.listModels(service.config,id,draft);});
  ipcMain.handle('settings:test',async(event,id,draft)=>{verify(event);return modelTest.testConnection(service.config,id,draft);});
  ipcMain.handle('settings:test-vision',async(event,id,draft,model)=>{verify(event);return modelTest.testVision(service.config,id,draft,model);});
  ipcMain.handle('settings:refresh-skill',async(event,id)=>{
    verify(event);const old=service.config.skills.find(s=>s.id===id);if(!old)throw Error('Skill 不存在');
    const refreshed=await settingsTools.readSkill(old.path);const next=structuredClone(service.config);
    next.skills=next.skills.map(s=>s.id===id?{...refreshed,id:s.id,enabled:s.enabled}:s);await persistSettings(next);return settingsTools.viewSettings(service.config).skills;
  });
  ipcMain.handle('settings:skills',async(event,kind,scope)=>{
    verify(event);
    const voiceOnly = scope === 'realtime';
    const folder = !voiceOnly && kind === 'folder';
    const properties = folder ? ['openDirectory'] : voiceOnly ? ['openFile'] : ['openFile','multiSelections'];
    const result = await dialog.showOpenDialog(window, {
      title: voiceOnly ? '导入语音 Skill' : '加载回答润色 Skill',
      properties,
      ...(folder ? {} : { filters: [{ name: 'Skill Markdown', extensions: ['md'] }] })
    });
    if(result.canceled)return voiceOnly ? null : settingsTools.viewSettings(service.config).skills;
    const candidates=[];
    async function discover(folder,depth=0){
      if(depth>4)return;const entries=await fs.promises.readdir(folder,{withFileTypes:true});
      const entry=entries.find(x=>x.isFile()&&x.name.toLowerCase()==='skill.md');
      if(entry){candidates.push(path.join(folder,entry.name));return;}
      for(const e of entries)if(e.isDirectory()&&!['node_modules','.git'].includes(e.name))await discover(path.join(folder,e.name),depth+1);
    }
    for(const input of result.filePaths){if((await fs.promises.stat(input)).isDirectory())await discover(input);else candidates.push(input);}
    if(!candidates.length)throw Error('所选目录中未找到 SKILL.md');
    const next=structuredClone(service.config);
    let skillId;
    for(const file of candidates){
      const skill=await settingsTools.readSkill(file);
      const old=next.skills.find(s=>s.path===skill.path);
      if(old)Object.assign(old,{...skill,id:old.id,enabled:old.enabled});
      else next.skills.push({...skill,enabled:!voiceOnly&&candidates.length===1});
      skillId=old?.id||skill.id;
    }
    if(next.skills.reduce((sum,s)=>sum+Buffer.byteLength(s.content),0)>1024*1024)throw Error('导入的 Skill 正文总量超过 1 MB，请按需选择');
    const saved=await persistSettings(next);
    return voiceOnly ? { skills: saved.skills, skillId } : saved.skills;
  });
  ipcMain.handle('selection:info', event => { if (event.sender !== overlay?.webContents || !selection) throw new Error('未授权'); return { image: selection.image.toDataURL(), width: selection.bounds.width, height: selection.bounds.height }; });
  ipcMain.on('selection:finish', (event, rect) => {
    if (event.sender !== overlay?.webContents || !selection) return;
    try {
      if (rect) {
        if (!['x','y','width','height'].every(k => Number.isFinite(rect[k])) || rect.width < 5 || rect.height < 5) throw new Error('选区太小');
        const { width, height } = selection.image.getSize(), b = selection.bounds;
        const x = Math.max(0, Math.min(width - 1, Math.round(rect.x * width / b.width)));
        const y = Math.max(0, Math.min(height - 1, Math.round(rect.y * height / b.height)));
        sendImage(selection.image.crop({ x, y, width: Math.max(1, Math.min(width - x, Math.round(rect.width * width / b.width))), height: Math.max(1, Math.min(height - y, Math.round(rect.height * height / b.height))) }));
      }
    } catch (error) { reportError(error); }
    overlay.close();
  });
}
const registerInfo = () => ({ shortcuts, status: shortcutStatus });
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
app.on('second-instance', showMainWindow);
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const {createRoute}=require('./audio-route.cjs');audioRoute=createRoute({userData:app.getPath('userData'),scriptPath:path.join(__dirname,'audio-route.ps1')});
  try{audioRoute.restore()}catch(error){dialog.showErrorBox('恢复播放设备失败',error.message);}
  const envPath = app.isPackaged ? path.join(path.dirname(process.execPath), '.env') : path.join(root, '.env');
  require('dotenv').config({ path: envPath });
  const { createService } = await import(pathToFileURL(path.join(root, 'server', 'app.mjs')));
  settingsTools=await import(pathToFileURL(path.join(root,'server','settings.mjs')));
  modelTest=await import(pathToFileURL(path.join(root,'server','model-test.mjs')));
  const configTools = await import(pathToFileURL(path.join(root,'server','config.mjs')));
  const { loadConfig } = configTools;
  resolveModel = configTools.resolveModel;
  const config=loadConfig();const savedFile=path.join(app.getPath('userData'),'settings.enc');
  if(fs.existsSync(savedFile)){const saved=JSON.parse(safeStorage.decryptString(fs.readFileSync(savedFile)));Object.assign(config,{...saved,providers:{...config.providers,...saved.providers}});}
  delete config.mode;
  delete config.asr;
  let migrated=false;
  for(let index=0;index<config.skills.length;index++){const old=config.skills[index];if(old.contentFormatVersion===2)continue;try{config.skills[index]={...await settingsTools.readSkill(old.path),id:old.id,enabled:old.enabled};migrated=true;}catch{config.skills[index]={...old,issues:['旧 Skill 无法刷新，请确认原文件仍存在后点击重新加载']};}}
  service = await createService({ config, webDir: path.join(root, 'dist'), captureScreen: () => capture('full', true) });
  if(migrated)await persistSettings(config);
  window = new BrowserWindow({ show: false, width: 1260, height: 870, minWidth: 1020, minHeight: 720, backgroundColor: '#f4f6fb', title: '答桥 · AnswerBridge', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setContentProtection(config.screenProtection !== false);
  installCloseChoice(window);
  window.on('closed',()=>{answerWindow?.close();window=null;});
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const desktopUrl = process.env.ANSWERBRIDGE_DEV_URL || `${service.baseUrl}/desktop`;
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== new URL(desktopUrl).origin) event.preventDefault(); });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback((trusted(contents) && ['media','display-capture'].includes(permission)) || (contents === answerWindow?.webContents && permission === 'media')));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => (trusted(contents) && ['media','display-capture'].includes(permission)) || (contents === answerWindow?.webContents && permission === 'media'));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window?.webContents.mainFrame) return callback(null);
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length) return callback(null);
      callback({ video: sources[0], ...(process.platform === 'win32' && request.audioRequested ? { audio: 'loopback' } : {}) });
    } catch { callback(null); }
  });
  setupIPC();
  startCtrlHook();registerShortcuts();
  await installTray(window);
  await window.loadURL(desktopUrl);
  window.show();
}).catch(error => { dialog.showErrorBox('答桥启动失败', error.code === 'EADDRINUSE' ? '服务端口已被占用。请先退出正在运行的旧版答桥，再启动当前版本；不要同时启动备份目录中的程序。' : error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => tray?.destroy());
app.on('before-quit', event => {
  quitRequested = true;
  try{audioRoute?.restore()}catch(error){dialog.showErrorBox('恢复播放设备失败',error.message);}
  globalShortcut.unregisterAll();
  keyboardHook?.stop();keyboardHook=null;ctrlTap?.reset();
  if (!service || closing) return; event.preventDefault(); closing = true;
  overlay?.close(); service.close().finally(() => app.quit());
});

}
