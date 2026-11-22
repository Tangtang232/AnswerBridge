const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('closeChoice',{select:value=>ipcRenderer.send('close-choice:select',value)});
