// The detail card: one account's limits, reset times, plan and provenance.
// Reports its own height to the main process, which sizes the window —
// content first, frame second.
'use strict';

const UM = window.UsageModel;
const I18N = window.I18N;
const T = I18N.t;

const card = document.getElementById('card');
const tail = document.getElementById('tail');
const rows = document.getElementById('rows');
const hicon = document.getElementById('hicon');
const htitle = document.getElementById('htitle');
const hplan = document.getElementById('hplan');
const hupdated = document.getElementById('hupdated');
const hfoot = document.getElementById('hfoot');

let snapshot = null;
let accountId = null;
let ringScreenY = null;
let dock = 'right';
let axis = 'vertical';

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return T('justNow');
  if (s < 3600) return Math.floor(s / 60) + ' ' + T('minutesAgo');
  if (s < 86400) return Math.floor(s / 3600) + ' ' + T('hoursAgo');
  return Math.floor(s / 86400) + ' ' + T('daysAgo');
}

function fmtReset(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (sameDay) return hm;
  if (tomorrow) return '明天 ' + hm;
  return `${md} ${hm}`;
}

function windowName(w) {
  const k = UM.windowKind(w);
  switch (k.name) {
    case 'fiveHour': return T('win_fiveHour');
    case 'weekly': return T('win_weekly');
    case 'monthly': return T('win_monthly');
    case 'daily': return T('win_daily');
    case 'spend': return T('win_spend');
    case 'balance': return T('win_balance');
    case 'messages': return T('win_messages');
    case 'topUp': return T('win_topUp');
    case 'credits': return T('win_credits');
    case 'sharedCredits': return T('win_sharedCredits');
    case 'planCredits': return T('win_planCredits');
    case 'dedicatedCredits': return T('win_dedicatedCredits');
    case 'other': {
      const s = k.seconds;
      if (s >= 86400) return T('win_other_d').replace('{d}', Math.round(s / 86400));
      if (s >= 3600) return T('win_other_h').replace('{h}', Math.round(s / 3600));
      return T('win_other_m').replace('{m}', Math.round(s / 60));
    }
    default: return k.name;
  }
}

function render() {
  if (!snapshot || !accountId) return;
  const meta = (snapshot.providers || []).find((p) => p.id === accountId);
  const usage = (snapshot.state.readings || {})[accountId];
  const warn = snapshot.state.warningThreshold;

  hicon.innerHTML = (snapshot.icons || {})[accountId] || '';
  htitle.textContent = meta ? meta.name + ' · ' + T('usage') : accountId;
  hplan.textContent = (usage && usage.plan) || '';

  rows.innerHTML = '';
  hfoot.textContent = '';

  if (!usage || usage.state === 'unavailable') {
    hupdated.textContent = '';
    const div = document.createElement('div');
    div.className = 'reason';
    div.textContent = T('r_' + (usage && usage.reason) || '') || T('r_unreachable');
    rows.appendChild(div);
    const cta = document.createElement('div');
    cta.className = 'cta';
    cta.textContent = T('openSettings');
    cta.onclick = () => window.pulse.send('settings:open');
    rows.appendChild(cta);
  } else {
    hupdated.textContent = `${T('updated')} ${ago(usage.observedAt)}${usage.state === 'stale' ? ' · ' + T('r_statuslineCaptured') : ''}`;

    for (const w of usage.windows || []) {
      const tint = UM.tint(w, warn);
      const color = UM.TINT_COLOR[w.isExhausted ? 'spent' : tint];
      const pct = Math.round(w.usedFraction * 100);

      const div = document.createElement('div');
      div.className = 'limit';
      div.innerHTML = `
        <div class="name"><span>${windowName(w)}</span>${w.scope ? `<span class="scope">${escapeHtml(w.scope)}</span>` : ''}</div>
        <div class="bar"><div class="fill" style="width:${w.isExhausted ? 100 : pct}%;background:${color}"></div></div>
        <div class="row">
          <span class="used" style="color:${w.isExhausted ? UM.TINT_COLOR.spent : '#fff'}">${pct}% ${T('used')}${w.isExhausted ? ' · ' + T('win_spend') : ''}${w.amount ? ' · ' + escapeHtml(w.amount) : ''}</span>
          <span class="reset">${w.resetsAt ? T('resets') + ' ' + fmtReset(w.resetsAt) : ''}</span>
        </div>`;
      if (w.estimate) {
        const est = document.createElement('div');
        est.className = 'est';
        est.textContent = T('estimated') + ' · ' + T(w.estimate === 'sinceTopUp' ? 'sinceTopUp' : w.estimate === 'yourBudget' ? 'yourBudget' : 'estimated');
        div.appendChild(est);
      }
      rows.appendChild(div);
    }

    if (usage.creditBalance) {
      const br = document.createElement('div');
      br.className = 'balance-row';
      br.innerHTML = `<span class="k">${T('balance')}</span><span class="v">${escapeHtml(String(usage.creditBalance))}</span>`;
      rows.appendChild(br);
    }
  }

  if (usage && usage.ledger) renderLedger(usage.ledger);

  // Size goes up first, the frame follows. offsetHeight forces a synchronous
  // layout — rAF would never fire while the window is still hidden.
  window.pulse.send('card:size', card.offsetHeight + 2);
}

