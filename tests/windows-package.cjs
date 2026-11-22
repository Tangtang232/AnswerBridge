const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Tray, dialog, safeStorage, desktopCapturer, nativeImage } = require('electron');

const archive = path.resolve(process.argv[2] || path.join(__dirname, '../release/0.3.0/win-unpacked/resources/app.asar'));
const results = path.resolve(__dirname, '../test-results');
fs.mkdirSync(results, { recursive: true });
const profile = fs.mkdtempSync(path.join(results, 'popup-test-profile-'));
const result = path.join(results, 'popup-test-result.txt');
const desktopPreview = path.join(results, 'workspace-preview.png');
const popupPreview = path.join(results, 'popup-preview.png');
process.env.ANSWERBRIDGE_PROFILE = profile;
process.env.PORT = '0';
process.env.APP_MODE = 'demo';
app.setPath('userData', profile);

let socket;
let fixtureServer;
const modelRequests = [];
const voiceSessions = [];
const styleFile = path.join(profile, 'voice-style.md');
const configuredPrompt = '语音测试：先给结论，再用一句话解释。';
const voiceStyle = '用简洁口语解释，不添加未提供的数字。';
const textStyle = '文字专用风格，语音会话不应收到此段。';
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [styleFile] });
let step = '启动';
let tray;
let trayLabels;
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  tray = this;
  trayLabels = menu.items.map(item => item.label);
  return setContextMenu.call(this, menu);
};
class FixtureSocket extends EventEmitter {
  constructor() {
    super();
    socket = this;
    this.readyState = 1;
    this.bufferedAmount = 0;
    setImmediate(() => this.emit('open'));
  }
  send(payload) {
    const event = JSON.parse(payload);
    if (event.type === 'session.create') {
      voiceSessions.push(event.session);
      setImmediate(() => this.receive({ type: 'session.created' }));
    }
  }
  receive(event) { this.emit('message', JSON.stringify(event)); }
  close() { this.readyState = 3; this.emit('close'); }
}

const voiceModule = require(path.join(archive, 'electron', 'realtime-voice.cjs'));
const RealVoice = voiceModule.RealtimeVoice;
voiceModule.RealtimeVoice = class extends RealVoice {
  constructor(options) { super({ ...options, WebSocketImpl: FixtureSocket }); }
};

const routeModule = require(path.join(archive, 'electron', 'audio-route.cjs'));
const stereo = '耳机 (EDIFIER Z1 Air Stereo)';
const handsFree = '耳机 (EDIFIER Z1 Air Hands-Free AG Audio)';
const cableIn = 'CABLE Input (VB-Audio Virtual Cable)';
const cableOut = 'CABLE Output (VB-Audio Virtual Cable)';
const fixtures = {
  outputs: [{ Id: 'cable-out', Label: cableIn }, { Id: 'stereo', Label: stereo }, { Id: 'headset', Label: handsFree }],
  inputs: [{ Id: 'cable-in', Label: cableOut }, { Id: 'mic', Label: handsFree }],
  defaultOutput: 'cable-out',
  communicationOutput: 'cable-out',
  communicationInput: 'mic'
};
let configurationScans = 0;
let routesStarted = 0;
desktopCapturer.getSources = async () => [{
  thumbnail: nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 255), { width: 64, height: 64 })
}];
routeModule.createRoute = () => ({
  restore() {},
  enable() { routesStarted++; },
  async devices() { configurationScans++; return fixtures; }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      if (await check()) return;
    } catch (error) {
      if (!/Render frame was disposed/.test(error.message)) throw error;
    }
    await sleep(50);
  }
  throw Error('等待界面条件超时');
}
const run = (win, script) => win.webContents.executeJavaScript(script);
const windowNamed = title => BrowserWindow.getAllWindows().find(win => win.getTitle() === title);
const readCards = win => run(win, `Array.from(
  document.querySelectorAll('.answer-card'),
  card => ['.answer-question', '.answer-text', '.answer-meta'].map(part => card.querySelector(part).textContent)
)`);

