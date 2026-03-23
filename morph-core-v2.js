/**
 * morph-core v2.0.0
 * Declarative GSAP morph modals via data-* attributes.
 *
 * Features:
 *   - Modal stack (nested modals)
 *   - Callback hooks: onOpen, onClose, onComplete
 *   - External triggers via data-morph-target
 *   - Scroll lock when modal is open
 *   - Resize handling
 *   - Duplicate init guard
 *   - Full destroy / cleanup
 *   - data-close-on-overlay per card
 *   - Accessibility: role, aria-modal, aria-labelledby, focus trap
 *
 * Usage:
 *   import { init, open, close, destroy } from 'morph-core'
 *
 *   init({
 *     gsap,                     // GSAP instance (or uses window.gsap)
 *     onOpen:     (modal) => {},
 *     onClose:    (modal) => {},
 *     onComplete: (modal) => {}, // fires when open animation finishes
 *   })
 *
 * HTML:
 *   <div id="mo"></div>
 *
 *   <div class="modal"
 *        data-estado="cerrado"
 *        data-w="400"
 *        data-h="360"
 *        data-pos="center"
 *        data-dur="0.55"
 *        data-ease="expo.out"
 *        data-close-on-overlay="true">
 *
 *     <p>Trigger label</p>
 *
 *     <div class="modal-content">
 *       <h2 id="modal-title">Title</h2>
 *       ...
 *       <button data-close>Close</button>
 *     </div>
 *   </div>
 *
 *   <!-- external trigger (anywhere in the page) -->
 *   <button data-morph-target="my-modal-id">Open modal</button>
 *   <div id="my-modal" class="modal" ...>...</div>
 *
 * Required CSS:
 *   .modal[data-estado="abierto"] { visibility: hidden; opacity: 0; }
 *   .modal-content                { display: none; }
 *   .morph-clone                  { position: fixed; overflow: hidden; z-index: 100; }
 */

// ─────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────
const DEFAULTS = {
  // size
  w:              360,       // modal width  (px)
  h:              300,       // modal height (px)

  // position
  // Named:  'center' | 'top' | 'bottom' | 'left' | 'right'
  //         'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  //         'origin'  (next to card)
  // Exact:  data-pos-x / data-pos-y in px or %  (overrides pos)
  pos:            'center',

  // animation
  dur:            0.55,      // open duration (s). close = dur * 0.85
  ease:           'expo.out',

  // behaviour
  closeOnOverlay: false,     // close when clicking overlay
  pad:            12,        // min gap to viewport edges (px)
};

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let _gsap      = null;
let _callbacks = { onOpen: null, onClose: null, onComplete: null };
let _initiated = false;
let _listeners = [];   // for destroy()

// Modal stack: array of { modal, clone, opts, rect, prevFocus }
const stack = [];

// Scroll lock state
let _scrollY      = 0;
let _scrollLocked = false;

// Resize debounce
let _resizeTimer = null;

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
// Read a data-attr from the element.
// Supports both camelCase (dataset.posX) and kebab-case keys.
function opt(m, k) {
  // direct key first (camelCase from dataset)
  if (m.dataset[k] !== undefined) return m.dataset[k];
  // convert kebab to camelCase
  const camel = k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  if (m.dataset[camel] !== undefined) return m.dataset[camel];
  // fall back to defaults (try camelCase then raw key)
  return DEFAULTS[camel] !== undefined ? DEFAULTS[camel]
       : DEFAULTS[k]     !== undefined ? DEFAULTS[k]
       : undefined;
}

// Parse a px-or-percent value against a total dimension.
// "50%"  → total * 0.5
// "200"  → 200
// 200    → 200
function parseUnit(val, total) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (s.endsWith('%')) return (parseFloat(s) / 100) * total;
  return parseFloat(s);
}

// Clamp a value so the modal stays within viewport.
function clamp(val, min, max) { return Math.max(min, Math.min(val, max)); }

