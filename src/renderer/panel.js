// The rail renderer: rings, labels, drag, hover, collapse.
// Layout is owned by the main process (windows.js); this file draws what
// 'layout' and 'state' describe and reports pointer facts back.
'use strict';

const UM = window.UsageModel;
const T = window.I18N.t;

const rail = document.getElementById('rail');
const sliver = document.getElementById('sliver');

let snapshot = null;       // 'state' broadcast
let layout = null;         // 'layout' broadcast
let collapsed = false;
let idleTimer = null;
let armedOnce = false;
let drag = null;
let suppressClick = false;

// ---------- render ----------

function ringSVG(window, tintName, busy) {
  const C = 2 * Math.PI * 15.5;
  const f = window ? Math.min(Math.max(window.usedFraction, 0), 1) : 0;
  const spent = window && window.isExhausted;
  const color = UM.TINT_COLOR[spent ? 'spent' : tintName] || UM.TINT_COLOR.green;
  const arc = spent ? C : f * C;
  const track = `<circle cx="20" cy="20" r="15.5" fill="none" stroke="#3a3a3c" stroke-width="4.5" class="track"/>`;
  const prog = `<circle cx="20" cy="20" r="15.5" fill="none" stroke="${color}" stroke-width="4.5"
    stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${(C - arc).toFixed(2)}"
    transform="rotate(-90 20 20)" class="arc"/>`;
  const sweep = busy
    ? `<circle cx="20" cy="20" r="15.5" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="4.5"
        stroke-linecap="round" stroke-dasharray="${(C * 0.18).toFixed(2)} ${(C * 0.82).toFixed(2)}" class="sweep"/>`
    : '';
  return { track, prog, sweep };
}

function render() {
  if (!snapshot || !layout) return;
  const enabled = snapshot.state.enabled || [];
  const readings = snapshot.state.readings || {};
  const busy = new Set(snapshot.state.busy || []);
  const warn = snapshot.state.warningThreshold;

  rail.innerHTML = '';
  for (const id of enabled) {
    const usage = readings[id];
    const meta = (snapshot.providers || []).find((p) => p.id === id);
    const head = usage ? UM.headline(usage) : null;
    const isUnavail = !usage || usage.state === 'unavailable' || (!head && !(usage && usage.creditBalance));
    const isStale = usage && usage.state === 'stale';
    const isBusy = busy.has(id);

    const slot = document.createElement('div');
    slot.className = 'slot' + (isUnavail ? ' unavailable' : '') + (isStale ? ' stale' : '');
    slot.dataset.account = id;

    const tintName = head ? UM.tint(head, warn) : 'none';
    const { track, prog, sweep } = ringSVG(head, tintName, isBusy);
    const icon = (snapshot.icons || {})[id] || '';
    const pct = head ? Math.round(head.usedFraction * 100) : null;
    const balanceOnly = !head && usage && usage.creditBalance;

    slot.innerHTML = `
      <div class="ring">
        <svg viewBox="0 0 40 40">${track}${prog}</svg>
        ${sweep ? `<svg viewBox="0 0 40 40" class="sweep" style="animation:sweep 1s linear infinite">${sweep}</svg>` : ''}
        <div class="icon">${icon}</div>
      </div>
      <div class="pct ${head && head.isExhausted ? 'spent' : tintName}">${isBusy && !head ? '·' :
        pct != null ? pct + '%' :
        balanceOnly ? shortMoney(usage.creditBalance) : '—'}</div>`;

    slot.addEventListener('mouseenter', (e) => {
      cardOpen = true;
      disarmIdle();
      const r = slot.querySelector('.ring').getBoundingClientRect();
      // getBoundingClientRect is window-relative; the card places in screen
      // space, so add this window's own screen origin.
      const cy = window.screenY + r.top + r.height / 2;
      const cx = window.screenX + r.left + r.width / 2;
      // For vertical docks the card aims at the ring's Y; for the top dock, its X.
      window.pulse.send('card:show', id, layout.axis === 'vertical' ? cy : cx);
    });
    slot.addEventListener('click', () => {
      if (suppressClick) return;
      window.pulse.send('provider:refresh', id);
    });
    slot.addEventListener('pointerdown', onPointerDown);
    rail.appendChild(slot);
  }

  document.body.classList.toggle('no-numbers', snapshot.settings && snapshot.settings.showNumbers === false);
}

