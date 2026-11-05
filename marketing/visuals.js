(() => {
  const tabs = [...document.querySelectorAll('[data-feature]')];
  const panels = [...document.querySelectorAll('[data-panel]')];
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    panels.forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.feature; });
  }));
  const stages = [...document.querySelectorAll('[data-stage]')];
  const details = [...document.querySelectorAll('[data-detail]')];
  stages.forEach((s) => s.addEventListener('click', () => {
    stages.forEach((x) => x.setAttribute('aria-selected', String(x === s)));
    details.forEach((d) => { d.hidden = d.dataset.detail !== s.dataset.stage; });
  }));
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); observer.unobserve(e.target); }
  }, { threshold: 0.08 });
  document.querySelectorAll('.section, .card, .visual-band, .hero-grid').forEach((el) => { el.classList.add('reveal'); observer.observe(el); });
})();
