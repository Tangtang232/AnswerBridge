const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, session, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let window, service, overlay, selection, capturing = false, closing = false, editingInput = false;
let shortcuts = { full: 'Ctrl', region: 'Alt+D' };
let shortcutStatus = {};
let keyboardHook,ctrlTap,settingsTools,modelTest;
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
function toggleWindow(){
  if(!window||window.isDestroyed()||capturing||selection)return;
  if(window.isMinimized()){window.restore();window.show();window.focus();return;}
  if(!window.isVisible()){window.show();window.focus();return;}
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
  await fs.promises.writeFile(target+'.tmp',safeStorage.encryptString(JSON.stringify(saved)));
  await fs.promises.rename(target+'.tmp',target);Object.assign(service.config,next);
  service.notifySettings();
  return settingsTools.viewSettings(service.config);
}
function reportError(error) { window?.webContents.send('app:error', error.message || '操作失败'); }
function sendImage(image) {
  const size = image.getSize();
  const resized = size.width > 2560 ? image.resize({ width: 2560 }) : image;
  window?.webContents.send('capture:ready', { image: `data:image/jpeg;base64,${resized.toJPEG(88).toString('base64')}`, createdAt: Date.now() });
}
async function capture(kind) {
  if (capturing) return; capturing = true;
  const wasVisible = window?.isVisible(); const minimized = window?.isMinimized();
  try {
    window?.hide(); await pause(180);
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
    const source = sources.find(s => s.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取当前显示器截图，请检查屏幕录制权限');
    if (kind === 'full') sendImage(source.thumbnail);
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
    if (!window || window.isDestroyed()) return;
    // isVisible() reports false for a minimized window too, so decide on isMinimized() first.
    if (minimized) { window.showInactive(); window.minimize(); }
    else if (wasVisible) window.showInactive();
  }
}
function setupIPC() {
  ipcMain.on('desktop:editing', (event, value) => { if (trusted(event.sender) && event.senderFrame === window.webContents.mainFrame) editingInput = value === true; });
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
  ipcMain.handle('settings:models',async(event,id,draft)=>{verify(event);return settingsTools.listModels(service.config,id,draft);});
  ipcMain.handle('settings:test',async(event,id,draft)=>{verify(event);return modelTest.testConnection(service.config,id,draft);});
  ipcMain.handle('settings:test-vision',async(event,id,draft,model)=>{verify(event);return modelTest.testVision(service.config,id,draft,model);});
  ipcMain.handle('settings:refresh-skill',async(event,id)=>{
    verify(event);const old=service.config.skills.find(s=>s.id===id);if(!old)throw Error('Skill 不存在');
    const refreshed=await settingsTools.readSkill(old.path);const next=structuredClone(service.config);
    next.skills=next.skills.map(s=>s.id===id?{...refreshed,id:s.id,enabled:s.enabled}:s);await persistSettings(next);return settingsTools.viewSettings(service.config).skills;
  });
  ipcMain.handle('settings:skills',async(event,kind)=>{
    verify(event);const result=await dialog.showOpenDialog(window,{title:'加载回答润色 Skill',properties:kind==='folder'?['openDirectory']:['openFile','multiSelections'],...(kind==='folder'?{}:{filters:[{name:'Skill Markdown',extensions:['md']} ]})});
    if(result.canceled)return settingsTools.viewSettings(service.config).skills;
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
    for(const file of candidates){const skill=await settingsTools.readSkill(file);const old=next.skills.find(s=>s.path===skill.path);if(old)Object.assign(old,{...skill,id:old.id,enabled:old.enabled});else next.skills.push({...skill,enabled:candidates.length===1});}
    if(next.skills.reduce((sum,s)=>sum+Buffer.byteLength(s.content),0)>1024*1024)throw Error('导入的 Skill 正文总量超过 1 MB，请按需选择');
    await persistSettings(next);return settingsTools.viewSettings(service.config).skills;
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
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const envPath = app.isPackaged ? path.join(path.dirname(process.execPath), '.env') : path.join(root, '.env');
  require('dotenv').config({ path: envPath });
  const { createService } = await import(pathToFileURL(path.join(root, 'server', 'app.mjs')));
  settingsTools=await import(pathToFileURL(path.join(root,'server','settings.mjs')));
  modelTest=await import(pathToFileURL(path.join(root,'server','model-test.mjs')));
  const {loadConfig}=await import(pathToFileURL(path.join(root,'server','config.mjs')));
  const config=loadConfig();const savedFile=path.join(app.getPath('userData'),'settings.enc');
  if(fs.existsSync(savedFile)){const saved=JSON.parse(safeStorage.decryptString(fs.readFileSync(savedFile)));Object.assign(config,{...saved,providers:{...config.providers,...saved.providers}});}
  let migrated=false;
  for(let index=0;index<config.skills.length;index++){const old=config.skills[index];if(old.contentFormatVersion===2)continue;try{config.skills[index]={...await settingsTools.readSkill(old.path),id:old.id,enabled:old.enabled};migrated=true;}catch{config.skills[index]={...old,issues:['旧 Skill 无法刷新，请确认原文件仍存在后点击重新加载']};}}
  service = await createService({ config, webDir: path.join(root, 'dist') });
  if(migrated)await persistSettings(config);
  window = new BrowserWindow({ width: 1260, height: 870, minWidth: 1020, minHeight: 720, backgroundColor: '#f4f6fb', title: '答桥 · AnswerBridge', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const desktopUrl = process.env.ANSWERBRIDGE_DEV_URL || `${service.baseUrl}/desktop`;
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== new URL(desktopUrl).origin) event.preventDefault(); });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(trusted(contents) && ['media','display-capture'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => trusted(contents) && ['media','display-capture'].includes(permission));
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
  await window.loadURL(desktopUrl);
}).catch(error => { dialog.showErrorBox('答桥启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  globalShortcut.unregisterAll();
  keyboardHook?.stop();keyboardHook=null;ctrlTap?.reset();
  if (!service || closing) return; event.preventDefault(); closing = true;
  overlay?.close(); service.close().finally(() => app.quit());
});