function shortMoney(text) {
  // A balance in place of a percentage: keep it short on the rail.
  if (!text) return '—';
  const m = String(text).match(/^(.{0,3}?)(\d[\d,.]*)$/);
  if (!m) return String(text).slice(0, 5);
  const n = parseFloat(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return m[1] || '—';
  const short = n >= 1000 ? Math.round(n / 100) / 10 + 'k' : (n % 1 ? n.toFixed(0) : String(n));
  return (m[1] || '') + short;
}

// ---------- drag ----------

function onPointerDown(e) {
  if (e.button !== 0) return;
  drag = { grabDX: e.clientX, grabDY: e.clientY, moved: false };
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    const dx = e.clientX - drag.grabDX, dy = e.clientY - drag.grabDY;
    if (Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    suppressClick = true;
  }
  window.pulse.send('drag:move', e.screenX, e.screenY, drag.grabDX, drag.grabDY);
  resetIdle();
}

function onDragEnd() {
  document.removeEventListener('pointermove', onDragMove);
  window.pulse.send('drag:end');
  setTimeout(() => { suppressClick = false; }, 60);
  drag = null;
}

// ---------- collapse ----------
// Idle means the pointer is gone, not that data is old. The timer arms when
// the pointer leaves the rail (and no card is open) and on first layout —
// the rail announces itself at launch, then steps back to the edge.

let cardOpen = false;

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (collapsed || cardOpen) return;
  idleTimer = setTimeout(() => {
    if (!cardOpen && snapshot && snapshot.settings && snapshot.settings.autoCollapse !== false) {
      window.pulse.send('rail:collapse', true);
    }
  }, 6000);
}

function disarmIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

// Expand only after a short dwell on the sliver. Brushes along the screen
// edge (a maximized app's scrollbar, the corner, a fast pass) enter it too,
// and Windows synthesizes a mouseenter when the window shrinks under a
// parked cursor — none of those are the user asking for the rail.
const EXPAND_DWELL_MS = 250;
let expandTimer = null;
sliver.addEventListener('mouseenter', () => {
  if (expandTimer) clearTimeout(expandTimer);
  expandTimer = setTimeout(() => window.pulse.send('rail:collapse', false), EXPAND_DWELL_MS);
});
sliver.addEventListener('mouseleave', () => {
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
});
rail.addEventListener('mouseenter', disarmIdle);
rail.addEventListener('mouseleave', () => {
  window.pulse.send('card:hideSoon');
  armIdle();
});
rail.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pulse.send('rail:contextmenu', e.screenX, e.screenY);
});

// ---------- ipc ----------

window.pulse.on('layout', (l) => {
  layout = l;
  collapsed = !!l.collapsed;
  const b = document.body;
  b.classList.toggle('collapsed', collapsed);
  b.classList.toggle('vertical', l.axis === 'vertical');
  b.classList.toggle('horizontal', l.axis === 'horizontal');
  b.classList.toggle('dock-right', l.dock === 'right');
  b.classList.toggle('dock-left', l.dock === 'left');
  b.classList.toggle('dock-top', l.dock === 'top');
  sliver.querySelector('.alert').style.background = l.alertTint || 'transparent';
  render();
  if (!armedOnce) { armedOnce = true; armIdle(); }
});

window.pulse.on('card:closed', () => {
  cardOpen = false;
  armIdle();
});

window.pulse.on('state', (snap) => {
  snapshot = snap;
  // Worst-account tint drives the collapsed sliver's alert colour.
  const warn = snap.state.warningThreshold;
  let worst = 'none';
  for (const id of snap.state.enabled || []) {
    const u = (snap.state.readings || {})[id];
    const head = u && UM.headline(u);
    if (!head) continue;
    const t = UM.tint(head, warn);
    if (t === 'spent') { worst = 'spent'; break; }
    if (t === 'red') worst = 'red';
    else if (t === 'amber' && worst === 'none') worst = 'amber';
  }
  const color = worst === 'none' ? null : UM.TINT_COLOR[worst];
  sliver.querySelector('.alert').style.background = color || 'transparent';
  window.pulse.send('sliver:alertTint', color);
  render();
});

window.pulse.send('panel:ready');
