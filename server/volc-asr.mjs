import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

// Volc ASR v3: 4-byte header, optional signed sequence, big-endian payload size.
export function encodePacket(type, flags, payload, { json = false, sequence } = {}) {
  const bytes = gzipSync(json ? Buffer.from(JSON.stringify(payload)) : payload);
  const header = Buffer.from([0x11, (type << 4) | flags, (json ? 0x10 : 0) | 1, 0]);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const seq = sequence === undefined ? Buffer.alloc(0) : Buffer.alloc(4);
  if (seq.length) seq.writeInt32BE(sequence);
  return Buffer.concat([header, seq, size, bytes]);
}
export function decodePacket(input) {
  const b = Buffer.from(input);
  if (b.length < 8 || b[0] >> 4 !== 1) throw new Error('ASR 数据帧无效');
  let offset = (b[0] & 15) * 4; const type = b[1] >> 4, flags = b[1] & 15;
  let sequence = null, code = null;
  const read32 = signed => { if (offset + 4 > b.length) throw new Error('ASR 数据帧截断'); const n = signed ? b.readInt32BE(offset) : b.readUInt32BE(offset); offset += 4; return n; };
  if (type === 15) code = read32(false);
  else if (flags & 1) sequence = read32(true);
  const size = read32(false);
  if (size > 2_000_000 || offset + size !== b.length) throw new Error('ASR 负载长度无效');
  let payload = b.subarray(offset);
  if ((b[2] & 15) === 1) payload = gunzipSync(payload, { maxOutputLength: 4_000_000 });
  else if ((b[2] & 15) !== 0) throw new Error('ASR 压缩格式不支持');
  const data = (b[2] >> 4) === 1 ? JSON.parse(payload.toString()) : payload.toString();
  if (type === 15) throw new Error(`火山 ASR 返回错误（${code}）`);
  return { data, sequence, last: !!(flags & 2), type };
}

export class VolcASR {
  constructor(config, onTranscript, onState) {
    this.config = config; this.onTranscript = onTranscript; this.onState = onState;
    this.sequence = 1; this.queue = []; this.seen = new Set(); this.stopping = false; this.closed = false;
  }
  start() {
    const c = this.config;
    if (!c.key && !(c.appKey && c.accessKey)) throw new Error('请先配置火山 ASR 的 API Key（或 App Key / Access Key）');
    const headers = { 'X-Api-Resource-Id': c.resource, 'X-Api-Connect-Id': randomUUID(), 'X-Api-Request-Id': randomUUID() };
    if (c.key) headers['X-Api-Key'] = c.key;
    else { headers['X-Api-App-Key'] = c.appKey; headers['X-Api-Access-Key'] = c.accessKey; }
    this.socket = new WebSocket(c.url, { headers, handshakeTimeout: 12000, maxPayload: 4_000_000 });
    this.onState('connecting');
    this.socket.on('open', () => {
      this.socket.send(encodePacket(1, 1, { user: { uid: 'answerbridge' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true, result_type: 'full' } }, { json: true, sequence: this.sequence++ }));
      for (const chunk of this.queue) this.send(chunk); this.queue = [];
      this.onState('ready');
      if (this.stopping) this.sendFinal();
    });
    this.socket.on('message', bytes => {
      try {
        const { data, last } = decodePacket(bytes);
        if (data?.code && data.code !== 1000 && data.code !== 20000000) throw new Error(`火山 ASR 识别失败（${data.code}）`);
        const result = Array.isArray(data?.result) ? data.result[0] : data?.result;
        if (result?.text) this.onTranscript({ text: result.text, final: false });
        for (const utterance of result?.utterances || []) {
          const key = `${utterance.start_time}:${utterance.end_time}:${utterance.text}`;
          if (utterance.definite && !this.seen.has(key) && utterance.text?.trim()) {
            this.seen.add(key); this.onTranscript({ text: utterance.text.trim(), final: true, key });
          }
        }
        if (last) this.close();
      } catch (error) { this.fail(error.message); }
    });
    this.socket.on('error', () => this.fail('火山 ASR 连接失败，请检查网络、资源开通状态和鉴权配置'));
    this.socket.on('unexpected-response', (_request, response) => { response.resume(); this.fail(`火山 ASR 鉴权失败（HTTP ${response.statusCode}）`); });
    this.socket.on('close', () => { if (!this.closed) { this.closed = true; this.onState(this.stopping ? 'stopped' : 'error', this.stopping ? undefined : '语音连接已断开，请重新开始采集'); } });
  }
  send(chunk) {
    if (this.closed || this.stopping) return;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (this.queue.length >= 30) return this.fail('语音连接超时，音频缓冲已满');
      this.queue.push(Buffer.from(chunk)); return;
    }
    if (this.socket.bufferedAmount > 1_000_000) return this.fail('语音网络拥塞，请停止后重试');
    this.socket.send(encodePacket(2, 1, chunk, { sequence: this.sequence++ }));
  }
  stop() { if (this.closed || this.stopping) return; this.stopping = true; if (this.socket?.readyState === WebSocket.OPEN) this.sendFinal(); }
  sendFinal() {
    this.socket.send(encodePacket(2, 3, Buffer.alloc(0), { sequence: -this.sequence++ }));
    this.stopTimer = setTimeout(() => this.close(), 3000); this.stopTimer.unref();
  }
  fail(message) { if (this.closed) return; this.onState('error', message); this.close(); }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.stopTimer); this.queue = []; this.socket?.terminate(); this.onState('stopped'); }
}
