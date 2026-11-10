import test from 'node:test';import assert from 'node:assert/strict';
import {createService} from '../server/app.mjs';import {loadConfig} from '../server/config.mjs';
test('刷新二维码后旧码失效，新码只能使用一次',async()=>{
 const s=await createService({host:'127.0.0.1',config:loadConfig({PORT:'0',APP_MODE:'demo'})});
 const post=async(path,body,auth=true)=>fetch(s.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+s.desktopToken}:{})},body:JSON.stringify(body)});
 try{const first=await(await post('/api/sessions',{})).json();const old=new URL(first.url).hash.slice(6);const fresh=await(await post(`/api/sessions/${first.sessionId}/pair`,{})).json();const token=new URL(fresh.url).hash.slice(6);assert.equal((await post('/api/pair',{token:old},false)).status,410);assert.equal((await post('/api/pair',{token},false)).status,200);assert.equal((await post('/api/pair',{token},false)).status,410);}finally{await s.close();}
});