function calcPos(r, w, h, m) {
  const pad = +opt(m, 'pad');
  const vw  = window.innerWidth;
  const vh  = window.innerHeight;

  // ── Exact coordinates override everything ──
  // data-pos-x / data-pos-y  (px or %)
  const rawX = m.dataset.posX ?? m.dataset['pos-x'];
  const rawY = m.dataset.posY ?? m.dataset['pos-y'];

  if (rawX !== undefined || rawY !== undefined) {
    const left = rawX !== undefined ? clamp(parseUnit(rawX, vw), pad, vw - w - pad)
                                    : clamp((vw - w) / 2, pad, vw - w - pad);
    const top  = rawY !== undefined ? clamp(parseUnit(rawY, vh), pad, vh - h - pad)
                                    : clamp((vh - h) / 2, pad, vh - h - pad);
    return { top, left };
  }

  const pos    = opt(m, 'pos');
  // Stack offset so nested modals don't fully overlap
  const offset = stack.length * 16;

  // Helpers for edge-aligned positions
  const cx = clamp((vw - w) / 2 + offset, pad, vw - w - pad);
  const cy = clamp((vh - h) / 2 - offset, pad, vh - h - pad);
  const T  = pad;
  const B  = vh - h - pad;
  const L  = pad;
  const R  = vw - w - pad;

  switch (pos) {
    // ── cardinal ──
    case 'top':          return { top: T,  left: cx };
    case 'bottom':       return { top: B,  left: cx };
    case 'left':         return { top: cy, left: L  };
    case 'right':        return { top: cy, left: R  };

    // ── corners ──
    case 'top-left':     return { top: T, left: L };
    case 'top-right':    return { top: T, left: R };
    case 'bottom-left':  return { top: B, left: L };
    case 'bottom-right': return { top: B, left: R };

    // ── origin: open next to the card ──
    case 'origin': {
      // Prefer opening to the right of the card; fall back to left
      let left = r.left + r.width + 8;
      if (left + w > vw - pad) left = r.left - w - 8;
      left = clamp(left, pad, vw - w - pad);

      // Prefer aligning tops; fall back to bottom-aligned
      let top = r.top;
      if (top + h > vh - pad) top = clamp(r.bottom - h, pad, vh - h - pad);
      return { top, left };
    }

    // ── origin-below: drops down from card (like a dropdown) ──
    case 'origin-below': {
      const left = clamp(r.left, pad, vw - w - pad);
      let   top  = r.bottom + 6;
      if (top + h > vh - pad) top = r.top - h - 6;
      return { top: clamp(top, pad, vh - h - pad), left };
    }

    // ── origin-above ──
    case 'origin-above': {
      const left = clamp(r.left, pad, vw - w - pad);
      const top  = clamp(r.top - h - 6, pad, vh - h - pad);
      return { top, left };
    }

    // ── center (default) ──
    default:
      return { top: cy, left: cx };
  }
}

// ─────────────────────────────────────────
// SCROLL LOCK
// ─────────────────────────────────────────
// Store body styles before locking so we restore exactly
let _bodyStylesBackup = {};

function lockScroll() {
  if (_scrollLocked) return;
  _scrollY = window.scrollY;

  // Backup current inline styles
  _bodyStylesBackup = {
    overflow: document.body.style.overflow,
    position: document.body.style.position,
    top:      document.body.style.top,
    left:     document.body.style.left,
    right:    document.body.style.right,
    width:    document.body.style.width,
  };

  // Apply lock — use scrollbar width compensation to avoid layout shift
  const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top      = `-${_scrollY}px`;
  document.body.style.left     = '0';
  document.body.style.right    = '0';
  if (scrollbarW > 0) document.body.style.paddingRight = scrollbarW + 'px';

  _scrollLocked = true;
}

