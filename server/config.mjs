import os from 'node:os';
export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 无效');
  const mode = env.APP_MODE || 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Error('APP_MODE 必须是 demo 或 live');
  const contextTurns = Number(env.CONTEXT_TURNS ?? 6);
  if (!Number.isInteger(contextTurns) || contextTurns < 0 || contextTurns > 20) throw new Error('CONTEXT_TURNS 必须是 0 到 20 的整数');
  return { mode, port, publicBase: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    contextTurns,
    defaultProvider: ['doubao','deepseek','opencodego','custom'].includes(env.DEFAULT_PROVIDER) ? env.DEFAULT_PROVIDER : 'doubao',
    modelTimeout: Number(env.MODEL_TIMEOUT_MS || 120000),
    providers: {
      doubao: { key: env.DOUBAO_API_KEY || '', base: env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3', model: env.DOUBAO_MODEL || '' },
      deepseek: { key: env.DEEPSEEK_API_KEY || '', base: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model: env.DEEPSEEK_MODEL || 'deepseek-flash' },
      opencodego: { key: env.OPENCODE_GO_API_KEY || '', base: env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/inference/go/openai/v1', modelsUrl: env.OPENCODE_GO_MODELS_URL || 'https://opencode.ai/inference/go/v1/models', model: env.OPENCODE_GO_MODEL || '', protocol:'chat' },
      custom: { key:'',base:'https://api.example.com/v1',model:'',protocol:'chat' }
    },
    skills: [], visionMode: 'shared', screenProtection: true,
    visionProvider: ['doubao','deepseek','opencodego','custom'].includes(env.VISION_PROVIDER) ? env.VISION_PROVIDER : 'doubao',
    visionModel: env.VISION_MODEL || env.DOUBAO_VISION_MODEL || env.DOUBAO_MODEL || '',
    asr: { url: env.VOLC_ASR_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', key: env.VOLC_ASR_API_KEY || '', appKey: env.VOLC_ASR_APP_KEY || '', accessKey: env.VOLC_ASR_ACCESS_KEY || '', resource: env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration' }
  };
}
export function networkUrls(port) {
  const urls = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/loopback|vethernet|virtual|vmware|wsl/i.test(name)) continue;
    for (const a of addresses || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) urls.push({ name, url: `http://${a.address}:${port}` });
  }
  const rank = name => /wi-?fi|wlan|无线/i.test(name) ? 0 : /ethernet|以太网/i.test(name) ? 1 : 2;
  return urls.sort((a,b)=>rank(a.name)-rank(b.name));
}
export function publicConfig(c) {
  return { mode: c.mode, defaultProvider: c.defaultProvider, screenProtection:c.screenProtection !== false, visionMode:c.visionMode||'shared', visionProvider:c.visionProvider, visionModel:c.visionModel, skillCount:(c.skills||[]).filter(s=>s.enabled).length, asrReady: !!(c.asr.key || (c.asr.appKey && c.asr.accessKey)), visionReady: !!(c.providers[c.visionProvider].key && c.visionModel), providers: Object.fromEntries(Object.entries(c.providers).map(([k, p]) => [k, { ready: !!(p.key && p.model), hasKey:!!p.key, model: p.model }])) };
}
