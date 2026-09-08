/* Jednoduchý spojnicový graf vývoje ceny (inline SVG, bez knihovny).
   Jedna řada → žádná legenda, barva je neutrální accent (zelená/červená by tu dělala
   ze stavové barvy datovou). Směr za období nese textový údaj nad grafem.
   Hover: svislý zaměřovač + bublina s datem a cenou, ovladatelné i klávesnicí. */

const RANGES = [
  { key: '1m', label: '1 měsíc', days: 30 },
  { key: '3m', label: '3 měsíce', days: 90 },
  { key: '1y', label: '1 rok', days: 366 },
];

const fmtDate = t => new Date(t).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' });
const fmtPrice = (n, cur) => n.toLocaleString('cs-CZ', {
  minimumFractionDigits: Math.abs(n) >= 100 ? 0 : 2,
  maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2
}) + ' ' + cur;

function slice(points, days){
  if(!days) return points;
  const from = Date.now() - days * 24 * 3600 * 1000;
  const out = points.filter(p => p.t >= from);
  return out.length >= 2 ? out : points.slice(-2);
}

/**
 * Vykreslí graf do `host`.
 * points: [{t, c}] vzestupně podle času, cena v měně `currency`.
 */
export function renderPriceChart(host, points, currency, opts = {}){
  host.innerHTML = '';
  if(!points || points.length < 2){
    host.innerHTML = '<div class="chart-empty">Pro graf není dost dat.</div>';
    return;
  }

  let rangeKey = opts.range || '3m';

  const head = document.createElement('div');
  head.className = 'chart-head';
  const summary = document.createElement('div');
  summary.className = 'chart-summary';
  const rangeBtns = document.createElement('div');
  rangeBtns.className = 'chart-ranges';
  head.append(summary, rangeBtns);

  const plot = document.createElement('div');
  plot.className = 'chart-plot';

  const note = document.createElement('div');
  note.className = 'chart-note';
  if(opts.note) note.textContent = opts.note;

  host.append(head, plot, note);

  RANGES.forEach(r => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chart-range' + (r.key === rangeKey ? ' on' : '');
    b.textContent = r.label;
    b.addEventListener('click', () => {
      rangeKey = r.key;
      [...rangeBtns.children].forEach(c => c.classList.toggle('on', c === b));
      draw();
    });
    rangeBtns.appendChild(b);
  });

  function draw(){
    const range = RANGES.find(r => r.key === rangeKey) || RANGES[1];
    const data = slice(points, range.days);
    const first = data[0], last = data[data.length - 1];
    const change = last.c - first.c;
    const changePct = first.c ? (change / first.c) * 100 : 0;

    summary.innerHTML = '';
    const val = document.createElement('b');
    val.textContent = fmtPrice(last.c, currency);
    const chg = document.createElement('span');
    chg.className = 'chart-change ' + (change >= 0 ? 'gain' : 'loss');
    chg.textContent = (change >= 0 ? '+' : '') + fmtPrice(change, currency)
      + ' (' + (changePct >= 0 ? '+' : '') + changePct.toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' %)';
    const per = document.createElement('span');
    per.className = 'chart-period';
    per.textContent = 'za ' + range.label.toLowerCase();
    summary.append(val, chg, per);

    // --- geometrie ---
    // viewBox v reálných pixelech šířky kontejneru → žádné nepoměrné škálování,
    // jinak se roztahuje i text popisků a ořezávají se čísla u osy.
    const W = Math.max(320, Math.round(plot.clientWidth || 720));
    const H = 220, padL = 8, padT = 12, padB = 22;
    const maxLabel = fmtPrice(Math.max(...data.map(d => d.c)), currency);
    const minLabel = fmtPrice(Math.min(...data.map(d => d.c)), currency);
    const padR = Math.max(56, Math.round(Math.max(maxLabel.length, minLabel.length) * 6.4) + 10);
    const xs = data.map(p => p.t);
    const ys = data.map(p => p.c);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanY = (maxY - minY) || Math.abs(maxY) || 1;
    const y0 = minY - spanY * 0.08, y1 = maxY + spanY * 0.08;
    const minX = xs[0], maxX = xs[xs.length - 1];
    const X = t => padL + ((t - minX) / ((maxX - minX) || 1)) * (W - padL - padR);
    const Y = c => padT + (1 - (c - y0) / ((y1 - y0) || 1)) * (H - padT - padB);

    const line = data.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.c).toFixed(1)).join(' ');
    const area = line + ` L${X(maxX).toFixed(1)} ${H - padB} L${X(minX).toFixed(1)} ${H - padB} Z`;

    plot.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Vývoj ceny za ${range.label}">
        <line class="chart-axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"></line>
        <path class="chart-area" d="${area}"></path>
        <path class="chart-line" d="${line}"></path>
        <g class="chart-cursor" hidden>
          <line class="chart-crosshair" y1="${padT}" y2="${H - padB}"></line>
          <circle class="chart-dot" r="4"></circle>
        </g>
        <text class="chart-tick end" x="${W - 4}" y="${Y(maxY) + 4}">${maxLabel}</text>
        <text class="chart-tick end" x="${W - 4}" y="${Y(minY) + 4}">${minLabel}</text>
        <text class="chart-tick" x="${padL}" y="${H - 6}">${fmtDate(minX)}</text>
        <text class="chart-tick end" x="${W - padR}" y="${H - 6}">${fmtDate(maxX)}</text>
        <rect class="chart-hit" x="0" y="0" width="${W}" height="${H}"></rect>
      </svg>
      <div class="chart-tip" hidden></div>`;

    const svg = plot.querySelector('svg');
    const cursor = plot.querySelector('.chart-cursor');
    const cross = plot.querySelector('.chart-crosshair');
    const dot = plot.querySelector('.chart-dot');
    const tip = plot.querySelector('.chart-tip');
    const hit = plot.querySelector('.chart-hit');

    function showAt(index){
      const p = data[Math.max(0, Math.min(data.length - 1, index))];
      const px = X(p.t), py = Y(p.c);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      cursor.removeAttribute('hidden');
      // hodnota je hlavní, popisek vedlejší
      tip.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = fmtPrice(p.c, currency);
      const d = document.createElement('span');
      d.textContent = fmtDate(p.t);
      tip.append(b, d);
      tip.removeAttribute('hidden');
      const rect = plot.getBoundingClientRect();
      const left = (px / W) * rect.width;
      tip.style.left = Math.max(4, Math.min(rect.width - 4, left)) + 'px';
      tip.style.top = ((py / H) * rect.height) + 'px';
    }
    function hide(){ cursor.setAttribute('hidden', ''); tip.setAttribute('hidden', ''); }
    function indexFromClientX(clientX){
      const rect = svg.getBoundingClientRect();
      const t = minX + ((clientX - rect.left) / rect.width) * (maxX - minX);
      let best = 0, bestD = Infinity;
      data.forEach((p, i) => { const d = Math.abs(p.t - t); if(d < bestD){ bestD = d; best = i; } });
      return best;
    }

    hit.addEventListener('pointermove', e => showAt(indexFromClientX(e.clientX)));
    hit.addEventListener('pointerleave', hide);
    svg.setAttribute('tabindex', '0');
    let kbIndex = data.length - 1;
    svg.addEventListener('focus', () => showAt(kbIndex));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', e => {
      if(e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      kbIndex = Math.max(0, Math.min(data.length - 1, kbIndex + (e.key === 'ArrowRight' ? 1 : -1)));
      showAt(kbIndex);
    });
  }

  draw();

  // Šířka viewBoxu je v pixelech, takže při změně velikosti okna je potřeba překreslit.
  if(typeof ResizeObserver === 'function'){
    let lastW = plot.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = plot.clientWidth;
      if(Math.abs(w - lastW) > 8){ lastW = w; draw(); }
    });
    ro.observe(plot);
  }
}