function unlockScroll() {
  if (!_scrollLocked) return;

  // Restore exactly what was there before
  document.body.style.overflow     = _bodyStylesBackup.overflow || '';
  document.body.style.position     = _bodyStylesBackup.position || '';
  document.body.style.top          = _bodyStylesBackup.top      || '';
  document.body.style.left         = _bodyStylesBackup.left     || '';
  document.body.style.right        = _bodyStylesBackup.right    || '';
  document.body.style.width        = _bodyStylesBackup.width    || '';
  document.body.style.paddingRight = '';

  window.scrollTo({ top: _scrollY, behavior: 'instant' });
  _scrollLocked = false;
}

// ─────────────────────────────────────────
// FOCUS TRAP
// ─────────────────────────────────────────
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[data-close]',
].join(', ');

function trapFocus(container, e) {
  const els   = [...container.querySelectorAll(FOCUSABLE)].filter(el => !el.closest('[hidden]'));
  const first = els[0];
  const last  = els[els.length - 1];

  if (!els.length) { e.preventDefault(); return; }

  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

// ─────────────────────────────────────────
// OVERLAY
// ─────────────────────────────────────────
function getOverlay() {
  return document.getElementById('mo');
}

// ─────────────────────────────────────────
// OPEN
// ─────────────────────────────────────────
function open(m) {
  if (typeof m === 'string') {
    m = document.getElementById(m) || document.querySelector(m);
  }
  if (!m) return;

  // Already in stack — don't reopen
  if (stack.some(e => e.modal === m)) return;

  // Snapshot styles BEFORE hiding
  const cs = getComputedStyle(m);
  const bg = cs.backgroundColor;
  const br = cs.borderRadius;
  const bs = cs.boxShadow;

  // Save focused element to restore later
  const prevFocus = document.activeElement;

  m.dataset.estado = 'abierto';
  // Hide original card with inline styles so layout space is preserved
  // but the card doesn't show through/under the travelling clone
  m.style.visibility = 'hidden';
  m.style.opacity    = '0';

  const r   = m.getBoundingClientRect();
  const w   = +opt(m, 'w');
  const h   = +opt(m, 'h');
  const pos =  opt(m, 'pos');
  const dur = +opt(m, 'dur');
  const ease=  opt(m, 'ease');
  const closeOnOverlay = opt(m, 'closeOnOverlay') === 'true' || opt(m, 'closeOnOverlay') === true;

  const dest = calcPos(r, w, h, m);
  const z    = 100 + stack.length * 2;

  const pageBg = getComputedStyle(document.body).backgroundColor || '#ffffff';

  // ── Build clone ──
  const clone = document.createElement('div');
  clone.className = 'morph-clone';

  // Accessibility
  clone.setAttribute('role', 'dialog');
  clone.setAttribute('aria-modal', 'true');

  Object.assign(clone.style, {
    top:          r.top    + 'px',
    left:         r.left   + 'px',
    width:        r.width  + 'px',
    height:       r.height + 'px',
    borderRadius: br,
    background:   bg,
    boxShadow:    bs,
    zIndex:       z,
    pointerEvents: 'all',
  });

  clone.addEventListener('pointerdown', e => e.stopPropagation());
  document.body.appendChild(clone);

  // ── Clone content ──
  const ct = m.querySelector('.modal-content').cloneNode(true);
  ct.style.cssText += ';display:flex;flex-direction:column;opacity:0;height:100%;box-sizing:border-box;overflow-y:auto;';
  clone.appendChild(ct);

  // aria-labelledby: first h1/h2/h3 inside content
  const heading = ct.querySelector('h1, h2, h3');
  if (heading) {
    if (!heading.id) heading.id = `mc-title-${Date.now()}`;
    clone.setAttribute('aria-labelledby', heading.id);
  }

  // ── data-close buttons ──
  ct.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('pointerdown', e => { e.stopPropagation(); close(); });
  });

  // ── data-morph-target buttons inside content (nested modals) ──
  ct.querySelectorAll('[data-morph-target]').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      open(document.getElementById(btn.dataset.morphTarget));
    });
  });

  // ── Focus trap ──
  const trapHandler = e => {
    if (e.key === 'Tab') trapFocus(clone, e);
  };
  clone.addEventListener('keydown', trapHandler);

  // ── Push to stack ──
  const entry = {
    modal: m,
    clone,
    opts: { w, h, dur, ease, br, bs, closeOnOverlay },
    rect: { top: r.top, left: r.left, w: r.width, h: r.height },
    prevFocus,
    trapHandler,
  };
  stack.push(entry);

  // ── Scroll lock (only on first modal) ──
  if (stack.length === 1) lockScroll();

  // ── Overlay: kept for data-close-on-overlay clicks but invisible ──
  const mo = getOverlay();
  if (mo) {
    mo.style.opacity       = '0';
    mo.style.pointerEvents = stack.length === 1 ? 'all' : 'none';
  }

  // ── Morph open ──
  _gsap.to(clone, {
    top:          dest.top,
    left:         dest.left,
    width:        w,
    height:       h,
    borderRadius: '10px',
    background:   pageBg,
    boxShadow:    `0 2px 0 rgba(0,0,0,.1), 0 ${16 + stack.length * 4}px ${48 + stack.length * 8}px rgba(0,0,0,.12)`,
    duration:     dur,
    ease,
  });

  _gsap.to(ct, {
    opacity:  1,
    duration: 0.22,
    delay:    dur * 0.45,
    ease:     'power2.out',
    onComplete() {
      // Focus first focusable element
      const first = clone.querySelector(FOCUSABLE);
      if (first) first.focus();
      // onComplete callback
      _callbacks.onComplete?.(m);
    },
  });

  // onOpen callback
  _callbacks.onOpen?.(m);
}

