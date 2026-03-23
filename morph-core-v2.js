const { init, open, close, closeAll, destroy } = (() => {
  const DEFAULTS = {
    w: 360, h: 300, pos: 'center', dur: 0.55, ease: 'expo.out',
    closeOnOverlay: false, pad: 12,
    // Estilo del modal abierto — el usuario sobreescribe con data-*
    bg: '',
    radius: '6px',
    shadow: '',
  };

  let _gsap = null, _callbacks = { onOpen: null, onClose: null, onComplete: null }, _initiated = false, _listeners = [];
  const stack = [];
  let _scrollY = 0, _scrollLocked = false, _resizeTimer = null, _bodyStylesBackup = {};

  function opt(m, k) {
    if (m.dataset[k] !== undefined) return m.dataset[k];
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m.dataset[camel] !== undefined) return m.dataset[camel];
    return DEFAULTS[camel] !== undefined ? DEFAULTS[camel] : DEFAULTS[k] !== undefined ? DEFAULTS[k] : undefined;
  }

  function parseUnit(val, total) {
    if (val === undefined || val === null) return null;
    const s = String(val).trim();
    if (s.endsWith('%')) return (parseFloat(s) / 100) * total;
    return parseFloat(s);
  }

  function clamp(v, mn, mx) { return Math.max(mn, Math.min(v, mx)); }

  function calcPos(r, w, h, m) {
    const pad = +opt(m, 'pad'), vw = window.innerWidth, vh = window.innerHeight;
    const rawX = m.dataset.posX ?? m.dataset['pos-x'];
    const rawY = m.dataset.posY ?? m.dataset['pos-y'];
    if (rawX !== undefined || rawY !== undefined) {
      const left = rawX !== undefined ? clamp(parseUnit(rawX, vw), pad, vw - w - pad) : clamp((vw - w) / 2, pad, vw - w - pad);
      const top = rawY !== undefined ? clamp(parseUnit(rawY, vh), pad, vh - h - pad) : clamp((vh - h) / 2, pad, vh - h - pad);
      return { top, left };
    }
    const pos = opt(m, 'pos'), offset = stack.length * 16;
    const cx = clamp((vw - w) / 2 + offset, pad, vw - w - pad), cy = clamp((vh - h) / 2 - offset, pad, vh - h - pad);
    const T = pad, B = vh - h - pad, L = pad, R = vw - w - pad;
    switch (pos) {
      case 'top': return { top: T, left: cx };
      case 'bottom': return { top: B, left: cx };
      case 'left': return { top: cy, left: L };
      case 'right': return { top: cy, left: R };
      case 'top-left': return { top: T, left: L };
      case 'top-right': return { top: T, left: R };
      case 'bottom-left': return { top: B, left: L };
      case 'bottom-right': return { top: B, left: R };
      case 'origin': {
        let left = r.left + r.width + 8;
        if (left + w > vw - pad) left = r.left - w - 8;
        left = clamp(left, pad, vw - w - pad);
        let top = r.top;
        if (top + h > vh - pad) top = clamp(r.bottom - h, pad, vh - h - pad);
        return { top, left };
      }
      case 'origin-below': {
        const left = clamp(r.left, pad, vw - w - pad);
        let top = r.bottom + 6;
        if (top + h > vh - pad) top = r.top - h - 6;
        return { top: clamp(top, pad, vh - h - pad), left };
      }
      case 'origin-above': {
        const left = clamp(r.left, pad, vw - w - pad);
        return { top: clamp(r.top - h - 6, pad, vh - h - pad), left };
      }
      default: return { top: cy, left: cx };
    }
  }

  function lockScroll() {
    if (_scrollLocked) return;
    _scrollY = window.scrollY;
    _bodyStylesBackup = { overflow: document.body.style.overflow, position: document.body.style.position, top: document.body.style.top, left: document.body.style.left, right: document.body.style.right };
    const sw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${_scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    if (sw > 0) document.body.style.paddingRight = sw + 'px';
    _scrollLocked = true;
  }

  function unlockScroll() {
    if (!_scrollLocked) return;
    document.body.style.overflow = _bodyStylesBackup.overflow || '';
    document.body.style.position = _bodyStylesBackup.position || '';
    document.body.style.top = _bodyStylesBackup.top || '';
    document.body.style.left = _bodyStylesBackup.left || '';
    document.body.style.right = _bodyStylesBackup.right || '';
    document.body.style.paddingRight = '';
    window.scrollTo({ top: _scrollY, behavior: 'instant' });
    _scrollLocked = false;
  }

  const FOCUSABLE = ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[data-close]'].join(', ');

  function trapFocus(container, e) {
    const els = [...container.querySelectorAll(FOCUSABLE)].filter(el => !el.closest('[hidden]'));
    if (!els.length) { e.preventDefault(); return; }
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
    else { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
  }

  function getOverlay() { return document.getElementById('mo'); }

  function open(m) {
    if (typeof m === 'string') m = document.getElementById(m) || document.querySelector(m);
    if (!m) return;
    if (stack.some(e => e.modal === m)) return;

    const cs = getComputedStyle(m), bg = cs.backgroundColor, br = cs.borderRadius, bs = cs.boxShadow;
    const prevFocus = document.activeElement;

    m.dataset.estado = 'abierto';
    m.style.visibility = 'hidden';
    m.style.opacity = '0';

    const r = m.getBoundingClientRect();
    const w = +opt(m, 'w'), h = +opt(m, 'h'), dur = +opt(m, 'dur'), ease = opt(m, 'ease');
    const closeOnOverlay = opt(m, 'closeOnOverlay') === 'true' || opt(m, 'closeOnOverlay') === true;
    const dest = calcPos(r, w, h, m);
    const z = 100 + stack.length * 2;

    // Opciones visuales del modal abierto — todas opcionales, el usuario las define con data-*
    const openBg     = opt(m, 'bg')     || '';   // data-bg="#1a1a2e"
    const openRadius = opt(m, 'radius') || '6px'; // data-radius="16px"
    const openShadow = opt(m, 'shadow') || `0 1px 0 rgba(0,0,0,.15), 0 ${16 + stack.length * 4}px ${48 + stack.length * 8}px rgba(0,0,0,.4)`; // data-shadow="..."

    const clone = document.createElement('div');
    clone.className = 'morph-clone';
    clone.setAttribute('role', 'dialog');
    clone.setAttribute('aria-modal', 'true');
    Object.assign(clone.style, {
      top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px',
      borderRadius: br, background: bg, boxShadow: bs,
      zIndex: z, pointerEvents: 'all'
    });
    clone.addEventListener('pointerdown', e => e.stopPropagation());
    document.body.appendChild(clone);

    const ct = m.querySelector('.modal-content').cloneNode(true);
    Object.assign(ct.style, { display: 'flex', flexDirection: 'column', opacity: '0', height: '100%', boxSizing: 'border-box', overflowY: 'auto' });
    clone.appendChild(ct);

    const heading = ct.querySelector('h1,h2,h3,.mc-title');
    if (heading) { if (!heading.id) heading.id = `mc-t-${Date.now()}`; clone.setAttribute('aria-labelledby', heading.id); }

    ct.querySelectorAll('[data-close]').forEach(el => el.addEventListener('pointerdown', e => { e.stopPropagation(); close(); }));
    ct.querySelectorAll('[data-morph-target]').forEach(btn => btn.addEventListener('pointerdown', e => { e.stopPropagation(); open(document.getElementById(btn.dataset.morphTarget)); }));

    const trapHandler = e => { if (e.key === 'Tab') trapFocus(clone, e); };
    clone.addEventListener('keydown', trapHandler);

    const entry = { modal: m, clone, opts: { w, h, dur, ease, br, bs, closeOnOverlay }, rect: { top: r.top, left: r.left, w: r.width, h: r.height }, prevFocus, trapHandler };
    stack.push(entry);
    if (stack.length === 1) lockScroll();

    const mo = getOverlay();
    if (mo) { mo.style.opacity = '0'; mo.style.pointerEvents = stack.length === 1 ? 'all' : 'none'; }

    // Solo anima propiedades que el usuario definió — si no definió bg, no lo toca
    const toProps = { top: dest.top, left: dest.left, width: w, height: h, borderRadius: openRadius, boxShadow: openShadow, duration: dur, ease };
    if (openBg) toProps.background = openBg;

    _gsap.to(clone, toProps);
    _gsap.to(ct, { opacity: 1, duration: 0.22, delay: dur * 0.45, ease: 'power2.out', onComplete() { const first = clone.querySelector(FOCUSABLE); if (first) first.focus(); _callbacks.onComplete?.(m); } });
    _callbacks.onOpen?.(m);
  }

  function close() {
    if (!stack.length) return;
    const entry = stack[stack.length - 1];
    if (entry._closing) return;
    entry._closing = true;
    const { modal: m, clone, opts, rect, prevFocus, trapHandler } = entry;
    clone.style.pointerEvents = 'none';
    clone.removeEventListener('keydown', trapHandler);
    _gsap.killTweensOf(clone);
    const bg = getComputedStyle(m).backgroundColor;
    const dur = opts.dur * 0.85;
    const ct = clone.querySelector('.modal-content');
    _gsap.to(ct, { opacity: 0, duration: 0.13, ease: 'power1.in' });
    _gsap.to(clone, {
      top: rect.top, left: rect.left, width: rect.w, height: rect.h,
      borderRadius: opts.br, background: bg, boxShadow: opts.bs,
      duration: dur, ease: 'expo.inOut',
      onComplete() {
        m.style.visibility = ''; m.style.opacity = '0'; m.dataset.estado = 'cerrado';
        _gsap.to(m, { opacity: 1, duration: 0.18, ease: 'power2.out' });
        _gsap.to(clone, {
          opacity: 0, duration: 0.18, ease: 'power2.in', onComplete() {
            clone.remove(); stack.pop();
            if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
            if (stack.length === 0) { unlockScroll(); const mo = getOverlay(); if (mo) mo.style.pointerEvents = 'none'; }
            _callbacks.onClose?.(m);
          }
        });
      }
    });
  }

  function closeAll() {
    while (stack.length > 1) { const { modal: m, clone } = stack.pop(); clone.remove(); m.style.visibility = ''; m.style.opacity = ''; m.dataset.estado = 'cerrado'; }
    if (stack.length === 1) close();
  }

  function onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      stack.forEach(entry => {
        const r = entry.modal.getBoundingClientRect();
        entry.rect = { top: r.top, left: r.left, w: r.width, h: r.height };
        const { w, h } = entry.opts;
        const dest = calcPos(r, w, h, entry.modal);
        _gsap.to(entry.clone, { top: dest.top, left: dest.left, duration: 0.3, ease: 'power2.out' });
      });
    }, 120);
  }

  function init(options = {}) {
    if (_initiated) { console.warn('[morph-core] init() called more than once.'); return; }
    _gsap = options.gsap || window.gsap;
    if (!_gsap) throw new Error('[morph-core] GSAP not found.');
    _callbacks.onOpen = options.onOpen || null;
    _callbacks.onClose = options.onClose || null;
    _callbacks.onComplete = options.onComplete || null;

    // Todo el .modal es clickeable como trigger
    function hCard(e) { open(e.currentTarget); }
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('pointerdown', hCard);
      _listeners.push({ el: m, event: 'pointerdown', fn: hCard });
    });

    function hExt(e) { open(document.getElementById(e.currentTarget.dataset.morphTarget)); }
    document.querySelectorAll('[data-morph-target]').forEach(btn => {
      if (!btn.closest('.modal-content')) {
        btn.addEventListener('pointerdown', hExt);
        _listeners.push({ el: btn, event: 'pointerdown', fn: hExt });
      }
    });

    function hKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', hKey); _listeners.push({ el: document, event: 'keydown', fn: hKey });

    const mo = getOverlay();
    if (mo) {
      function hOv(e) { if (e.target !== mo) return; const top = stack[stack.length - 1]; if (top && top.opts.closeOnOverlay) close(); }
      mo.addEventListener('pointerdown', hOv); _listeners.push({ el: mo, event: 'pointerdown', fn: hOv });
    }

    window.addEventListener('resize', onResize); _listeners.push({ el: window, event: 'resize', fn: onResize });
    _initiated = true;
  }

  function destroy() {
    stack.forEach(({ modal: m, clone }) => { clone.remove(); m.style.visibility = ''; m.style.opacity = ''; m.dataset.estado = 'cerrado'; });
    stack.length = 0; unlockScroll();
    const mo = getOverlay(); if (mo) { mo.style.opacity = '0'; mo.style.pointerEvents = 'none'; }
    _listeners.forEach(({ el, event, fn }) => el.removeEventListener(event, fn));
    _listeners.length = 0; _callbacks = { onOpen: null, onClose: null, onComplete: null }; _initiated = false; _gsap = null;
    clearTimeout(_resizeTimer);
  }

  return { init, open, close, closeAll, destroy };
})();

init();
window._MC = { open, close, closeAll, destroy };
