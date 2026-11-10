import test from 'node:test';import assert from 'node:assert/strict';import {once}from'node:events';import WebSocket from'ws';import{createService}from'../server/app.mjs';import{loadConfig}from'../server/config.mjs';import{encodePacket,decodePacket}from'../server/volc-asr.mjs';import{parseSSE,answer}from'../server/models.mjs';import http from'node:http';
test('配对令牌一次有效，越权拒绝，手机实时收到答案并可重连恢复',async()=>{
 const s=await createService({config:loadConfig({APP_MODE:'demo',PORT:'0'})});let phone,desktop;
 const req=async(path,body,auth=true)=>{const r=await fetch(s.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+s.desktopToken}:{})},body:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
 try{assert.equal((await req('/api/sessions',{},false)).status,401);const {data:p}=await req('/api/sessions',{});const token=new URL(p.url).hash.slice(6);const joined=await req('/api/pair',{token},false);assert.equal(joined.status,200);assert.equal((await req('/api/pair',{token},false)).status,410);
 const connect=async(role,token)=>{const w=new WebSocket(s.baseUrl.replace('http','ws')+'/ws');await once(w,'open');const ready=once(w,'message');w.send(JSON.stringify({type:'auth',role,token,sessionId:p.sessionId}));assert.equal(JSON.parse((await ready)[0]).type,'snapshot');return w;};
 phone=await connect('phone',joined.data.viewerToken);const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('答案超时')),5000);phone.on('message',data=>{const e=JSON.parse(data);if(e.type==='task'&&e.task.status==='done'){clearTimeout(timer);resolve(e.task);}});});
 assert.equal((await req(`/api/sessions/${p.sessionId}/tasks`,{question:'你好',provider:'doubao'})).status,202);const task=await done;assert.match(task.answer,/演示答案/);assert.equal(task.image,undefined);
 phone.terminate();phone=await connect('phone',joined.data.viewerToken);const forbidden=once(phone,'message');phone.send(JSON.stringify({type:'audio_start'}));let denied=JSON.parse((await forbidden)[0]); if(denied.type==='presence') denied=JSON.parse((await once(phone,'message'))[0]); assert.equal(denied.type,'error');
 const s2=await req('/api/sessions',{});const bad=new WebSocket(s.baseUrl.replace('http','ws')+'/ws');await once(bad,'open');const close=once(bad,'close');bad.send(JSON.stringify({type:'auth',role:'phone',sessionId:s2.data.sessionId,token:joined.data.viewerToken}));assert.equal((await close)[0],4003);
 }finally{phone?.terminate();desktop?.terminate();await s.close();}
});
test('火山协议 gzip、序列号、末包与损坏数据',()=>{const packet=encodePacket(9,3,{result:{text:'测试'}},{json:true,sequence:-2});const data=decodePacket(packet);assert.equal(data.data.result.text,'测试');assert.equal(data.sequence,-2);assert.equal(data.last,true);assert.throws(()=>decodePacket(packet.subarray(0,9)));});
test('SSE 跨数据块与 CRLF',async()=>{async function* body(){yield Buffer.from('data: {"choices":[{"delta":{"content":"你');yield Buffer.from('好"}}]}\r\n\r\ndata: [DONE]\n\n');}const events=[];for await(const e of parseSSE(body()))events.push(e);assert.equal(events[0].choices[0].delta.content,'你好');});
test('回答携带此前问答作为上下文，并按设置限制轮数',async()=>{
 const seen=[];const modelAnswer=async function*(config,task,history){seen.push(history.map(t=>t.question));yield '答案';};
 const run=async turns=>{const s=await createService({config:{...loadConfig({APP_MODE:'live',PORT:'0'}),contextTurns:turns,defaultProvider:'custom',providers:{...loadConfig({}).providers,custom:{base:'http://127.0.0.1:1',key:'k',model:'m'}}},modelAnswer});
  try{const create=await fetch(s.baseUrl+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.desktopToken},body:'{}'});const{ sessionId }=await create.json();
   for(const question of ['第一问','第二问','第三问'])await fetch(`${s.baseUrl}/api/sessions/${sessionId}/tasks`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+s.desktopToken},body:JSON.stringify({question})});
   const waitUntil=async()=>{for(let i=0;i<200&&s.sessions.get(sessionId).tasks.some(t=>t.status!=='done');i++)await new Promise(r=>setTimeout(r,10));};
   await waitUntil();return s.sessions.get(sessionId).tasks.length;
  }finally{await s.close();}};
 await run(6);
 assert.deepEqual(seen,[[],[ '第一问' ],['第一问','第二问']],'每问都应看到此前已完成的问答');
 seen.length=0;await run(0);
 assert.deepEqual(seen,[[],[],[]],'轮数为 0 时不携带上下文');
 seen.length=0;await run(2);
 assert.deepEqual(seen.at(-1),['第一问','第二问'],'最近两轮');
});
test('真实模型适配器请求图像并消费流式回复（本地假服务）',async()=>{let payload;const fake=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);payload=JSON.parse(Buffer.concat(chunks));assert.equal(req.headers.authorization,'Bearer test-key');res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"识别完成"}}]}\n\ndata: [DONE]\n\n');});await new Promise(r=>fake.listen(0,'127.0.0.1',r));try{const config=loadConfig({APP_MODE:'live',DOUBAO_API_KEY:'test-key',DOUBAO_MODEL:'test-model',DOUBAO_BASE_URL:`http://127.0.0.1:${fake.address().port}`});let result='';for await(const d of answer(config,{image:'data:image/png;base64,AA==',question:'解答',provider:'doubao'}))result+=d;assert.equal(result,'识别完成');assert.equal(payload.messages.at(-1).content[1].type,'image_url');}finally{fake.closeIdleConnections();await new Promise(r=>fake.close(r));}});
