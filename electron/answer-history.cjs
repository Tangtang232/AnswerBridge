const { randomUUID } = require('node:crypto');

const MAX_HISTORY = 100;
const desktopStatuses = new Set(['queued', 'generating', 'done', 'error']);

class AnswerHistory {
  constructor(publish) {
    this.publish = publish;
    this.entries = new Map();
  }

  snapshot() {
    return [...this.entries.values()];
  }

  update(entry) {
    this.entries.set(entry.id, entry);
    const removed = [];
    if (this.entries.size > MAX_HISTORY) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
      removed.push(oldest);
    }
    this.publish({ entry, removed });
  }

  addDesktop(task) {
    if (!task || typeof task.id !== 'string' || !desktopStatuses.has(task.status)) return;
    this.update({
      id: 'task:' + task.id.slice(0, 100),
      source: task.source === 'screenshot' ? '截图' : '文字',
      status: task.status,
      question: typeof task.question === 'string' ? task.question.slice(0, 10000) : '',
      answer: typeof task.answer === 'string' ? task.answer.slice(0, 100000) : '',
      error: typeof task.error === 'string' ? task.error.slice(0, 1000) : ''
    });
  }
}

class VoiceTurns {
  constructor(history) {
    this.history = history;
    this.input = null;
    this.pending = [];
    this.responses = new Map();
    this.finished = new Set();
  }

  newTurn() {
    return { id: 'voice:' + randomUUID(), source: '实时语音', question: '', answer: '' };
  }

  save(turn, status, error = '') {
    turn.entry = { ...turn.entry, status, error };
    this.history.update(turn.entry);
  }

  handle(event) {
    const type = event.type;
    if (type.startsWith('conversation.item.input_audio_transcription.')) {
      this.transcribe(event);
    } else if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      this.answer(event);
    } else if (type === 'response.done' || type === 'response.canceled') {
      const key = this.responseKey(event);
      const turn = this.responses.get(key);
      if (!turn) return;
      this.responses.delete(key);
      if (key) {
        this.finished.add(key);
        if (this.finished.size > MAX_HISTORY) this.finished.delete(this.finished.values().next().value);
      }
      const incomplete = type === 'response.canceled' || !turn.entry.answer;
      this.save(turn, incomplete ? 'interrupted' : 'done');
    }
  }

  transcribe(event) {
    const phase = event.type.split('.').at(-1);
    if (phase === 'started' || !this.input) {
      this.input = { entry: this.newTurn(), endedAt: null };
    }
    const turn = this.input;
    if (phase === 'failed') {
      this.save(turn, 'error', '语音识别失败');
      this.input = null;
      return;
    }
    const transcript = event.transcript || event.text;
    const question = typeof transcript === 'string'
      ? transcript
      : turn.entry.question + (typeof event.delta === 'string' ? event.delta : '');
    turn.entry = { ...turn.entry, question: question.slice(0, 10000) };
    if (phase === 'completed') {
      turn.endedAt = performance.now();
      if (question.trim()) this.pending.push(turn);
      this.input = null;
    }
    if (question.trim()) this.save(turn, phase === 'completed' ? 'queued' : 'listening');
  }

  responseKey(event) {
    return event.response_id || event.response?.id || '';
  }

  answer(event) {
    const key = this.responseKey(event);
    if (key && this.finished.has(key)) return;
    let turn = this.responses.get(key);
    if (!turn) {
      turn = this.pending.shift() || { entry: this.newTurn(), endedAt: null };
      this.responses.set(key, turn);
    }
    const delta = typeof event.delta === 'string' ? event.delta : '';
    const complete = event.type === 'response.output_text.done';
    const text = complete && typeof event.text === 'string' && event.text
      ? event.text
      : turn.entry.answer + delta;
    if (text && !turn.entry.answer && turn.endedAt !== null) {
      turn.entry = { ...turn.entry, firstTextMs: Math.max(0, performance.now() - turn.endedAt) };
    }
    turn.entry = { ...turn.entry, answer: text.slice(0, 100000) };
    this.save(turn, complete && text ? 'done' : 'generating');
    // On streams without response IDs, text completion is the turn boundary.
    if (complete && !key) this.responses.delete(key);
  }

  stop() {
    for (const turn of [this.input, ...this.pending, ...this.responses.values()]) {
      if (turn && turn.entry.status && turn.entry.status !== 'done') this.save(turn, 'interrupted');
    }
    this.input = null;
    this.pending = [];
    this.responses.clear();
    this.finished.clear();
  }
}

module.exports = { AnswerHistory, VoiceTurns };
