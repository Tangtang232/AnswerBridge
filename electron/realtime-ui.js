(() => {
  const byId = id => document.getElementById(id);
  const toggle = byId('realtime-toggle');
  const send = byId('realtime-commit');
  const settings = byId('realtime-settings');
  const status = byId('realtime-status');
  const bridge = window.answerWindow;
  let stream, context, player, monitorKey;
  let running = false;
  let ready = false;
  let closing = false;

  function releaseMonitor() {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      stream = null;
    }
    if (player) {
      player.pause();
      player.srcObject = null;
      player = null;
    }
    if (context) {
      void context.close().catch(() => {});
      context = null;
    }
    monitorKey = null;
  }

  function pause(message) {
    running = false;
    ready = false;
    bridge.stopRealtime();
    toggle.textContent = '开始实时语音';
    send.hidden = true;
    send.disabled = true;
    status.textContent = message;
  }

  const normalize = label => label.replace(/ \(Bluetooth\)$/i, '').trim().toLowerCase();
  async function setupMonitor(config) {
    const key = config.inputLabel + '\n' + config.outputLabel;
    if (stream && monitorKey === key) return;
    releaseMonitor();
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some(device => device.kind === 'audioinput' && /cable output/i.test(device.label))) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        probe.getTracks().forEach(track => track.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      if (closing) return;
      const inputs = devices.filter(device => device.kind === 'audioinput' && /cable output/i.test(device.label) &&
        !['default', 'communications'].includes(device.deviceId));
      const input = inputs.find(device => normalize(device.label) === normalize(config.inputLabel)) || inputs[0];
      const outputs = devices.filter(device => device.kind === 'audiooutput' && !['default', 'communications'].includes(device.deviceId));
      const sink = outputs.find(device => normalize(device.label) === normalize(config.outputLabel));
      if (!input) throw Error('找不到 CABLE Output，请检查虚拟声卡。');
      if (!sink || /cable/i.test(sink.label)) throw Error('找不到已配置的耳机，请连接耳机或重新配置。');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
      if (!/cable output/i.test(stream.getAudioTracks()[0]?.label || '')) throw Error('未连接到 CABLE Output。');
      context = new AudioContext({ latencyHint: 'interactive' });
      await context.audioWorklet.addModule('realtime-worklet.js');
      const source = context.createMediaStreamSource(stream);
      const pcm = new AudioWorkletNode(context, 'realtime-pcm');
      const mute = context.createGain();
      mute.gain.value = 0;
      let output;
      if (typeof context.setSinkId === 'function') {
        try {
          await context.setSinkId(sink.deviceId);
          output = context.destination;
        } catch {}
      }
      if (!output) {
        output = context.createMediaStreamDestination();
        player = new Audio();
        player.srcObject = output.stream;
        if (typeof player.setSinkId !== 'function') throw Error('当前系统无法选择耳机输出。');
        await player.setSinkId(sink.deviceId);
        await player.play();
      }
      source.connect(output);
      source.connect(pcm).connect(mute).connect(context.destination);
      await context.resume();
      if (closing) return;
      await bridge.enableAudioRoute();
      monitorKey = key;
      pcm.port.onmessage = ({ data }) => { if (running && ready) bridge.sendAudio(data); };
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          releaseMonitor();
          pause('电脑声音设备已断开。');
          settings.hidden = false;
          void bridge.restoreAudioRoute().catch(() => { status.textContent = '未能恢复播放设备，请检查 Windows 声音设置。'; });
        };
      }
    } catch (error) {
      releaseMonitor();
      if (!closing) {
        try { await bridge.restoreAudioRoute(); } catch {}
      }
      throw error;
    }
  }

  toggle.addEventListener('click', async () => {
    if (running) {
      pause('回答已暂停，仍可听到电脑原声。');
      return;
    }
    toggle.disabled = true;
    settings.hidden = true;
    try {
      const config = await bridge.getRealtimeConfig();
      if (!config.hasKey || !config.outputLabel) throw Error('请先完成一键配置。');
      status.textContent = '正在连接耳机…';
      await setupMonitor(config);
      if (closing || !monitorKey) return;
      running = true;
      toggle.textContent = '暂停实时语音';
      status.textContent = '正在连接语音模型…';
      await bridge.startRealtime();
    } catch (error) {
      pause(error.message || '无法开始实时语音。');
      settings.hidden = false;
    } finally {
      toggle.disabled = false;
    }
  });

  settings.addEventListener('click', () => {
    void bridge.openRealtimeSettings().catch(error => { status.textContent = error.message; });
  });
  send.addEventListener('click', async () => {
    if (!running || !ready) return;
    send.disabled = true;
    try {
      if (!await bridge.commitRealtime()) throw Error('语音连接尚未就绪。');
      if (running && send.disabled) status.textContent = '已发送，等待回答…';
    } catch (error) {
      status.textContent = error.message;
      send.disabled = !running || !ready;
    }
  });
  bridge.onRealtime(event => {
    if (!running) return;
    if (event.type === 'session.created' || event.type === 'input_audio_buffer.committed') {
      ready = true;
      send.hidden = false;
      send.disabled = false;
      status.textContent = '正在听电脑声音';
    } else if (event.type === 'error') {
      pause(event.message + ' 仍可听到电脑原声。');
      settings.hidden = false;
    }
  });
  window.addEventListener('beforeunload', () => {
    closing = true;
    pause('语音已停止。');
    releaseMonitor();
  });
})();
