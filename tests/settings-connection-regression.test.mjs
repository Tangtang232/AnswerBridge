import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { listModels } from '../server/settings.mjs';
import { testConnection, testVision } from '../server/model-test.mjs';

test('选择清除密钥后不能用旧密钥获取模型',async()=>{
 const c=loadConfig({DEEPSEEK_API_KEY:'private-key'});let calls=0;const original=globalThis.fetch;
 globalThis.fetch=async()=>{calls++;throw Error('must not send')};
 try{await assert.rejects(listModels(c,'deepseek',{base:'https://api.deepseek.com',clearKey:true}),/取消清除/);assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
test('测试请求使用当前模型和密钥，不携带个人资料，并测量首字',async()=>{
 const c=loadConfig({DEEPSEEK_API_KEY:'old-key'});c.skills=[{name:'private',content:'PRIVATE_SKILL',enabled:true}];let got=[];const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{got.push({url,auth:options.headers.Authorization,body:JSON.parse(options.body)});return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 try{const p={base:'https://api.deepseek.com',model:'deepseek-flash',key:'new-key'};const t=await testConnection(c,'deepseek',p);const v=await testVision(c,'deepseek',p,'vision-model');assert.equal(got[0].auth,'Bearer new-key');assert.equal(got[0].body.model,'deepseek-flash');assert.equal(got[1].body.model,'vision-model');assert.doesNotMatch(JSON.stringify(got),/PRIVATE_SKILL/);assert.ok(Number.isFinite(t.firstTokenMs));assert.ok(Number.isFinite(v.firstTokenMs));}finally{globalThis.fetch=original;}
});
