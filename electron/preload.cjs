const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, fn) => { const handler = (_event, data) => fn(data); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
window.addEventListener('DOMContentLoaded', () => {
  const update = () => { const el = document.activeElement; ipcRenderer.send('desktop:editing', !!el && (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.isContentEditable)); };
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 0));
  update();
});
contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  capture: kind => ipcRenderer.invoke('desktop:capture', kind),
  setShortcuts: value => ipcRenderer.invoke('desktop:shortcuts', value),
  openSettings: () => ipcRenderer.invoke('desktop:settings'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: draft => ipcRenderer.invoke('settings:save',draft),
  fetchModels: (id,draft) => ipcRenderer.invoke('settings:models',id,draft),
  testModel: (id,draft) => ipcRenderer.invoke('settings:test',id,draft),
  testVision: (id,draft,model) => ipcRenderer.invoke('settings:test-vision',id,draft,model),
  refreshSkill: id => ipcRenderer.invoke('settings:refresh-skill',id),
  importSkills: kind => ipcRenderer.invoke('settings:skills',kind),
  onCapture: fn => listen('capture:ready', fn),
  onError: fn => listen('app:error', fn)
});