app.whenReady().then(async () => {
  fixtureServer = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer fixture-model-key') {
      response.writeHead(401).end();
      return;
    }
    const modelRequest = JSON.parse(raw);
    modelRequests.push(modelRequest);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
    response.write(delta('第一段回答。'));
    await sleep(180);
    response.end(delta('第二段回答。') + 'data: [DONE]\n\n');
  });
  fixtureServer.listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  const fixtureBase = 'http://127.0.0.1:' + fixtureServer.address().port + '/v1';
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(styleFile, '---\nname: 简明口语\n---\n' + voiceStyle);
  fs.writeFileSync(path.join(profile, 'settings.enc'), safeStorage.encryptString(JSON.stringify({
    mode: 'demo',
    skills: [{
      id: 'text-only', name: '文字专用', content: textStyle, enabled: true,
      contentFormatVersion: 2, references: [], path: 'fixture-text-only.md'
    }],
    realtime: { key: 'fixture-only', outputLabel: stereo + ' (Bluetooth)', prompt: 'fixture-prompt' }
  })));
  require(path.join(archive, 'electron', 'main.cjs'));
  let main;
  await until(async () => {
    main = windowNamed('答桥 · AnswerBridge');
    return main && main.webContents.getURL().includes('/desktop') &&
      await run(main, '!!document.querySelector("textarea")');
  });
  step = '最小化到通知区';
  assert.ok(tray && !tray.isDestroyed());
  assert.ok(trayLabels.includes('打开答桥') && trayLabels.includes('直接退出'));
  main.minimize();
  await until(() => !main.isVisible());
  tray.emit('click');
  await until(() => main.isVisible() && !main.isMinimized());
  main.close();
  await until(() => !!windowNamed('关闭答桥'));
  const closeChoice = windowNamed('关闭答桥');
  await until(() => run(closeChoice, '!!document.getElementById("minimize")'));
  await run(closeChoice, 'document.getElementById("minimize").click()');
  await until(() => !main.isVisible());
  const openItem = trayLabels.find(label => label === '打开答桥');
  assert.equal(openItem, '打开答桥');
  tray.emit('click');
  await until(() => main.isVisible() && !main.isMinimized());
  step = '手机配对按需显示';
  const click = (win, label) => run(win, `[...document.querySelectorAll('button')].find(
    button => button.textContent.trim() === ${JSON.stringify(label)}
  ).click()`);
  assert.equal(await run(main, 'document.querySelector(".pairing img")'), null);
  await until(() => run(main, `[...document.querySelectorAll('button')].some(
    button => button.textContent === '连接手机' && !button.disabled
  )`));
  await click(main, '连接手机');
  await until(() => run(main, '!!document.querySelector(".pairing img")?.src'));
  const firstQr = await run(main, 'document.querySelector(".pairing img").src');
  await click(main, '收起配对');
  assert.equal(await run(main, 'document.querySelector(".pairing img")'), null);
  await click(main, '连接手机');
  await until(() => run(main, '!!document.querySelector(".pairing img")?.src'));
  assert.notEqual(await run(main, 'document.querySelector(".pairing img").src'), firstQr);
  await click(main, '收起配对');
  step = '缺少模型时引导设置';
  assert.equal(await run(main, 'document.body.textContent.includes("演示模式")'), false);
  assert.equal(await run(main, `(async () => {
    const { serverUrl, desktopToken } = await window.desktop.getInfo();
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + desktopToken };
    const session = await (await fetch(serverUrl + '/api/sessions', { method: 'POST', headers, body: '{}' })).json();
    const response = await fetch(serverUrl + '/api/sessions/' + session.sessionId + '/tasks', {
      method: 'POST', headers, body: JSON.stringify({ question: '缺密钥的测试请求' })
    });
    if (!(await response.json()).error.includes('API Key')) throw Error('missing configuration guidance');
    return response.status;
  })()`), 409);
  assert.equal(modelRequests.length, 0);
  await click(main, '配置回答模型');
  await until(() => run(main, `!!document.querySelector('[aria-label="文字模型 ID"]')`));
  assert.equal(await run(main, `!!document.querySelector('[aria-label="运行模式"]')`), false);
  const fill = (name, value) => run(main, `{
    const input = [...document.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === ${JSON.stringify(name)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }`);
  await fill('接口基址', fixtureBase);
  await fill('API Key', 'fixture-model-key');
  await fill('文字模型 ID', 'fixture-model');
  await click(main, '保存并应用');
  await until(() => run(main, `[...document.querySelectorAll('button')].some(button => button.textContent.includes('发送问题'))`));
  step = '一键配置';
  await run(main, `Array.from(document.querySelectorAll('button')).find(
    button => button.textContent.includes('软件设置')
  ).click()`);
  await until(() => run(main, `Array.from(document.querySelectorAll('button')).some(
    button => button.textContent === '一键配置'
  )`));
  await run(main, `Array.from(document.querySelectorAll('button')).find(
    button => button.textContent === '一键配置'
  ).click()`);
  await until(() => run(main, `document.body.textContent.includes('已保存。打开答案小窗')`));
  assert.equal(configurationScans, 1);
  const configured = await run(main, 'window.desktop.getSettings()');
  assert.equal(Object.hasOwn(configured, 'mode'), false);
  assert.deepEqual(configured.realtime, {
    hasKey: true, inputLabel: cableOut, outputLabel: handsFree, prompt: 'fixture-prompt',
    skillId: '', skillMaxCharacters: 12000
  });
  assert.equal(JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(profile, 'settings.enc')))).realtime.key, 'fixture-only');
  assert.equal(await run(main, `!!document.querySelector('[aria-label="文字模型 ID"]')`), false);
  step = '导入语音 Skill 并保存提示词';
  await click(main, '导入 Skill');
  await until(() => run(main, `!!document.querySelector('[aria-label="语音 Skill"]')?.value`));
  const selectedSkill = await run(main, `document.querySelector('[aria-label="语音 Skill"]').value`);
  await run(main, `{
    const input = document.querySelector('[aria-label="语音会话提示词"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(configuredPrompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }`);
  await click(main, '保存并应用');
  await until(() => run(main, '!document.querySelector(".settings-modal")'));
  const savedStyle = await run(main, 'window.desktop.getSettings()');
  assert.equal(savedStyle.realtime.prompt, configuredPrompt);
  assert.equal(savedStyle.realtime.skillId, selectedSkill);
  assert.equal(savedStyle.skills.find(skill => skill.id === selectedSkill).enabled, false);
  assert.equal(savedStyle.skills.find(skill => skill.id === 'text-only').enabled, true);
  await click(main, '软件设置');
  await until(() => run(main, `!!document.querySelector('[aria-label="语音 Skill"]')`));
  assert.equal(await run(main, `document.querySelector('[aria-label="语音 Skill"]').value`), selectedSkill);
  await click(main, '回答模型');
  assert.equal(await run(main, `!!document.querySelector('[aria-label="文字模型 ID"]')`), true);
  assert.equal(await run(main, `!!document.querySelector('[aria-label="默认文字服务商"]')`), false);
  await click(main, '高级设置');
  assert.equal(await run(main, 'document.body.textContent.includes("回答润色 Skill")'), true);
  await run(main, `Array.from(document.querySelectorAll('button')).find(
    button => button.textContent === '关闭'
  ).click()`);
  const submit = async question => {
    await run(main, `{
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(question)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }`);
    await until(() => run(main, `Array.from(document.querySelectorAll('button')).some(
      button => button.textContent.includes('发送问题') && !button.disabled
    )`));
    await run(main, `Array.from(document.querySelectorAll('button')).find(
      button => button.textContent.includes('发送问题')
    ).click()`);
    await until(() => run(main, 'document.querySelector("textarea").value === ""'));
  };
  step = '发送两条文字问题';
  await submit('第一条文字问题');
  await submit('第二条文字问题');
  step = '首次打开小窗';
  step = '截图和小窗';
  await run(main, `[...document.querySelectorAll('.capture-button')].find(
    button => button.textContent.includes('全屏截图')
  ).click()`);
  await run(main, 'window.desktop.openAnswerWindow()');
  let popup = windowNamed('答桥 · 答案小窗');
  await until(async () => (await readCards(popup)).filter(card => card[2].includes('已完成')).length === 3);
  assert.deepEqual((await readCards(popup)).slice(0, 2).map(card => card[0]), ['第一条文字问题', '第二条文字问题']);
  assert.match((await readCards(popup))[2][2], /截图/);
  assert.equal(routesStarted, 0);
  assert.equal(await run(popup, 'document.querySelector("#realtime-commit").hidden'), true);
  assert.equal(modelRequests.length, 3);
  assert.ok(modelRequests.every(request => request.stream === true && request.model === 'fixture-model'));
  assert.ok(modelRequests.every(request => !request.messages[0].content.includes(voiceStyle)));
  assert.ok(modelRequests[2].messages.at(-1).content.some(part => part.type === 'image_url'));
  assert.match((await readCards(popup))[2][1], /第一段回答。第二段回答。/);
  main.setContentProtection(false);
  popup.setContentProtection(false);
  fs.writeFileSync(desktopPreview, (await main.webContents.capturePage()).toPNG());
  fs.writeFileSync(popupPreview, (await popup.webContents.capturePage()).toPNG());

  // Use fixture audio endpoints through the real popup start button, with no changes to Windows routing.
  step = '验证语音和滚动';
  await run(popup, `{
    const track = { label: 'CABLE Output (VB-Audio Virtual Cable)', stop() {} };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'fixture-in', label: 'CABLE Output (VB-Audio Virtual Cable)' },
      { kind: 'audiooutput', deviceId: 'fixture-out', label: '耳机 (EDIFIER Z1 Air Hands-Free AG Audio) (Bluetooth)' }
    ];
    navigator.mediaDevices.getUserMedia = async () => stream;
    window.AudioContext = class {
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamSource() { return { connect: node => node }; }
      createGain() { return { gain: {}, connect() {} }; }
      async setSinkId(id) { if (id !== 'fixture-out') throw Error('unexpected device'); }
      async resume() {}
      async close() {}
    };
    window.AudioWorkletNode = class { port = {}; connect = node => node; };
  } true`);
  await click(popup, '开始实时语音');
  await until(() => run(popup, 'document.querySelector("#realtime-commit").hidden === false'));
  assert.equal(routesStarted, 1);
  assert.equal(voiceSessions.length, 1);
  assert.ok(voiceSessions[0].instructions.startsWith(configuredPrompt));
  assert.ok(voiceSessions[0].instructions.includes(voiceStyle));
  assert.ok(!voiceSessions[0].instructions.includes(textStyle));
  const emit = (type, fields = {}) => socket.receive({ type, ...fields });
  const asr = phase => 'conversation.item.input_audio_transcription.' + phase;
  await run(popup, `window.audioWasForwarded = false; window.answerWindow.onRealtime(event => {
    if (event.type.startsWith('response.output_audio.')) window.audioWasForwarded = true;
  }); true`);
  emit(asr('started'));
  emit(asr('delta'), { delta: '语音一' });
  emit(asr('completed'), { transcript: '第一轮语音问题' });
  emit('response.output_text.delta', { response_id: 'r1', delta: '第一轮' });
  await until(async () => (await readCards(popup)).some(card => card[1] === '第一轮'));
  emit(asr('started'));
  emit(asr('completed'), { transcript: '第二轮语音问题' });
  emit('response.output_text.delta', { response_id: 'r1', delta: '回答' });
  emit('response.output_audio.delta', { delta: 'AAABAA==' });
  emit('response.output_text.done', { response_id: 'r1', text: '第一轮回答' });
  emit('response.done', { response: { id: 'r1' } });
  emit('response.output_text.delta', { response_id: 'r2', delta: '第二轮回答' });
  emit('response.output_text.done', { response_id: 'r2' });
  emit('response.done', { response_id: 'r2' });
  await until(async () => (await readCards(popup)).some(card => card[1] === '第二轮回答'));
  assert.deepEqual((await readCards(popup)).slice(3).map(card => card.slice(0, 2)), [
    ['第一轮语音问题', '第一轮回答'], ['第二轮语音问题', '第二轮回答']
  ]);
  assert.equal(await run(popup, 'window.audioWasForwarded'), false);

  assert.equal(await run(popup, `document.querySelector('#font-larger').click();
    getComputedStyle(document.querySelector('.answer-text')).fontSize`), '18px');
  assert.equal(await run(popup, `document.querySelector('#history-scroll').scrollTop = 0;
    document.querySelector('#history-scroll').scrollHeight > document.querySelector('#history-scroll').clientHeight`), true);
  emit(asr('started'));
  emit(asr('completed'), { transcript: '第三轮语音问题' });
  emit('response.output_text.delta', { delta: '第三轮回答' });
  emit('response.done');
  await until(async () => (await readCards(popup)).some(card => card[1] === '第三轮回答'));
  assert.equal(await run(popup, 'document.querySelector("#history-scroll").scrollTop'), 0);
  assert.equal(await run(popup, 'document.querySelector("#jump-latest").hidden'), false);
  assert.equal(await run(popup, `document.querySelector('#jump-latest').click();
    document.querySelector('#history-scroll').scrollTop > 0`), true);
  await click(popup, '暂停实时语音');
  assert.equal(await run(popup, 'document.querySelector("#realtime-commit").hidden'), true);

  step = '重新打开小窗';
  const closed = once(popup, 'closed');
  popup.close();
  await closed;
  await run(main, 'window.desktop.openAnswerWindow()');
  popup = windowNamed('答桥 · 答案小窗');
  await until(async () => (await readCards(popup)).length === 6);
  assert.equal(await run(popup, 'getComputedStyle(document.querySelector(".answer-text")).fontSize'), '18px');
  assert.equal(routesStarted, 1);
  fs.writeFileSync(result, 'PASS: saved voice prompt and imported Skill, new session payload, text/voice style isolation, model setup, streaming, tray and history.');
  fixtureServer.close();
  app.quit();
}).catch(error => {
  fs.writeFileSync(result, step + ': ' + (error.stack || String(error)));
  fixtureServer?.close();
  app.exit(1);
});
