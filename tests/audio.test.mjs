import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { loadConfig, publicConfig } from '../server/config.mjs';
import { selectDevices } from '../electron/realtime-setup.cjs';

test('实时语音处理器每帧输出 20ms 的 16kHz PCM', () => {
  let Processor;
  const frames = [];
  const context = {
    AudioWorkletProcessor: class { port = { postMessage: pcm => frames.push(pcm) }; },
    sampleRate: 48000,
    registerProcessor: (name, implementation) => { assert.equal(name, 'realtime-pcm'); Processor = implementation; }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../electron/realtime-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  for (let i = 0; i < 40; i++) processor.process([[new Float32Array(128).fill(0.25)]]);
  assert.equal(frames.length, 5);
  assert.ok(frames.every(frame => frame.byteLength === 640));
  assert.equal(new Int16Array(frames[0])[0], 8192);
});

test('音频一键配置识别 CABLE 和同一耳机的通话模式', () => {
  const input = { Id: 'in', Label: 'CABLE Output (VB-Audio Virtual Cable)' };
  const output = { Id: 'out', Label: 'CABLE Input (VB-Audio Virtual Cable)' };
  const stereo = { Id: 'stereo', Label: '耳机 (Fixture Stereo)' };
  const handsFree = { Id: 'hands-free', Label: '耳机 (Fixture Hands-Free AG Audio)' };
  const mic = { ...handsFree, Id: 'mic' };
  const state = { inputs: [input, mic], outputs: [output, stereo, handsFree], defaultOutput: 'out', communicationInput: 'mic' };
  assert.deepEqual(selectDevices(state, stereo.Label + ' (Bluetooth)'), { inputLabel: input.Label, outputLabel: handsFree.Label });
  assert.throws(() => selectDevices({ ...state, inputs: [mic] }), /Virtual Cable/);
  assert.deepEqual(selectDevices({ ...state, outputs: [output] }, stereo.Label), { choices: [] });
});

test('公开配置报告可用性，但不会返回密钥或语音提示词', () => {
  const config = loadConfig({ DOUBAO_API_KEY: 'private-model-key', DOUBAO_MODEL: 'model' });
  config.realtime = { key: 'private-voice-key', prompt: 'private-voice-prompt' };
  const result = publicConfig(config);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.equal(result.visionReady, true);
});
