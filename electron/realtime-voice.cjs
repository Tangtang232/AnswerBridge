const WebSocket = require('ws');

class RealtimeVoice {
  constructor({ key, prompt, onEvent, WebSocketImpl = WebSocket }) {
    this.key = key; this.prompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : '请直接回答听到的问题，优先给结论，尽量控制在一两句，不要编造。'; this.onEvent = onEvent; this.WebSocketImpl = WebSocketImpl;
    this.ws = null; this.ready = false; this.closed = false;
  }
  start() {
    const ws = this.ws = new this.WebSocketImpl('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', { headers: { 'X-Api-Key': this.key }, handshakeTimeout: 15000 });
    ws.on('open', () => ws.send(JSON.stringify({type:'session.create',session:{model:'1.2.6.1',instructions:this.prompt,audio:{input:{format:{type:'pcm',rate:16000}},output:{format:{type:'pcm_s16le',rate:24000},voice:'zh_female_vv_jupiter_bigtts'}}}})));
    ws.on('message', raw => {
      let e; try { e = JSON.parse(raw.toString()); } catch { return; }
      if (e.type === 'session.created') this.ready = true;
      if (e.type === 'error') this.onEvent({ type:'error', message:'实时语音服务返回错误，请检查服务权限与连接设置。' });
      else if (['session.created','input_audio_buffer.committed','conversation.item.input_audio_transcription.started','conversation.item.input_audio_transcription.delta','conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed','response.output_text.delta','response.output_text.done','response.done','response.canceled'].includes(e.type)) this.onEvent(e);
    });
    ws.on('unexpected-response', (_req,res) => { res.resume(); this.onEvent({type:'error',message:`实时语音连接失败（HTTP ${res.statusCode}）`}); });
    ws.on('error', () => this.onEvent({type:'error',message:'实时语音连接失败，请检查网络。'}));
    ws.on('close', () => { this.ready = false; if (!this.closed) this.onEvent({type:'error',message:'实时语音连接已断开。'}); });
  }
  send(pcm) { if (this.ready && this.ws?.readyState === 1 && this.ws.bufferedAmount < 500000) this.ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:Buffer.from(pcm).toString('base64')})); }
  commit() { if (!this.ready || this.ws?.readyState !== 1) return false; this.ws.send(JSON.stringify({type:'input_audio_buffer.commit'}));return true; }
  stop() { this.closed = true; this.ready = false; this.key = ''; if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({type:'session.close'})); this.ws?.close(); }
}
module.exports = { RealtimeVoice };
