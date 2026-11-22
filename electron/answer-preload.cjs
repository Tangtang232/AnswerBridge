const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('answerWindow',{
  onUpdate:fn=>{const handler=(_event,data)=>fn(data);ipcRenderer.on('answer:update',handler);return()=>ipcRenderer.removeListener('answer:update',handler);},
  setOpacity:value=>ipcRenderer.send('answer:opacity',value),
  getRealtimeConfig:()=>ipcRenderer.invoke('realtime:config'),
  openRealtimeSettings:()=>ipcRenderer.invoke('realtime:open-settings'),
  enableAudioRoute:()=>ipcRenderer.invoke('realtime:route-enable'),
  restoreAudioRoute:()=>ipcRenderer.invoke('realtime:route-restore'),
  startRealtime:()=>ipcRenderer.invoke('realtime:start'),
  sendAudio:pcm=>ipcRenderer.send('realtime:audio',pcm),
  commitRealtime:()=>ipcRenderer.invoke('realtime:commit'),
  stopRealtime:()=>ipcRenderer.send('realtime:stop'),
  onRealtime:fn=>{const h=(_event,data)=>fn(data);ipcRenderer.on('realtime:event',h);return()=>ipcRenderer.removeListener('realtime:event',h);}
});
