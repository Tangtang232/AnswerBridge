import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('焦点进入输入框时通知主进程，离开后恢复快捷键',()=>{
 const callbacks={},sent=[];const document={activeElement:null,addEventListener:(n,fn)=>callbacks[n]=fn};
 const window={addEventListener:(n,fn)=>callbacks[n]=fn};
 const require=name=>name==='electron'?{contextBridge:{exposeInMainWorld(){}},ipcRenderer:{send:(...v)=>sent.push(v),on(){},removeListener(){}}}:null;
 vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs',import.meta.url),'utf8'),{require,window,document,setTimeout:fn=>fn()});
 callbacks.DOMContentLoaded();assert.deepEqual(sent.at(-1),['desktop:editing',false]);
 document.activeElement={tagName:'TEXTAREA',isContentEditable:false};callbacks.focusin();assert.deepEqual(sent.at(-1),['desktop:editing',true]);
 document.activeElement={tagName:'BUTTON',isContentEditable:false};callbacks.focusout();assert.deepEqual(sent.at(-1),['desktop:editing',false]);
});

test('输入框获得焦点时 Home 不收起窗口，普通焦点仍可收起',()=>{
 const main=fs.readFileSync(new URL('../electron/main.cjs',import.meta.url),'utf8');
 const source=main.match(/function toggleWindow\(\)\{[\s\S]*?\n\}/)?.[0];assert.ok(source);
 let hidden=0;const win={isDestroyed:()=>false,isMinimized:()=>false,isVisible:()=>true,isFocused:()=>true,hide:()=>hidden++};
 const context={window:win,capturing:false,selection:null,editingInput:true};vm.runInNewContext(source+';toggleWindow()',context);assert.equal(hidden,0);
 context.editingInput=false;vm.runInNewContext('toggleWindow()',context);assert.equal(hidden,1);
});
