(() => {
  const toggle = document.getElementById('product-toggle');
  const menu = document.getElementById('product-menu');
  if (toggle && menu) {
    const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== toggle) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  const progress = document.createElement('div');
  progress.className = 'scroll-progress';
  document.body.append(progress);
  const render = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    progress.style.width = max > 0 ? `${Math.min(100, (h.scrollTop / max) * 100)}%` : '0';
  };
  document.addEventListener('scroll', render, { passive: true });
  render();
})();
