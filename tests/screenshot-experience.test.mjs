import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/app.mjs';
import { loadConfig, publicConfig } from '../server/config.mjs';
import { testVision } from '../server/model-test.mjs';

test('图片能力测试发送内置图片，不携带个人 Skill', async()=>{
 const c=loadConfig({APP_MODE:'live'});c.skills=[{enabled:true,name:'private',content:'PRIVATE_SKILL_CONTENT'}];
 c.providers.deepseek={base:'https://api.deepseek.com',key:'test-key',model:'deepseek-flash'};
 const original=globalThis.fetch;let body;
 globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}),{headers:{'content-type':'application/json'}})};
 try {const result=await testVision(c,'deepseek',{base:'https://api.deepseek.com',model:'deepseek-flash'},'deepseek-flash');assert.equal(result.ok,true);assert.equal(body.messages.at(-1).content[1].type,'image_url');assert.doesNotMatch(JSON.stringify(body),/PRIVATE_SKILL_CONTENT/);} finally {globalThis.fetch=original;}
});

test('失败截图只允许桌面在会话内重试，重试后不能重复提交',async()=>{
 const c=loadConfig({PORT:'0'});let attempts=0;
 async function* fake(_c,task){attempts++;if(attempts===1)throw Error('fake failure');assert.ok(task.image);yield '成功';}
 const service=await createService({config:c,host:'127.0.0.1',modelAnswer:fake});
 const req=(path,body,token=service.desktopToken)=>fetch(service.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 try {
  const created=await (await req('/api/sessions',{})).json();const prefix=`/api/sessions/${created.sessionId}/tasks`;
  const task=await (await req(prefix,{provider:'doubao',question:'题目',image:'data:image/png;base64,AA=='})).json();
  for(let i=0;i<50&&service.sessions.get(created.sessionId).tasks[0].status!=='error';i++)await new Promise(r=>setTimeout(r,10));
  const retry=`${prefix}/${task.id}/retry`;assert.equal((await req(retry,{},null)).status,401);
  assert.equal((await req(retry,{provider:'doubao'})).status,202);assert.equal((await req(retry,{provider:'doubao'})).status,410);
  assert.equal(publicConfig(c).visionMode,'shared');
 } finally {await service.close();}
});