// ─────────────────────────────────────────
// CLOSE (top of stack)
// ─────────────────────────────────────────
function close() {
  if (!stack.length) return;

  const entry = stack[stack.length - 1];
  if (entry._closing) return;
  entry._closing = true;

  const { modal: m, clone, opts, rect, prevFocus, trapHandler } = entry;

  clone.style.pointerEvents = 'none';
  clone.removeEventListener('keydown', trapHandler);
  _gsap.killTweensOf(clone);

  const bg  = getComputedStyle(m).backgroundColor;
  const dur = opts.dur * 0.85;

  // 1. Fade out modal content quickly
  const ct = clone.querySelector('.modal-content');
  _gsap.to(ct, { opacity: 0, duration: 0.13, ease: 'power1.in' });

  // 2. Morph clone back toward card position
  _gsap.to(clone, {
    top:          rect.top,
    left:         rect.left,
    width:        rect.w,
    height:       rect.h,
    borderRadius: opts.br,
    background:   bg,
    boxShadow:    opts.bs,
    duration:     dur,
    ease:         'expo.inOut',
    onComplete() {
      // 3. Crossfade: show card underneath, fade clone out simultaneously
      //    so there's no hard swap — card fades in as clone fades out
      m.style.visibility = '';
      m.style.opacity    = '0';
      m.dataset.estado   = 'cerrado';

      // Fade card in and clone out together
      _gsap.to(m,     { opacity: 1, duration: 0.18, ease: 'power2.out' });
      _gsap.to(clone, {
        opacity: 0,
        duration: 0.18,
        ease: 'power2.in',
        onComplete() {
          clone.remove();
          stack.pop();

          // Restore focus
          if (prevFocus && typeof prevFocus.focus === 'function') {
            prevFocus.focus();
          }

          // Unlock scroll only when all modals are closed
          if (stack.length === 0) {
            unlockScroll();

            const mo = getOverlay();
            if (mo) mo.style.pointerEvents = 'none';
          }

          // onClose callback
          _callbacks.onClose?.(m);
        },
      });
    },
  });
}

// Close all modals in stack
function closeAll() {
  // Close from top to bottom without animation on intermediates
  while (stack.length > 1) {
    const { modal: m, clone } = stack.pop();
    clone.remove();
    m.style.visibility = '';
    m.style.opacity    = '';
    m.dataset.estado   = 'cerrado';
  }
  if (stack.length === 1) close();
}

