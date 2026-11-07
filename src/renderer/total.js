// Total usage panel: all local ledgers merged into one daily series.
'use strict';

const DAY = 86400000;
const COLS = 52, ROWS = 7;

// Absolute buckets — the scale stays honest as the totals move.
const LEVELS = [
  [0, ''],            // 0
  [1, 'l1'],          // > 0
  [1e6, 'l2'],        // > 100万
  [1e7, 'l3'],        // > 1000万
  [5e7, 'l4'],        // > 5000万
  [1.5e8, 'l5'],      // > 1.5亿
];
const LEGEND = ['0', '≤100万', '≤1000万', '≤5000万', '≤1.5亿', '>1.5亿'];

function fmt(n) {
  if (!n) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return Math.round(n / 1e4) + '万';
  return n.toLocaleString();
}
function money(c) { return c > 0 ? '$' + c.toFixed(2) : '—'; }
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  return h < 24 ? h + ' 小时前' : Math.floor(h / 24) + ' 天前';
}
function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function level(tokens) {
  let l = '';
  for (const [min, cls] of LEVELS) if (tokens > min - 1 || (min === 0 && tokens === 0)) l = cls;
  return l;
}

function render(data) {
  const all = document.getElementById('allTokens');
  const cost = document.getElementById('allCost');
  const row3 = document.getElementById('row3');
  const table = document.getElementById('byProvider');
  const heat = document.getElementById('heatmap');
  const legend = document.getElementById('legend');
  document.getElementById('updated').textContent = '更新于 ' + ago(data.generatedAt);

  const days = data.days || {};
  const today0 = startOfDay(Date.now());
  const t = (slot) => (days[slot] ? days[slot].t : 0);
  const c = (slot) => (days[slot] ? days[slot].c : 0);
  const sum = (n) => {
    let tk = 0, cs = 0;
    for (let i = 0; i < n; i++) { tk += t(today0 - i * DAY); cs += c(today0 - i * DAY); }
    return [tk, cs];
  };

  all.textContent = fmt(data.tokens);
  cost.textContent = money(data.cost);

  row3.innerHTML = '';
  for (const [label, n] of [['今天', 1], ['7 天', 7], ['31 天', 31]]) {
    const [tk, cs] = sum(n);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<b>${fmt(tk)}</b> <i>${money(cs)}</i><br>${label}`;
    row3.appendChild(cell);
  }

  table.innerHTML = '';
  const rows = Object.values(data.sources || {}).sort((a, b) => b.tokens - a.tokens);
  if (!rows.length) {
    table.innerHTML = '<tr><td class="dim">还没有本地用量记录</td></tr>';
  }
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.name}</td><td class="num">${fmt(s.tokens)}</td><td class="num dim">${money(s.cost)}</td>`;
    table.appendChild(tr);
  }

  // 52 columns × 7 rows, oldest first; today is the last cell of the grid,
  // its column cut short so no future days are drawn.
  heat.innerHTML = '';
  const dow = new Date(today0).getDay(); // 0 = Sunday
  const first = today0 - (dow + (COLS - 1) * ROWS) * DAY;
  for (let col = 0; col < COLS; col++) {
    const el = document.createElement('div');
    el.className = 'col';
    for (let row = 0; row < ROWS; row++) {
      const at = first + (col * ROWS + row) * DAY;
      if (at > today0) break;
      const tk = t(at);
      const cell = document.createElement('div');
      cell.className = 'd ' + level(tk);
      const d = new Date(at);
      cell.title = `${d.getMonth() + 1}月${d.getDate()}日 · ${tk ? fmt(tk) + ' tokens' : '无记录'}`;
      el.appendChild(cell);
    }
    heat.appendChild(el);
  }

  legend.innerHTML = '少 ';
  LEVELS.forEach(([, cls], i) => {
    const sq = document.createElement('div');
    sq.className = 'd ' + cls;
    legend.appendChild(sq);
    const lb = document.createElement('span');
    lb.textContent = ' ' + LEGEND[i] + ' ';
    legend.appendChild(lb);
  });
  const more = document.createElement('span');
  more.textContent = ' 多';
  legend.appendChild(more);
}

async function load() {
  try {
    const data = await window.pulse.invoke('total:data');
    if (data) render(data);
  } catch { }
}

document.getElementById('refresh').addEventListener('click', () => {
  window.pulse.send('refresh');
  load();
});
window.pulse.on('state', () => load());
load();
