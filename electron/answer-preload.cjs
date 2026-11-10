const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('answerWindow',{
  onUpdate:fn=>{const handler=(_event,data)=>fn(data);ipcRenderer.on('answer:update',handler);return()=>ipcRenderer.removeListener('answer:update',handler);},
  setOpacity:value=>ipcRenderer.send('answer:opacity',value)
});
