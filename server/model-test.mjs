import{answer}from'./models.mjs';import{mergeSettings,viewSettings,protocolFor}from'./settings.mjs';
export async function testConnection(config,id,providerDraft){
 const view=viewSettings(config);const draft={...view,mode:'live',defaultProvider:id,providers:{[id]:providerDraft},skills:[]};
 const c=mergeSettings(config,draft);c.modelTimeout=25000;c.maxTokens=64;c.skills=[];
 const started=Date.now();let text='',firstTokenMs=null;
 for await(const delta of answer(c,{question:'连接测试，请只回复 OK。',provider:id,id:'answerbridge-connection-test',conversationId:'answerbridge-connection-test'})){if(firstTokenMs===null)firstTokenMs=Date.now()-started;text+=delta;}
 return{ok:true,provider:id,model:c.providers[id].model,protocol:protocolFor(id,c.providers[id].model,c.providers[id].protocol),firstTokenMs,elapsedMs:Date.now()-started,preview:text.slice(0,160),testedAt:Date.now()};
}
export async function testVision(config,id,providerDraft,model){
 const view=viewSettings(config);const draft={...view,mode:'live',defaultProvider:id,visionMode:'custom',visionProvider:id,visionModel:model,providers:{[id]:{...providerDraft,model:providerDraft.model||model}},skills:[]};
 const c=mergeSettings(config,draft);c.modelTimeout=25000;c.maxTokens=64;c.skills=[];
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII=';
 const started=Date.now();let text='',firstTokenMs=null;
 for await(const delta of answer(c,{question:'请确认你收到了图片，简短回复。',image,provider:id,model,id:'answerbridge-vision-test'})){if(firstTokenMs===null)firstTokenMs=Date.now()-started;text+=delta;}
 return{ok:true,provider:id,model,firstTokenMs,elapsedMs:Date.now()-started,preview:text.slice(0,160),testedAt:Date.now()};
}
