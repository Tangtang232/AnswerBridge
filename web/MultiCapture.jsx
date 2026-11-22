import React, { useRef, useState } from 'react';

export default function MultiCapture({ credentials, connected, onClose, onSubmitted }) {
  const [images, setImages] = useState([]);
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const requestId = useRef(null);

  async function request(action, body) {
    const result = await fetch(`/api/sessions/${credentials.sessionId}/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await result.json();
    if (!result.ok) throw Error(data.error || '请求失败，请重试。');
    return data;
  }

  async function run(action, callback) {
    if (pending.current || !connected) return;
    pending.current = true;
    setStatus(action); setError('');
    try { await callback(); }
    catch (error) { setError(error.message); }
    finally { pending.current = false; setStatus(''); }
  }

  function capture() {
    if (images.length >= 6) return;
    void run('capture', async () => {
      const { image } = await request('capture', { collect: true });
      if (typeof image !== 'string' || !image.startsWith('data:image/')) throw Error('未收到截图，请重试。');
      if (images.reduce((size, item) => size + item.length, image.length) > 24e6) throw Error('截图总大小超过 18 MB，请删除部分截图后重试。');
      setImages(current => [...current, image]);
      requestId.current = null;
    });
  }

  function submit() {
    if (!images.length) return;
    void run('submit', async () => {
      requestId.current ||= `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      await request('image-batch', { images, clientRequestId: requestId.current });
      onSubmitted(images.length);
    });
  }

  return <section className="multi-capture panel" aria-label="多图提问">
    <div className="section-title"><h2>多图提问</h2><span>已截取 {images.length} / 6 张</span></div>
    <p className="hint">在电脑上翻页后继续截图，再一起提交给模型。</p>
    {error && <p role="alert" className="error-inline">{error}</p>}
    <div className="capture-thumbnails">{images.map((image, index) => <figure key={index}>
      <button className="image-preview-button" onClick={() => setPreview(index)} aria-label={`预览第 ${index + 1} 张截图`}><img src={image} alt={`第 ${index + 1} 张截图`} /></button>
      <figcaption><span>第 {index + 1} 张</span><button className="text-button" disabled={Boolean(status)} onClick={() => {
        setImages(current => current.filter((_, i) => i !== index)); setPreview(null); requestId.current = null;
      }}>删除</button></figcaption>
    </figure>)}</div>
    {preview !== null && images[preview] && <div className="capture-preview"><button className="secondary" onClick={() => setPreview(null)}>收起预览</button><img src={images[preview]} alt={`第 ${preview + 1} 张大图`} /></div>}
    <div className="batch-actions">
      <button className="secondary" disabled={Boolean(status) || !connected || images.length >= 6} onClick={capture}>{status === 'capture' ? '正在截图…' : '截取一张'}</button>
      <button className="primary" disabled={Boolean(status) || !connected || !images.length} onClick={submit}>{status === 'submit' ? '正在发送…' : `一起发送（${images.length} 张）`}</button>
    </div>
    <button className="text-button" disabled={Boolean(status)} onClick={() => {
      if (!images.length || window.confirm('取消多图提问并清空已收集的截图？')) onClose();
    }}>取消多图提问</button>
    <p className="hint">刷新或关闭页面会清空未提交截图。单张最多 6 MB，总计最多 18 MB。</p>
  </section>;
}
