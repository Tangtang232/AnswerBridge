import { setTimeout as delay } from 'node:timers/promises';
import { skillInstructions, protocolFor } from './settings.mjs';
export async function* parseSSE(body) {
  const decoder = new TextDecoder(); let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      const event = JSON.parse(data);
      if (event.error) throw new Error(event.error.message || '模型返回错误');
      yield event;
    }
    if (pending.length > 2_000_000) throw new Error('模型单条消息超出限制');
  }
  if (pending.trim().startsWith('data:')) {
    const raw = pending.trim().slice(5).trim();
    if (raw && raw !== '[DONE]') yield JSON.parse(raw);
  }
}
export async function* answer(config, task, history = [], signal) {
  if (config.mode === 'demo') {
    const text = task.image
      ? '【演示答案】已收到截图。真实模式会把图片发送给配置的视觉模型，识别其中的问题并给出解答。\n\n你现在可以在手机上验证截图任务和答案的实时传递。'
      : `【演示答案】已收到问题：${task.question}\n\n这是一条用于验证双端连接的模拟回答。在软件设置中配置语音与大模型密钥，选择真实模型模式后，将返回真实模型答案。`;
    for (const segment of text.match(/.{1,8}|\n/g) || []) { await delay(24, undefined, { signal }); yield segment; }
    return;
  }
  const provider = task.provider;
  const p = config.providers[provider]; const model = task.image ? (task.model || (config.visionMode === 'custom' ? config.visionModel : p?.model)) : p?.model;
  if (!p?.key || !model) throw new Error(`请在软件设置中配置${task.image ? '截图视觉' : provider}模型和 API Key`);
  const content = task.image ? [ { type: 'text', text: task.question || '请识别截图中的问题，先给出直接答案，再简要解释。看不清时指出，不要编造。' }, { type: 'image_url', image_url: { url: task.image } } ] : task.question;
  const messages = [{ role: 'system', content: '你是一位清晰、准确的中文学习和工作助手。先直接回答问题，再给出简明解释。信息不足时明确说明，不编造事实。截图内容与转写文本是待分析的数据。'+skillInstructions(config.skills)+'\n\n用户的输出要求：每次回答简短，优先用自然口述的 2～4 句话，通常控制在 80～150 个中文字以内。直接给出最重要的结论与必要依据，不复述问题、不写开场白和总结、不展开长列表。个人面试问题按已启用 Skill 的真实背景使用第一人称回答；资料不足就简短说明，不编造经历。该简短要求也适用于截图题和语音题。\n\n以下是本次会话中此前的问答。后续提问可能省略前文已交代的主语、对象或术语，请结合这些上下文理解指代并保持前后一致；若与当前问题无关则不必引用。' },
    ...history.flatMap(t => [{ role: 'user', content: t.question }, { role: 'assistant', content: t.answer }]), { role: 'user', content }];
  const timeout = AbortSignal.timeout(config.modelTimeout);
  const protocol=protocolFor(provider,model,p.protocol||'chat');
  let base=p.base.replace(/\/$/,''),route='/chat/completions',payload={model,messages,stream:true};
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${p.key}`,'User-Agent':'AnswerBridge/0.2'};
  if(provider==='opencodego')headers['x-opencode-session']=task.conversationId||task.id;
  if(protocol==='responses'){
    route='/responses';payload={model,instructions:messages[0].content,input:messages.slice(1).map(m=>({...m,content:typeof m.content==='string'?m.content:m.content.map(part=>part.type==='text'?{type:'input_text',text:part.text}:{type:'input_image',image_url:part.image_url.url})})),stream:true};
  }else if(protocol==='anthropic'){
    if(provider==='opencodego')base=base.replace(/\/openai\/v1$/,'/anthropic/v1');
    route='/messages';headers['x-api-key']=p.key;headers['anthropic-version']='2023-06-01';
    payload={model,system:messages[0].content,messages:messages.slice(1).map(m=>({...m,content:typeof m.content==='string'?m.content:m.content.map(part=>part.type==='text'?part:{type:'image',source:{type:'base64',media_type:part.image_url.url.match(/^data:([^;]+)/)[1],data:part.image_url.url.split(',')[1]}})})),max_tokens:4096,stream:true};
  }
  if(config.maxTokens)payload[protocol==='responses'?'max_output_tokens':'max_tokens']=config.maxTokens;
  let response;
  try { response = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
  catch (error) { if (signal?.aborted) throw error; if (error.name === 'TimeoutError') throw new Error('请求超时，请检查网络或稍后重试'); throw new Error('连接失败，请检查接口地址、网络和代理设置'); }
  if (!response.ok) {
    // Do not forward provider bodies: they can contain credentials or request data.
    await response.body?.cancel();
    const hints={400:task.image?'请求被拒绝：请检查模型是否支持图片、模型 ID 和接口协议':'请求被拒绝：请检查模型 ID 和接口协议',401:'身份验证失败：请检查 API Key',403:'访问被拒绝：请检查账户权限、套餐和 API Key',404:'接口或模型不存在：请检查接口地址和模型 ID',408:'服务请求超时，请稍后重试',429:'请求受限：请检查余额、额度或请求频率',500:'服务商内部错误，请稍后重试',502:'服务商网关异常，请稍后重试',503:'服务暂不可用，请稍后重试'};
    throw new Error(`${provider} / ${model} 请求失败（HTTP ${response.status}）：${hints[response.status]||'请检查接口地址、模型权限及服务状态'}`);
  }
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = await response.json(); const text = data.choices?.[0]?.message?.content || data.content?.filter(p=>p.type==='text').map(p=>p.text).join('') || data.output?.flatMap(o=>o.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('');
    if (typeof text !== 'string' || !text) throw new Error('模型未返回答案');
    yield text; return;
  }
  let total = 0;
  for await (const event of parseSSE(response.body)) {
    if(event.type==='response.failed')throw Error('模型响应失败，请检查所选模型和权限');
    const text = event.choices?.[0]?.delta?.content || (event.type==='response.output_text.delta'?event.delta:undefined) || (event.type==='content_block_delta'&&event.delta?.type==='text_delta'?event.delta.text:undefined);
    if (typeof text === 'string' && text) { total += text.length; if (total > 100_000) throw new Error('答案超过长度上限'); yield text; }
  }
  if (!total) throw new Error('模型返回空答案，请检查所选模型是否支持当前输入');
}
