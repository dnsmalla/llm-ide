(() => {
  const KEY = 'llmide.guide.v1';
  const guide = document.getElementById('guide-body');
  if (guide) {
    const boxes = [...guide.querySelectorAll('input[data-step]')];
    const bar = document.getElementById('done-bar');
    const count = document.getElementById('done-count');
    const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
    for (const b of boxes) if (saved[b.dataset.step]) b.checked = true;
    const render = () => {
      const done = boxes.filter((b) => b.checked).length;
      if (bar) bar.style.width = `${(done / boxes.length) * 100}%`;
      if (count) count.textContent = `${done} of ${boxes.length} complete`;
    };
    const save = () => {
      try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(boxes.map((b) => [b.dataset.step, b.checked])))); } catch { /* private mode */ }
      render();
    };
    boxes.forEach((b) => b.addEventListener('change', save));
    render();
    const reset = () => { boxes.forEach((b) => { b.checked = false; }); save(); };
    document.getElementById('reset-guide')?.addEventListener('click', reset);
    document.getElementById('reset-trouble')?.addEventListener('click', reset);

    const search = document.getElementById('doc-search');
    const links = [...document.querySelectorAll('#doc-links a')];
    search?.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const section of guide.querySelectorAll('.doc-section')) {
        const hit = !q || section.textContent.toLowerCase().includes(q);
        section.hidden = !hit;
        const link = links.find((a) => a.getAttribute('href') === `#${section.id}`);
        if (link) link.parentElement.hidden = !hit;
      }
    });

    const byId = new Map(links.map((a) => [a.getAttribute('href')?.slice(1), a]));
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        links.forEach((a) => a.classList.remove('active'));
        byId.get(e.target.id)?.classList.add('active');
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    guide.querySelectorAll('.doc-section').forEach((s) => observer.observe(s));
    links.forEach((a) => a.addEventListener('click', (event) => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) { event.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', a.getAttribute('href')); }
    }));
  }

  const tour = document.getElementById('tour');
  if (tour) {
    const steps = [...tour.querySelectorAll('[data-tour-step]')];
    const dots = document.getElementById('tour-progress');
    const next = document.getElementById('tour-next');
    const back = document.getElementById('tour-back');
    const label = document.getElementById('tour-label');
    let index = 0;
    const show = (i) => {
      index = Math.max(0, Math.min(steps.length - 1, i));
      steps.forEach((s, n) => { s.hidden = n !== index; });
      dots.replaceChildren(...steps.map((_, n) => { const d = document.createElement('i'); if (n <= index) d.className = 'on'; return d; }));
      back.disabled = index === 0;
      next.textContent = index === steps.length - 1 ? 'Get started' : 'Next';
      label.textContent = `Step ${index + 1} of ${steps.length}`;
      history.replaceState(null, '', `#step-${index + 1}`);
    };
    next.addEventListener('click', () => {
      if (index === steps.length - 1) location.href = 'guide.html';
      else show(index + 1);
    });
    back.addEventListener('click', () => show(index - 1));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') show(index + 1);
      if (e.key === 'ArrowLeft') show(index - 1);
    });
    const hash = Number((location.hash.match(/step-(\d+)/) || [])[1]);
    show(Number.isFinite(hash) && hash > 0 ? hash - 1 : 0);
  }
})();
