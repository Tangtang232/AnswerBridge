import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { loadConfig, networkUrls, publicConfig, resolveModel } from './config.mjs';
import { answer } from './models.mjs';

const secret = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const send = (ws, event) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2_000_000) ws.close(1013, 'reconnect'); else ws.send(JSON.stringify(event)); } };
const publicTask = ({ image, images, controller, ...rest }) => rest;
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

export async function createService({ config = loadConfig(), webDir = path.resolve('dist'), host = '0.0.0.0', modelAnswer = answer, captureScreen } = {}) {
  const app = express(), server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  const desktopToken = secret(), sessions = new Map(), retryImages = new Map(); let port, remoteCapturePending = false;
  function forgetRetry(id) { const entry=retryImages.get(id); if(entry){clearTimeout(entry.timer);retryImages.delete(id);} }
  function rememberRetry(task, sessionId) {
    while(retryImages.size>=5) forgetRetry(retryImages.keys().next().value);
    const entry={image:task.image, images:task.images, sessionId, timer:null};
    entry.timer=setTimeout(()=>forgetRetry(task.id),120000); entry.timer.unref(); retryImages.set(task.id,entry);
  }
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); next(); });
  app.use('/api/sessions/:id/image-batch', (req, _res, next) => {
    const s = sessions.get(req.params.id);
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!s?.viewerToken || !equal(token, s.viewerToken)) return next(failure('配对已失效，请重新扫码', 401));
    next();
  }, express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '9mb' }));
  const owner = (req, _res, next) => equal(req.headers.authorization?.replace(/^Bearer /, ''), desktopToken) ? next() : next(failure('未授权', 401));
  const getSession = id => { const session = sessions.get(id); if (!session) throw failure('会话不存在，请重新扫码', 404); return session; };
  const announce = (s, event) => { for (const ws of s.clients) send(ws, event); };
  const visionReady = () => resolveModel(config, config.defaultProvider, true).ready;
  const snapshot = s => ({ type: 'snapshot', sessionId: s.id, visionReady: visionReady(), paired: !!s.viewerToken, phoneOnline: [...s.clients].some(w => w.role === 'phone' && w.readyState === WebSocket.OPEN), tasks: s.tasks.map(publicTask) });
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
    const images = body.images === undefined ? (body.image ? [body.image] : []) : body.images;
    if (!Array.isArray(images) || images.length > 6 || images.some(image => typeof image !== 'string' || image.length > 8_000_000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image)) || images.reduce((total, image) => total + image.length, 0) > 24_000_000) throw failure('最多提交 6 张截图，单张不超过 6 MB，总大小不超过 18 MB');
    if (question.length > 10000 || (!question && !images.length)) throw failure('请输入问题');
    if (body.image && (typeof body.image !== 'string' || body.image.length > 8_000_000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(body.image))) throw failure('截图格式无效或超过 6 MB');
    if (s.tasks.filter(t => ['queued', 'generating'].includes(t.status)).length >= 5) throw failure('待处理问题已达 5 个，请等待答案后重试', 429);
    const hasImage = images.length > 0;
    const target = resolveModel(config, body.provider, hasImage);
    if (!target.ready) throw failure(hasImage ? '请先在电脑的软件设置中配置支持图片的回答模型。' : '请先在软件设置中填写回答模型的 API Key 和模型 ID。', 409);
    const task = { id: randomUUID(), question: question || '请解答截图中的问题', image: body.image || null, images: body.images ? [...images] : null, imageCount: images.length, hasImage, clientRequestId: body.clientRequestId, provider: target.provider, source: hasImage ? 'screenshot' : body.source === 'voice' ? 'voice' : 'text', status: 'queued', answer: '', error: '', createdAt: Date.now() };
    if (hasImage) task.model = target.model;
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
        } catch (error) { task.status = 'error'; task.error = error.name === 'AbortError' ? '任务已取消' : error.message; if(task.hasImage && error.name!=='AbortError') rememberRetry(task,s.id); }
        finally { task.image = null; task.images = null; delete task.controller; task.finishedAt = Date.now(); announce(s, { type: 'task', task: publicTask(task) }); }
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
  // A paired phone may request a full screenshot, but cannot submit arbitrary tasks.
  app.post('/api/sessions/:id/capture', async (req, res) => {
    const s = getSession(req.params.id);
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const authorized = () => !!s.viewerToken && equal(token, s.viewerToken);
    if (!authorized()) throw failure('配对已失效，请重新扫码', 401);
    if (!captureScreen) throw failure('当前服务不支持截图，请启动桌面客户端', 503);
    if (req.body?.collect !== true && !visionReady()) throw failure('请先在电脑的软件设置中配置支持图片的回答模型。', 409);
    if (remoteCapturePending) throw failure('正在截图，请稍后再试', 409);
    if (s.tasks.filter(t => ['queued', 'generating'].includes(t.status)).length >= 5) throw failure('待处理问题已达 5 个，请等待答案后重试', 429);
    remoteCapturePending = true;
    try {
      let image;
      try { image = await captureScreen(); }
      catch (error) { throw failure(error.message || '电脑截图失败，请重试', 503); }
      if (typeof image !== 'string' || !image) throw failure('未能获取电脑截图，请重试', 503);
      // Pairing can be revoked or replaced while the desktop is capturing.
      if (!authorized()) throw failure('配对已失效，请重新扫码', 401);
      if (req.body?.collect === true) return res.json({ image });
      const task = enqueue(s, { image, question: '请识别并解答截图中的问题。', provider: config.defaultProvider });
      res.status(202).json(task);
    } finally { remoteCapturePending = false; }
  });
  app.post('/api/sessions/:id/image-batch', (req, res) => {
    const s = getSession(req.params.id);
    if (!s.viewerToken || !equal(req.headers.authorization?.replace(/^Bearer /, ''), s.viewerToken)) throw failure('配对已失效，请重新扫码', 401);
    const { images, clientRequestId } = req.body || {};
    if (typeof clientRequestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(clientRequestId)) throw failure('请求标识无效');
    const existing = s.tasks.find(t => t.clientRequestId === clientRequestId);
    if (existing) return res.status(202).json(publicTask(existing));
    if (!Array.isArray(images) || !images.length) throw failure('请先截取至少一张图片');
    const task = enqueue(s, { images, clientRequestId, question: `请结合这 ${images.length} 张截图解答同一道题。`, provider: config.defaultProvider });
    res.status(202).json(task);
  });
  app.post('/api/sessions/:id/tasks', owner, (req, res) => res.status(202).json(enqueue(getSession(req.params.id), req.body)));
  app.post('/api/sessions/:id/tasks/:taskId/retry', owner, (req,res) => {
    const s=getSession(req.params.id), old=s.tasks.find(t=>t.id===req.params.taskId), cached=retryImages.get(req.params.taskId);
    if(!old || old.status!=='error' || !cached || cached.sessionId!==s.id) throw failure('截图已过期或不可重试，请重新截图',410);
    const result=enqueue(s,{question:old.question,image:cached.image,images:cached.images || undefined,provider:req.body.provider});
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
    res.json({ sessionId: s.id, viewerToken: s.viewerToken, visionReady: visionReady() });
  });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const origins = [...allowedBases(), 'http://127.0.0.1:5173', 'http://localhost:5173'];
    if (req.url !== '/ws' || (origin && !origins.includes(origin))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  sockets.on('connection', ws => {
    let s; ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const authTimer = setTimeout(() => ws.close(4003, 'auth required'), 5000); authTimer.unref();
    ws.on('message', (bytes, binary) => {
      try {
        if (binary) {
          return ws.close(4003, 'binary audio unsupported');
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
        if (['audio_start','audio_stop','demo_transcript'].includes(msg.type)) throw failure('旧版语音采集已移除，请在答案小窗使用实时语音');
      } catch (error) { send(ws, { type: 'error', message: error.message || '请求失败' }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(authTimer);
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
  return { app, server, sessions, config, desktopToken, port, baseUrl: `http://127.0.0.1:${port}`, notifySettings(){for(const s of sessions.values())announce(s,{type:'config',visionReady:visionReady()});}, async close() {
    clearInterval(heartbeat);
    for (const s of sessions.values()) for (const task of s.tasks) task.controller?.abort();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeIdleConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
