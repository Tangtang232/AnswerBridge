const byId = id => document.getElementById(id);
const historyPanel = byId('history');
const scrollPanel = byId('history-scroll');
const latest = byId('jump-latest');
const cards = new Map();
const statusNames = {
  listening: '正在识别',
  queued: '等待回答',
  generating: '正在回答',
  done: '已完成',
  interrupted: '已中断',
  error: '失败'
};

function atLatest() {
  return scrollPanel.scrollHeight - scrollPanel.scrollTop - scrollPanel.clientHeight < 24;
}

function scrollToLatest() {
  scrollPanel.scrollTop = scrollPanel.scrollHeight;
  latest.hidden = true;
}

function addPart(card, className) {
  const part = document.createElement('div');
  part.className = className;
  card.append(part);
  return part;
}

function renderEntry(entry) {
  let parts = cards.get(entry.id);
  if (!parts) {
    const card = document.createElement('article');
    card.className = 'answer-card';
    parts = {
      card,
      meta: addPart(card, 'answer-meta'),
      question: addPart(card, 'answer-question'),
      answer: addPart(card, 'answer-text'),
      error: addPart(card, 'answer-error')
    };
    cards.set(entry.id, parts);
    historyPanel.append(card);
  }
  const meta = [entry.source, statusNames[entry.status]];
  if (Number.isFinite(entry.firstTextMs)) meta.push('首字 ' + (entry.firstTextMs / 1000).toFixed(2) + ' 秒');
  parts.meta.textContent = meta.filter(Boolean).join(' · ');
  parts.question.textContent = entry.question;
  parts.question.hidden = !entry.question;
  parts.answer.textContent = entry.answer || (entry.status === 'generating' ? '正在准备答案…' : '');
  parts.answer.hidden = !parts.answer.textContent;
  parts.error.textContent = entry.error || '';
  parts.error.hidden = !entry.error;
}

window.answerWindow.onUpdate(update => {
  const follow = atLatest();
  if (update.history) {
    cards.clear();
    historyPanel.replaceChildren();
    update.history.forEach(renderEntry);
  }
  for (const id of update.removed || []) {
    cards.get(id)?.card.remove();
    cards.delete(id);
  }
  if (update.entry) renderEntry(update.entry);
  byId('empty').hidden = cards.size > 0;
  byId('protection').textContent = update.protection
    ? '置顶显示 · 共享保护已开启，请先验证'
    : '置顶显示 · 共享保护已关闭';
  if (follow || update.history) scrollToLatest();
  else latest.hidden = atLatest();
});

const fontSizes = [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
const fontKey = 'answerbridge.popupFontSize';
let sizeIndex = fontSizes.indexOf(16);
try {
  const savedIndex = fontSizes.indexOf(Number(localStorage.getItem(fontKey)));
  if (savedIndex >= 0) sizeIndex = savedIndex;
} catch {}

function applyFontSize() {
  const follow = atLatest();
  const size = fontSizes[sizeIndex];
  historyPanel.style.setProperty('--answer-size', size + 'px');
  byId('font-size').textContent = size;
  byId('font-smaller').disabled = sizeIndex === 0;
  byId('font-larger').disabled = sizeIndex === fontSizes.length - 1;
  try { localStorage.setItem(fontKey, String(size)); } catch {}
  if (follow) scrollToLatest();
}

byId('font-smaller').addEventListener('click', () => { sizeIndex--; applyFontSize(); });
byId('font-larger').addEventListener('click', () => { sizeIndex++; applyFontSize(); });
byId('opacity').addEventListener('input', event => window.answerWindow.setOpacity(Number(event.target.value) / 100));
latest.addEventListener('click', scrollToLatest);
scrollPanel.addEventListener('scroll', () => { latest.hidden = atLatest(); });
applyFontSize();