// ─────────────────────────────────────────
// RESIZE HANDLING
// ─────────────────────────────────────────
function onResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    stack.forEach(entry => {
      // Recalculate card rect (it may have moved after reflow)
      const r = entry.modal.getBoundingClientRect();
      entry.rect = { top: r.top, left: r.left, w: r.width, h: r.height };

      // Reposition open clone to stay centered
      const { w, h } = entry.opts;
      const dest = calcPos(r, w, h, entry.modal);

      _gsap.to(entry.clone, {
        top:      dest.top,
        left:     dest.left,
        duration: 0.3,
        ease:     'power2.out',
      });
    });
  }, 120);
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
function init(options = {}) {
  // Guard against double init
  if (_initiated) {
    console.warn('[morph-core] init() called more than once. Skipping.');
    return;
  }

  _gsap = options.gsap || window.gsap;
  if (!_gsap) {
    throw new Error(
      '[morph-core] GSAP not found. ' +
      'Load it globally or pass it: init({ gsap })'
    );
  }

  // Callbacks
  _callbacks.onOpen     = options.onOpen     || null;
  _callbacks.onClose    = options.onClose    || null;
  _callbacks.onComplete = options.onComplete || null;

  // ── Wire up triggers ──

  // 1. Direct <p> child triggers
  function handleCardTrigger(e) {
    open(e.currentTarget.closest('.modal'));
  }

  document.querySelectorAll('.modal > p').forEach(p => {
    p.addEventListener('pointerdown', handleCardTrigger);
    _listeners.push({ el: p, event: 'pointerdown', fn: handleCardTrigger });
  });

  // 2. External triggers: <button data-morph-target="id">
  function handleExternalTrigger(e) {
    open(document.getElementById(e.currentTarget.dataset.morphTarget));
  }

  document.querySelectorAll('[data-morph-target]').forEach(btn => {
    // Only wire external triggers (not inside modal-content — those are handled at open time)
    if (!btn.closest('.modal-content')) {
      btn.addEventListener('pointerdown', handleExternalTrigger);
      _listeners.push({ el: btn, event: 'pointerdown', fn: handleExternalTrigger });
    }
  });

  // 3. ESC key
  function handleKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', handleKey);
  _listeners.push({ el: document, event: 'keydown', fn: handleKey });

  // 4. Overlay click (respects data-close-on-overlay per modal)
  const mo = getOverlay();
  if (mo) {
    function handleOverlay(e) {
      if (e.target !== mo) return;
      const top = stack[stack.length - 1];
      if (top && top.opts.closeOnOverlay) close();
    }
    mo.addEventListener('pointerdown', handleOverlay);
    _listeners.push({ el: mo, event: 'pointerdown', fn: handleOverlay });
  }

  // 5. Resize
  window.addEventListener('resize', onResize);
  _listeners.push({ el: window, event: 'resize', fn: onResize });

  _initiated = true;
}

// ─────────────────────────────────────────
// DESTROY
// ─────────────────────────────────────────
function destroy() {
  // Close all open modals instantly
  stack.forEach(({ modal: m, clone }) => {
    clone.remove();
    m.style.visibility = '';
    m.style.opacity    = '';
    m.dataset.estado   = 'cerrado';
  });
  stack.length = 0;

  unlockScroll();

  const mo = getOverlay();
  if (mo) {
    mo.style.opacity       = '0';
    mo.style.pointerEvents = 'none';
  }

  // Remove all listeners
  _listeners.forEach(({ el, event, fn }) => {
    el.removeEventListener(event, fn);
  });
  _listeners.length = 0;

  _callbacks  = { onOpen: null, onClose: null, onComplete: null };
  _initiated  = false;
  _gsap       = null;

  clearTimeout(_resizeTimer);
}

export { init, open, close, closeAll, destroy };
