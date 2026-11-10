import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('小窗流式显示最新答案、失败和演示状态，内容按纯文本处理',()=>{
 const elements=Object.fromEntries(['status','question','answer','error','demo','protection','opacity'].map(id=>[id,{textContent:'',hidden:false,addEventListener:(type,fn)=>{elements[id].listener=fn}}]));
 let update,opacity;const context={document:{getElementById:id=>elements[id]},window:{answerWindow:{onUpdate:fn=>update=fn,setOpacity:value=>opacity=value}}};
 vm.runInNewContext(fs.readFileSync(new URL('../electron/answer.js',import.meta.url),'utf8'),context);
 update({status:'generating',question:'题目',answer:'第一段',error:'',demo:false,protection:true});assert.equal(elements.answer.textContent,'第一段');assert.equal(elements.status.textContent,'正在回答');assert.match(elements.protection.textContent,/已开启/);
 update({status:'done',question:'题目',answer:'第一段第二段<script>',demo:true,protection:true});assert.equal(elements.answer.textContent,'第一段第二段<script>');assert.equal(elements.demo.hidden,false);
 update({status:'error',error:'连接失败',protection:false});assert.equal(elements.error.textContent,'连接失败');assert.equal(elements.answer.textContent,'');assert.match(elements.protection.textContent,/已关闭/);
 elements.opacity.listener({target:{value:'70'}});assert.equal(opacity,0.7);
});
test('小窗先设置共享保护再显示，更新最新答案，关闭后可以重开',async()=>{
 const main=fs.readFileSync(new URL('../electron/main.cjs',import.meta.url),'utf8');const source=main.match(/async function openAnswerWindow\(\) \{[\s\S]*?\n\}/)?.[0];assert.ok(source);
 const instances=[];class FakeWindow{constructor(options){this.options=options;this.events={};this.destroyed=false;this.webContents={setWindowOpenHandler(){},on(){},send:(...args)=>{this.sent=args}};instances.push(this)}setContentProtection(value){this.protection=value;this.protectionBeforeShow=!this.visible}setMenuBarVisibility(){}on(n,fn){this.events[n]=fn}async loadFile(){}isDestroyed(){return this.destroyed}show(){this.visible=true}focus(){}destroy(){this.destroyed=true;this.events.closed?.()}}
 const ctx={BrowserWindow:FakeWindow,answerWindow:null,latestAnswer:{status:'done',answer:'测试答案'},service:{config:{screenProtection:true}},screen:{getCursorScreenPoint:()=>({x:0,y:0}),getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1000,height:800}})},path:await import('node:path'),__dirname:'test',sendAnswerUpdate(){ctx.answerWindow.webContents.send('answer:update',{...ctx.latestAnswer,protection:ctx.service.config.screenProtection})}};
 vm.runInNewContext(source,ctx);await ctx.openAnswerWindow();assert.equal(instances[0].options.alwaysOnTop,true);assert.equal(instances[0].protection,true);assert.equal(instances[0].protectionBeforeShow,true);assert.equal(instances[0].sent[1].answer,'测试答案');await ctx.openAnswerWindow();assert.equal(instances.length,1);instances[0].destroy();await ctx.openAnswerWindow();assert.equal(instances.length,2);
});
