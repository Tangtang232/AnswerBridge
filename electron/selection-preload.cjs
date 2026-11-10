const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('selection', { info: () => ipcRenderer.invoke('selection:info'), finish: rect => ipcRenderer.send('selection:finish', rect) });
