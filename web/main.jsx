import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Settings, { providerNames } from './Settings.jsx';
import MultiCapture from './MultiCapture.jsx';
import './style.css';
import './workspace.css';

const mobile = location.pathname === '/m';
const statusLabels = { queued: '等待中', generating: '正在回答', done: '已完成', error: '失败' };
const sourceLabels = { screenshot: '▧ 截图', voice: '◉ 语音', text: '⌨ 文字' };

function Answers({ tasks, busy, connected, retry }) {
  return <div className="answers">
    {tasks.length === 0 && <div className="empty">
      <h3>答案会显示在这里</h3>
      <p>{mobile ? '可以从手机发起截图。' : '截图或输入问题即可开始，手机连接可选。'}</p>
    </div>}
    {[...tasks].reverse().map(task => <article className="answer" key={task.id}>
      <div className="meta">
        <span>{sourceLabels[task.source]}{task.imageCount > 1 && ` · ${task.imageCount} 张`} · {providerNames[task.provider] || task.provider}</span>
        <span className={task.status === 'generating' ? 'accent' : ''}>{statusLabels[task.status]}</span>
      </div>
      <h3>{task.question}</h3>
      <div className="answer-text">
        {task.answer || (task.status === 'error' ? '' : task.status === 'queued' ? '等待处理…' : '正在准备答案…')}
        {task.status === 'generating' && <span className="cursor" />}
      </div>
      {task.error && <p className="error-inline">{task.error}</p>}
      {!mobile && task.source === 'screenshot' && task.status === 'error' && <div>
        <button className="secondary" disabled={busy || !connected} onClick={() => retry(task)}>重试截图回答</button>
        <small> 截图在本机内存保留 2 分钟。重试可能产生费用。</small>
      </div>}
      <footer>{new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</footer>
    </article>)}
  </div>;
}

function Pairing({ connected, online, config, base, refresh, pair, busy, clear }) {
  const [open, setOpen] = useState(false);
  const networks = config?.networkUrls ?? [];
  function requestPair(value) {
    clear();
    void refresh(value);
  }
  return <section className="panel pairing">
    <div className="section-title"><h2>手机同步</h2>{online && <span className="online">已连接</span>}</div>
    <button className="secondary full" aria-expanded={open} disabled={!connected || busy} onClick={() => {
      setOpen(!open);
      if (!open) requestPair(base);
    }}>{open ? '收起配对' : '连接手机'}</button>
    {open && <div className="pairing-options">
      <p className="hint">手机与电脑连同一 Wi-Fi，用微信扫一扫。</p>
      {pair ? <img className="qr" src={pair.qr} alt="手机配对二维码" /> :
        <p role="status">{busy ? '正在生成二维码…' : '二维码未生成'}</p>}
      {(networks.length > 1 || (config?.publicBase && networks.length > 0)) && <details>
        <summary>切换配对网络</summary>
        <select aria-label="配对网络" value={base} disabled={busy} onChange={event => requestPair(event.target.value)}>
          {config.publicBase && <option value={config.publicBase}>{config.publicBase}</option>}
          {networks.map(network => <option key={network.url} value={network.url}>{network.name} · {network.url}</option>)}
        </select>
      </details>}
      <button className="text-button" disabled={busy} onClick={() => requestPair(base)}>刷新二维码</button>
    </div>}
  </section>;
}

function App() {
  const [info, setInfo] = useState(null);
  const [config, setConfig] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [online, setOnline] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [question, setQuestion] = useState('');
  const [base, setBase] = useState('');
  const [pair, setPair] = useState(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  const [batch, setBatch] = useState(false);
  const session = useRef();
  const desktop = useRef();
  const previousTasks = useRef(new Map());

  async function request(route, body, token = desktop.current?.desktopToken) {
    const result = await fetch((desktop.current?.serverUrl ?? '') + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await result.json();
    if (!result.ok) throw Error(data.error || '请求失败');
    return data;
  }

  useEffect(() => {
    let active = true, socket, reconnect, offCapture, offError, offSettings;
    function connect(credentials) {
      if (!active) return;
      session.current = credentials;
      socket = new WebSocket((desktop.current?.serverUrl ?? location.origin).replace(/^http/, 'ws') + '/ws');
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', role: mobile ? 'phone' : 'desktop', ...credentials }));
      socket.onmessage = ({ data }) => {
        const event = JSON.parse(data);
        if (event.type === 'snapshot') {
          setTasks(event.tasks); setOnline(event.phoneOnline); setConnected(true); setError('');
        }
        if (event.type === 'config' || event.type === 'snapshot') {
          setConfig(current => ({ ...current, visionReady: event.visionReady }));
        }
        if (event.type === 'presence') setOnline(event.phoneOnline);
        if (event.type === 'task') setTasks(current => [...current.filter(t => t.id !== event.task.id), event.task].sort((a, b) => a.createdAt - b.createdAt));
        if (event.type === 'delta') setTasks(current => current.map(t => t.id === event.taskId ? { ...t, answer: t.answer + event.delta } : t));
        if (event.type === 'error') setError(event.message);
      };
      socket.onclose = event => {
        setConnected(false);
        if ([4001, 4003].includes(event.code)) {
          if (mobile) { localStorage.removeItem('answerbridge'); setBatch(false); }
          setError('连接已失效，请重新扫码配对。');
        } else if (active) reconnect = setTimeout(() => connect(credentials), 2000);
      };
      socket.onerror = () => setError('连接失败，请检查电脑服务和网络。');
    }
    async function init() {
      if (mobile) {
        const token = new URLSearchParams(location.hash.slice(1)).get('pair');
        let credentials;
        if (token) {
          const data = await request('/api/pair', { token }, null);
          credentials = { sessionId: data.sessionId, token: data.viewerToken };
          localStorage.setItem('answerbridge', JSON.stringify(credentials));
          history.replaceState(null, '', '/m');
        } else credentials = JSON.parse(localStorage.getItem('answerbridge') || 'null');
        if (!credentials) throw Error('请先扫描电脑端二维码。');
        connect(credentials);
      } else {
        if (!window.desktop) throw Error('请使用答桥桌面程序。');
        const info = await window.desktop.getInfo();
        desktop.current = info; setInfo(info);
        const config = await request('/api/config');
        setConfig(config); setBase(config.publicBase || config.networkUrls[0]?.url || info.serverUrl);
        const { sessionId } = await request('/api/sessions', {});
        connect({ sessionId, token: info.desktopToken });
        offCapture = window.desktop.onCapture(({ image }) => void runTask('tasks', { image, question: '请识别并解答截图中的问题。' }));
        offError = window.desktop.onError(setError);
        offSettings = window.desktop.onRealtimeSettings(() => setSettings('voice'));
      }
    }
    void init().catch(e => setError(e.message));
    return () => { active = false; clearTimeout(reconnect); socket?.close(); offCapture?.(); offError?.(); offSettings?.(); };
  }, []);

  useEffect(() => {
    if (mobile || !window.desktop) return;
    const current = new Map();
    for (const task of tasks) {
      current.set(task.id, task);
      if (previousTasks.current.get(task.id) !== task) window.desktop.publishAnswer(task);
    }
    previousTasks.current = current;
  }, [tasks]);

  async function runTask(action, body) {
    const current = session.current;
    if (!current) return;
    setBusy(true); setError('');
    try {
      await request(`/api/sessions/${current.sessionId}/${action}`, body, current.token);
      if (action === 'tasks' && !body.image) setQuestion('');
      if (action === 'capture') setNotice('电脑截图已提交。');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function refreshPair(address) {
    if (!session.current || pairBusy) return;
    setPairBusy(true); setError('');
    try {
      setPair(await request(`/api/sessions/${session.current.sessionId}/pair`, { base: address }));
      setBase(address);
    } catch (e) { setError(e.message); }
    finally { setPairBusy(false); }
  }

  const currentModel = config?.providers?.[config.defaultProvider];
  const visionReady = Boolean(config?.visionReady);
  const answers = <Answers tasks={tasks} busy={busy} connected={connected} retry={task => runTask(`tasks/${task.id}/retry`, {})} />;
  return <div className={mobile ? 'app mobile' : 'app'}>
    <header>
      <div className="brand"><b className="logo">答</b><div><strong>答桥 <small>AnswerBridge</small></strong><p>{mobile ? '同步答案' : '桌面工作台'}</p></div></div>
      <span className="pill"><i className={connected ? 'dot' : 'dot gray'} />{connected ? (mobile ? '已连接电脑' : '会话已连接') : '连接中'}</span>
    </header>
    {error && <div role="alert" className="error">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
    {notice && <div role="status" className="saved-banner">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    {mobile ? <>
      <section className="mobile-heading">
        <h1>查看答案</h1>
        <button className="primary full remote-capture" disabled={!connected || !visionReady || busy || batch} onClick={() => runTask('capture', {})}>{busy ? '正在截取电脑屏幕…' : '截取电脑全屏并回答'}</button>
        <button className="secondary full multi-trigger" disabled={!connected || !visionReady || busy || batch} onClick={() => setBatch(true)}>多图提问</button>
        <p className="hint">{connected && !visionReady ? '请先在电脑端配置支持图片的回答模型。' : '截取电脑鼠标所在的屏幕。'}</p>
      </section>
      {batch && <MultiCapture credentials={session.current} connected={connected} onClose={() => setBatch(false)} onSubmitted={count => {
        setBatch(false); setNotice(`已提交 ${count} 张截图。`);
      }} />}
      {answers}<div className="mobile-footer">本次会话最多保留 100 条记录</div>
    </> : <main>
      <aside><Pairing connected={connected} online={online} config={config} base={base} refresh={refreshPair} pair={pair} busy={pairBusy} clear={() => setPair(null)} /></aside>
      <div className="workspace">
        <div className="panel workspace-toolbar">
          <div><h1>提问工作台</h1><p className={`model-indicator ${currentModel?.ready ? 'ready' : ''}`}>{currentModel?.ready ? `${providerNames[config.defaultProvider]} · ${currentModel.model}` : '回答模型待配置'}</p></div>
          <div className="workspace-actions">
            <button className="primary" onClick={() => window.desktop.openAnswerWindow().catch(e => setError(e.message))}>打开答案小窗</button>
            <button className="secondary" onClick={() => setSettings('voice')}>软件设置</button>
          </div>
        </div>
        <div className="input-grid">
          <section className="panel screenshot-panel">
            <div className="section-title"><h2>截图提问</h2><span className="muted">Home 收起主窗</span></div>
            <div className="screenshot-actions">{['full', 'region'].map(kind => <button key={kind} className="capture-button" disabled={!connected} onClick={() => {
              if (!visionReady) setSettings('model');
              else void window.desktop.capture(kind).catch(e => setError(e.message));
            }}><span>{kind === 'full' ? '▣ 全屏截图' : '⌗ 框选截图'}</span><kbd>{info?.shortcuts[kind]?.replace('CommandOrControl', 'Ctrl') || '—'}</kbd>
              {info?.status[kind] === false && <small className="error-inline">快捷键未注册，可点击截图</small>}
            </button>)}</div>
            {!visionReady && connected && <p className="hint setup-tip">首次截图前，请配置支持图片的模型。</p>}
          </section>
          <section className="panel composer">
            <h2>文字提问</h2>
            <textarea aria-label="输入问题" placeholder="输入你想问的问题…" value={question} onChange={event => setQuestion(event.target.value)} maxLength={10000} />
            <div><span>{online && '答案将同步到手机'}</span><button className="primary"
              disabled={!connected || busy || (currentModel?.ready && !question.trim())}
              onClick={() => currentModel?.ready ? runTask('tasks', { question }) : setSettings('model')}>
              {currentModel?.ready ? '发送问题 ↗' : '配置回答模型'}
            </button></div>
          </section>
        </div>
        <div className="section-title history-title"><h2>本次会话</h2><span className="muted">{tasks.length} 个问题</span></div>
        {answers}
      </div>
    </main>}
    {settings && <Settings initialSection={settings} onClose={() => setSettings(null)} onSaved={async () => {
      setConfig(await request('/api/config')); setNotice('设置已保存');
    }} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
