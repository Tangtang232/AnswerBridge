import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { loadConfig, networkUrls, publicConfig } from './config.mjs';
import { answer } from './models.mjs';
import { VolcASR } from './volc-asr.mjs';

const secret = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const send = (ws, event) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2_000_000) ws.close(1013, 'reconnect'); else ws.send(JSON.stringify(event)); } };
const publicTask = ({ image, controller, ...rest }) => rest;
const CONTEXT_CHARS = 12_000;
// Earlier turns give the model continuity. Screenshots are kept as text only: the image itself
// is dropped once answered, and re-sending old images would multiply cost per new question.
function contextHistory(session, current, turns) {
  if (!turns) return [];
  const past = session.tasks.filter(t => t !== current && t.status === 'done' && t.answer.trim() && t.createdAt <= current.createdAt);
  const picked = [];
  let budget = CONTEXT_CHARS;
  for (let i = past.length - 1; i >= 0 && picked.length < turns; i--) {
    const t = past[i], cost = t.question.length + t.answer.length;
    if (cost > budget) break;
    budget -= cost; picked.unshift(t);
  }
  return picked;
}

export async function createService({ config = loadConfig(), webDir = path.resolve('dist'), host = '0.0.0.0', modelAnswer = answer, asrFactory = (...args) => new VolcASR(...args) } = {}) {
  const app = express(), server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const desktopToken = secret(), sessions = new Map(), retryImages = new Map(); let port;
  function forgetRetry(id) { const entry=retryImages.get(id); if(entry){clearTimeout(entry.timer);retryImages.delete(id);} }
  function rememberRetry(task, sessionId) {
    while(retryImages.size>=5) forgetRetry(retryImages.keys().next().value);
    const entry={image:task.image, sessionId, timer:null};
    entry.timer=setTimeout(()=>forgetRetry(task.id),120000); entry.timer.unref(); retryImages.set(task.id,entry);
  }
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); next(); });
  app.use(express.json({ limit: '9mb' }));
  const owner = (req, _res, next) => equal(req.headers.authorization?.replace(/^Bearer /, ''), desktopToken) ? next() : next(failure('未授权', 401));
  const getSession = id => { const session = sessions.get(id); if (!session) throw failure('会话不存在，请重新扫码', 404); return session; };
  const announce = (s, event) => { for (const ws of s.clients) send(ws, event); };
  const snapshot = s => ({ type: 'snapshot', sessionId: s.id, mode: config.mode, paired: !!s.viewerToken, phoneOnline: [...s.clients].some(w => w.role === 'phone' && w.readyState === WebSocket.OPEN), tasks: s.tasks.map(publicTask) });
  const allowedBases = () => [ `http://127.0.0.1:${port}`, `http://localhost:${port}`, ...networkUrls(port).map(x => x.url), ...(config.publicBase ? [config.publicBase] : []) ];
  async function pairing(s, selectedBase) {
    const base = selectedBase || config.publicBase || networkUrls(port)[0]?.url || `http://127.0.0.1:${port}`;
    if (!allowedBases().includes(base)) throw failure('请选择当前电脑的网络地址');
    s.pair = { token: secret(), expires: Date.now() + 120_000 };
    const url = `${base}/m#pair=${s.pair.token}`;
    return { sessionId: s.id, url, expires: s.pair.expires, qr: await QRCode.toDataURL(url, { width: 260, margin: 2, color: { dark: '#142540', light: '#ffffff' } }) };
  }
  function enqueue(s, body) {
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question.length > 10000 || (!question && !body.image)) throw failure('请输入问题');
    if (body.image && (typeof body.image !== 'string' || body.image.length > 8_000_000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(body.image))) throw failure('截图格式无效或超过 6 MB');
    if (s.tasks.filter(t => ['queued', 'generating'].includes(t.status)).length >= 5) throw failure('待处理问题已达 5 个，请等待答案后重试', 429);
    const task = { id: randomUUID(), question: question || '请解答截图中的问题', image: body.image || null, hasImage: !!body.image, provider: Object.hasOwn(config.providers,body.provider) ? body.provider : config.defaultProvider, source: body.image ? 'screenshot' : body.source === 'voice' ? 'voice' : 'text', status: 'queued', answer: '', error: '', createdAt: Date.now(), demo: config.mode === 'demo' };
    if (task.hasImage && config.visionMode === 'custom') task.provider = config.visionProvider;
    if (task.hasImage) task.model = config.visionMode === 'custom' ? config.visionModel : config.providers[task.provider]?.model;
    task.conversationId=s.id;
    s.tasks.push(task);
    if (s.tasks.length > 100) s.tasks.splice(0, s.tasks.length - 100);
    announce(s, { type: 'task', task: publicTask(task) });
    void drain(s); return publicTask(task);
  }
  async function drain(s) {
    if (s.running) return; s.running = true;
    try {
      for (let task; (task = s.tasks.find(t => t.status === 'queued'));) {
        task.status = 'generating'; task.controller = new AbortController();
        announce(s, { type: 'task', task: publicTask(task) });
        try {
          const history = contextHistory(s, task, config.contextTurns);
          for await (const delta of modelAnswer(config, task, history, task.controller.signal)) {
            task.answer += delta; announce(s, { type: 'delta', taskId: task.id, delta });
          }
          task.status = 'done';
        } catch (error) { task.status = 'error'; task.error = error.name === 'AbortError' ? '任务已取消' : error.message; if(task.image && error.name!=='AbortError') rememberRetry(task,s.id); }
        finally { task.image = null; delete task.controller; task.finishedAt = Date.now(); announce(s, { type: 'task', task: publicTask(task) }); }
      }
    } finally { s.running = false; }
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'AnswerBridge' }));
  app.get('/api/config', owner, (_req, res) => res.json({ ...publicConfig(config), networkUrls: networkUrls(port), publicBase: config.publicBase }));
  app.post('/api/sessions', owner, async (_req, res) => {
    if (sessions.size >= 8) throw failure('会话数量已达上限，请重启客户端');
    const s = { id: secret(), tasks: [], clients: new Set(), pair: null, viewerToken: null, running: false, createdAt: Date.now() };
    sessions.set(s.id, s); res.json(await pairing(s));
  });
  app.post('/api/sessions/:id/pair', owner, async (req, res) => res.json(await pairing(getSession(req.params.id), req.body.base)));
  app.post('/api/sessions/:id/tasks', owner, (req, res) => res.status(202).json(enqueue(getSession(req.params.id), req.body)));
  app.post('/api/sessions/:id/tasks/:taskId/retry', owner, (req,res) => {
    const s=getSession(req.params.id), old=s.tasks.find(t=>t.id===req.params.taskId), cached=retryImages.get(req.params.taskId);
    if(!old || old.status!=='error' || !cached || cached.sessionId!==s.id) throw failure('截图已过期或不可重试，请重新截图',410);
    const result=enqueue(s,{question:old.question,image:cached.image,provider:req.body.provider});
    forgetRetry(old.id); res.status(202).json(result);
  });
  app.post('/api/sessions/:id/disconnect', owner, (req, res) => {
    const s = getSession(req.params.id); s.viewerToken = null; s.pair = null;
    for (const ws of s.clients) if (ws.role === 'phone') ws.close(4001, 'unpaired');
    announce(s, { type: 'presence', phoneOnline: false, paired: false }); res.json({ ok: true });
  });
  app.post('/api/pair', (req, res) => {
    const s = [...sessions.values()].find(s => s.pair && equal(s.pair.token, req.body.token));
    if (!s || s.pair.expires < Date.now()) throw failure('二维码已使用或已过期，请在电脑上刷新二维码', 410);
    s.pair = null; s.viewerToken = secret();
    for (const ws of s.clients) if (ws.role === 'phone') ws.close(4001, 'replaced');
    res.json({ sessionId: s.id, viewerToken: s.viewerToken, mode: config.mode });
  });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const origins = [...allowedBases(), 'http://127.0.0.1:5173', 'http://localhost:5173'];
    if (req.url !== '/ws' || (origin && !origins.includes(origin))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  sockets.on('connection', ws => {
    let s, asr, autoTimer, speech = '', autoAnswer = true, provider = config.defaultProvider;
    let demoTimer, stopping = false; ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const authTimer = setTimeout(() => ws.close(4003, 'auth required'), 5000); authTimer.unref();
    const stopAudio = () => { clearInterval(demoTimer); demoTimer = null; asr?.stop(); asr = null; };
    const transcript = item => {
      if (!s || ws.readyState !== WebSocket.OPEN) return;
      announce(s, { type: 'transcript', ...item });
      if (item.final && autoAnswer && !stopping) {
        speech = `${speech} ${item.text}`.trim(); clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
          const text = speech; speech = '';
          if (text) try { enqueue(s, { question: text, source: 'voice', provider }); } catch (error) { send(ws, { type: 'error', message: error.message }); }
        }, 1400); autoTimer.unref();
      }
    };
    ws.on('message', (bytes, binary) => {
      try {
        if (binary) {
          if (!s || ws.role !== 'desktop') return ws.close(4003, 'desktop required');
          if (bytes.length > 32000 || bytes.length % 2) throw failure('音频数据格式错误');
          asr?.send(bytes); return;
        }
        const msg = JSON.parse(bytes.toString());
        if (!s) {
          if (msg.type !== 'auth') return ws.close(4003, 'auth required');
          s = getSession(msg.sessionId);
          if (msg.role === 'desktop' && equal(msg.token, desktopToken)) ws.role = 'desktop';
          else if (msg.role === 'phone' && equal(msg.token, s.viewerToken)) ws.role = 'phone';
          else { s = null; return ws.close(4003, 'invalid credentials'); }
          clearTimeout(authTimer); s.clients.add(ws); send(ws, snapshot(s));
          announce(s, { type: 'presence', phoneOnline: [...s.clients].some(w => w.role === 'phone' && w.readyState === WebSocket.OPEN), paired: !!s.viewerToken }); return;
        }
        if (msg.type === 'ping') return send(ws, { type: 'pong' });
        if (ws.role !== 'desktop') throw failure('手机端仅用于接收答案', 403);
        if (msg.type === 'audio_start') {
          stopAudio(); stopping = false; autoAnswer = msg.autoAnswer !== false;
          provider = Object.hasOwn(config.providers,msg.provider) ? msg.provider : config.defaultProvider;
          speech = ''; clearTimeout(autoTimer);
          if (config.mode === 'demo') {
            send(ws, { type: 'asr_state', state: 'ready' });
            demoTimer = setInterval(() => transcript({ text: '请用简洁的语言解释，什么是大语言模型？', final: true, key: randomUUID() }), 12000);
            demoTimer.unref();
          } else {
            asr = asrFactory(config.asr, transcript, (state, message) => send(ws, { type: 'asr_state', state, message }));
            asr.start();
          }
        } else if (msg.type === 'audio_stop') {
          stopping = true; clearTimeout(autoTimer); speech = ''; stopAudio(); send(ws, { type: 'asr_state', state: 'stopped' });
        } else if (msg.type === 'demo_transcript' && config.mode === 'demo') transcript({ text: '请解释 TCP 和 UDP 的主要区别。', final: true, key: randomUUID() });
      } catch (error) { send(ws, { type: 'error', message: error.message || '请求失败' }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      stopping = true; clearTimeout(authTimer); clearTimeout(autoTimer); stopAudio();
      if (s) { s.clients.delete(ws); announce(s, { type: 'presence', phoneOnline: [...s.clients].some(w => w.role === 'phone' && w.readyState === WebSocket.OPEN), paired: !!s.viewerToken }); }
    });
  });
  const heartbeat = setInterval(() => { for (const ws of sockets.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 20000); heartbeat.unref();
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir, { index: false }));
    for (const route of ['/', '/desktop', '/m']) app.get(route, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.status ? error.message : error.type === 'entity.too.large' ? '上传内容过大' : '服务内部错误' }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, host, resolve); });
  port = server.address().port;
  return { app, server, sessions, config, desktopToken, port, baseUrl: `http://127.0.0.1:${port}`, notifySettings(){for(const s of sessions.values())announce(s,{type:'config',mode:config.mode});}, async close() {
    clearInterval(heartbeat);
    for (const s of sessions.values()) for (const task of s.tasks) task.controller?.abort();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeIdleConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
