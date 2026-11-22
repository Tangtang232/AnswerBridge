import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerHistory, VoiceTurns } from '../electron/answer-history.cjs';
import { mergeSettings, realtimeInstructions, viewSettings } from '../server/settings.mjs';
import { loadConfig } from '../server/config.mjs';

test('文字问题按任务 ID 更新并保留旧答案', () => {
  const history = new AnswerHistory(() => {});
  history.addDesktop({ id: 'first', status: 'generating', question: '第一题', answer: '第一段' });
  history.addDesktop({ id: 'second', status: 'queued', question: '第二题' });
  history.addDesktop({ id: 'first', status: 'done', question: '第一题', answer: '第一段第二段' });
  assert.deepEqual(history.snapshot().map(({ question, answer }) => [question, answer]), [
    ['第一题', '第一段第二段'], ['第二题', '']
  ]);
});

test('上一轮尚在回答时，新语音问题拥有自己的记录', () => {
  const history = new AnswerHistory(() => {});
  const turns = new VoiceTurns(history);
  const transcription = transcript => turns.handle({ type: 'conversation.item.input_audio_transcription.completed', transcript });
  const reply = (id, delta) => turns.handle({ type: 'response.output_text.delta', response_id: id, delta });
  transcription('第一问');
  reply('first', '第一段');
  transcription('第二问');
  reply('first', '第二段');
  turns.handle({ type: 'response.done', response_id: 'first' });
  reply('second', '第二答');
  turns.handle({ type: 'response.done', response_id: 'second' });
  assert.deepEqual(history.snapshot().map(({ question, answer, status }) => [question, answer, status]), [
    ['第一问', '第一段第二段', 'done'], ['第二问', '第二答', 'done']
  ]);
});

test('语音只接收所选 Skill，移除 Skill 后清除选择', () => {
  const config = loadConfig({});
  config.skills = [{ id: 'text', enabled: true, content: '文字风格' }, { id: 'voice', enabled: false, content: '语音风格' }];
  const draft = viewSettings(config);
  draft.realtime.prompt = '直接回答';
  draft.realtime.skillId = 'voice';
  const next = mergeSettings(config, draft);
  const prompt = realtimeInstructions(next);
  assert.match(prompt, /^直接回答/);
  assert.match(prompt, /语音风格/);
  assert.doesNotMatch(prompt, /文字风格/);
  assert.equal(next.skills[1].enabled, false);
  assert.equal(mergeSettings(next, { ...draft, skills: [draft.skills[0]] }).realtime.skillId, '');
});
