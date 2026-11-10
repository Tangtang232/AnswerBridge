let start = null, rect = null;
window.selection.info().then(({ image }) => { document.querySelector('#screen').src = image; });
document.addEventListener('pointerdown', event => {
  if (event.button !== 0) return; start = { x: event.clientX, y: event.clientY };
  document.querySelector('#shade').style.display = 'none'; event.target.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!start) return;
  const x = Math.min(innerWidth, Math.max(0, event.clientX)), y = Math.min(innerHeight, Math.max(0, event.clientY));
  rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  Object.assign(document.querySelector('#rect').style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.querySelector('#size').textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
});
document.addEventListener('pointerup', () => { if (start) { window.selection.finish(rect && rect.width >= 5 && rect.height >= 5 ? rect : null); start = null; } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.selection.finish(null); });
