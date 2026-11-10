import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { createService } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';

test('模型分段内容经答桥逐段推送手机，完成后答案一致',async()=>{
 const fake=http.createServer(async(req,res)=>{for await(const _ of req){};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');setTimeout(()=>{res.write('data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n');res.end('data: [DONE]\n\n')},150)});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));const c=loadConfig({PORT:'0',APP_MODE:'live'});c.providers.custom={key:'test',base:`http://127.0.0.1:${fake.address().port}`,model:'test',protocol:'chat'};c.defaultProvider='custom';const service=await createService({config:c,host:'127.0.0.1'});let phone;
 const req=async(path,body,auth=true)=>fetch(service.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+service.desktopToken}:{})},body:JSON.stringify(body)});
 try{const pair=await (await req('/api/sessions',{})).json();const token=new URL(pair.url).hash.slice(6);const join=await(await req('/api/pair',{token},false)).json();phone=new WebSocket(service.baseUrl.replace('http','ws')+'/ws');await once(phone,'open');let chunks=[],done,doneResolve;const result=new Promise(r=>doneResolve=r);phone.on('message',data=>{const e=JSON.parse(data);if(e.type==='delta')chunks.push(e.delta);if(e.type==='task'&&e.task.status==='done'){done=e.task.answer;doneResolve();}});phone.send(JSON.stringify({type:'auth',role:'phone',token:join.viewerToken,sessionId:pair.sessionId}));await new Promise(r=>setTimeout(r,30));assert.equal((await req(`/api/sessions/${pair.sessionId}/tasks`,{question:'解释 TCP 和 UDP',provider:'custom'})).status,202);await Promise.race([result,new Promise((_,reject)=>setTimeout(()=>reject(Error('任务超时')),3000))]);assert.deepEqual(chunks,['第一段','第二段']);assert.equal(done,'第一段第二段');}finally{phone?.terminate();await service.close();fake.closeIdleConnections();await new Promise(r=>fake.close(r));}
});
