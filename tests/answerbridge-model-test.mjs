import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { answer } from '../server/models.mjs';
import { mergeSettings, viewSettings } from '../server/settings.mjs';

test('截图默认使用当前文字服务商和模型，单独截图配置可选', async () => {
  const c=loadConfig({APP_MODE:'live'});
  c.providers.deepseek={base:'https://api.deepseek.com',key:'test',model:'deepseek-flash'};
  c.providers.opencodego.key='test';c.visionProvider='opencodego';c.visionModel='old-model';
  let captured;
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{captured={url,body:JSON.parse(options.body)};return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}),{headers:{'content-type':'application/json'}});};
  try {
    for await (const _ of answer(c,{provider:'deepseek',image:'data:image/jpeg;base64,AA==',question:'test'})) {}
    assert.equal(captured.url,'https://api.deepseek.com/chat/completions');
    assert.equal(captured.body.model,'deepseek-flash');
    assert.equal(captured.body.messages.at(-1).content[1].type,'image_url');
    const draft=viewSettings(c); draft.defaultProvider='deepseek'; draft.visionMode='custom';
    assert.equal(mergeSettings(c,draft).visionMode,'custom');
    draft.visionMode='shared';assert.equal(mergeSettings(c,draft).visionMode,'shared');
  } finally {globalThis.fetch=original;}
});