// "本机用量" — the provider's history as this machine's own records kept it;
// a console-reported history (ledger.note 'server') carries the provider's
// own billed money, not an estimate at API prices.
function renderLedger(ledger) {
  const sec = document.createElement('div');
  sec.className = 'ledger';

  const sym = { CNY: '¥', USD: '$', HKD: 'HK$', TWD: 'NT$', JPY: '¥' }[ledger.currency] || '$';
  const fig = (label, f) => {
    const priced = f.tokens > 0 && f.unpriced < f.tokens;
    const money = f.cost > 0 && priced ? `<div class="lc">${sym}${f.cost.toFixed(2)}</div>` : '';
    return `<div class="lfig"><div class="lk">${label}</div><div class="lv">${shortTokens(f.tokens)}</div>${money}</div>`;
  };

  const peak = Math.max(1, ...(ledger.bars || []));
  const n = (ledger.bars || []).length;
  const bars = (ledger.bars || []).map((t, i) => {
    const h = t > 0 ? Math.max(2, Math.round(t / peak * 24)) : 2;
    const cls = i === n - 1 ? 'on' : (t > 0 ? '' : 'zero');
    return `<i class="${cls}" style="height:${h}px"></i>`;
  }).join('');

  let extra = '';
  if (ledger.topModel) {
    extra += `<div class="lrow"><span>${T('topModel')}</span><span class="rv">${escapeHtml(ledger.topModel.name)} · ${Math.round(ledger.topModel.share * 100)}%</span></div>`;
  }
  if (ledger.cacheHit != null) {
    extra += `<div class="lrow"><span>${T('cacheHit')}</span><span class="rv">${Math.round(ledger.cacheHit * 100)}%</span></div>`;
  }

  sec.innerHTML = `
    <div class="ltitle">${T(ledger.title || 'localUsage')}</div>
    <div class="lfigs">${fig(T('today'), ledger.today)}${fig(T('days7'), ledger.week)}${fig(T('days31'), ledger.month)}</div>
    <div class="lbars">${bars}</div>
    ${extra}
    <div class="lnote">${T(ledger.note === 'server' ? 'costNoteServer' : 'costNote')}</div>`;
  rows.appendChild(sec);
}

// 3.19亿 / 14.8亿 — zh-style compact counts the way the card spells them.
function shortTokens(n) {
  if (!n || n <= 0) return '0';
  // Trims a real fraction only ("13.0"→"13", "5.20"→"5.2") — an integer's
  // trailing zero is a digit, not padding ("1060" stays "1060").
  const trim = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
  if (n >= 1e8) { const v = n / 1e8; return trim(v < 10 ? v.toFixed(2) : v.toFixed(1)) + '亿'; }
  if (n >= 1e4) { const v = n / 1e4; return trim(v < 10 ? v.toFixed(1) : v.toFixed(0)) + '万'; }
  if (n >= 1e3) { const v = n / 1e3; return trim(v < 10 ? v.toFixed(1) : v.toFixed(0)) + 'k'; }
  return String(Math.round(n));
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- ipc ----------

window.pulse.on('card:account', (content) => {
  accountId = content.accountId;
  ringScreenY = content.ringScreenY;
  dock = content.dock;
  axis = content.axis;
  render();
});

window.pulse.on('card:tail', (t) => {
  tail.className = '';
  tail.id = 'tail';
  tail.classList.add(t.side);
  tail.style.left = tail.style.right = tail.style.top = tail.style.bottom = 'auto';
  if (t.side === 'right' || t.side === 'left') {
    tail.style.top = Math.max(10, t.offset - 7) + 'px';
    tail.style[t.side === 'right' ? 'right' : 'left'] = '-6px';
  } else {
    tail.style.left = Math.max(10, t.offset - 7) + 'px';
    tail.style[t.side === 'top' ? 'top' : 'bottom'] = '-6px';
  }
});

window.pulse.on('state', (snap) => { snapshot = snap; if (accountId) render(); });
window.pulse.invoke('snapshot').then((snap) => { snapshot = snap; });
window.pulse.send('card:ready');
