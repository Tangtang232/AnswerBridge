import React, { useState } from 'react';

export default function RealtimeSettings({ value, skills, onChange, onSkills, busy, work }) {
  const [status, setStatus] = useState(null);
  const [choices, setChoices] = useState([]);
  const [manualOutput, setManualOutput] = useState('');
  const activeSkill = skills.find(skill => skill.id === value.skillId);
  function update(field, next) {
    setStatus(null);
    onChange({ ...value, [field]: next });
  }

  const configure = (chooseOutput = false) => work(async () => {
    setStatus(null);
    const result = await window.desktop.setupRealtime({
      key: value.key, prompt: value.prompt, skillId: value.skillId,
      outputLabel: manualOutput || undefined, chooseOutput
    });
    if (result.choices) {
      setChoices(result.choices);
      setManualOutput('');
      setStatus(result.choices.length ? '请选择播放设备，或接好耳机后重新检测。' : '未发现可用播放设备，请连接耳机后重试。');
      return;
    }
    onChange(result.realtime);
    setChoices([]);
    setManualOutput('');
    setStatus('已保存。打开答案小窗，点「开始实时语音」即可使用。');
  });
  const importSkill = () => work(async () => {
    const imported = await window.desktop.importSkills('files', 'realtime');
    if (imported) {
      onSkills(imported.skills);
      update('skillId', imported.skillId);
    }
  });
  const keyField = <label>豆包实时语音 API Key
    <input aria-label="实时语音 API Key" type="password" autoComplete="off" disabled={busy} value={value.key || ''}
      placeholder={value.hasKey ? '留空保留已保存的密钥' : '首次使用，请粘贴密钥'} onChange={event => update('key', event.target.value)} />
  </label>;
  return <section className="model-interface" aria-label="实时语音">
    <h2>实时语音</h2>
    <p className="hint">{value.outputLabel ? '已保存的播放设备：' + value.outputLabel : '自动检测 CABLE 和播放设备，回答在小窗显示。'}</p>
    {!value.hasKey && keyField}
    {choices.length > 0 && <label>播放设备
      <select aria-label="播放设备" disabled={busy} value={manualOutput} onChange={event => setManualOutput(event.target.value)}>
        <option value="">自动检测</option>{choices.map(label => <option key={label} value={label}>{label}</option>)}
      </select>
    </label>}
    <button className="primary" disabled={busy || value.clearKey} onClick={() => configure()}>{manualOutput ? '保存所选设备' : '一键配置'}</button>
    {status && <p className="hint" role="status">{status}</p>}
    <section className="voice-style" aria-label="语音回答风格">
      <h3>语音回答风格</h3>
      <label>提示词<textarea aria-label="语音会话提示词" disabled={busy} value={value.prompt || ''} maxLength={8000} rows={3}
        placeholder="例如：用自然中文回答，先说结论，再补一句理由。" onChange={event => update('prompt', event.target.value)} /></label>
      <div className="voice-skill-row">
        <label>语音 Skill<select aria-label="语音 Skill" disabled={busy} value={activeSkill?.id || ''} onChange={event => update('skillId', event.target.value)}>
          <option value="">不使用 Skill</option>{skills.map(skill => <option value={skill.id} key={skill.id}>{skill.name}</option>)}
        </select></label>
        <button className="secondary" disabled={busy} onClick={importSkill}>导入 Skill</button>
      </div>
      <p className="hint">提示词和所选 Skill 会随语音会话发送给豆包。</p>
      {activeSkill?.characters > value.skillMaxCharacters && <p className="hint">这个 Skill 较长，语音会话只使用前 {value.skillMaxCharacters.toLocaleString('zh-CN')} 个字符。</p>}
    </section>
    <details>
      <summary>更多语音设置</summary>
      <button className="secondary" disabled={busy || value.clearKey} onClick={() => configure(true)}>更换播放设备</button>
      {value.hasKey && keyField}
      {value.hasKey && <label className="check"><input type="checkbox" disabled={busy} checked={!!value.clearKey}
        onChange={event => update('clearKey', event.target.checked)} /> 点「保存并应用」时清除密钥</label>}
    </details>
  </section>;
}
