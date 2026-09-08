import { firebaseConfig, POSITIONS_COLLECTION } from './firebase-config.js?v=__CACHEBUST__';
import { fetchAllPrices, convert, fxStatus, fetchPriceHistory, priceDiagnostics, setCustomProxy } from './prices.js?v=__CACHEBUST__';
import { startLivePrice, hasLiveSource } from './live.js?v=__CACHEBUST__';
import { subscribeSettings } from './settings.js?v=__CACHEBUST__';
import { renderPriceChart } from './chart.js?v=__CACHEBUST__';

const TYPE_LABEL = { akcie: 'Akcie / ETF', krypto: 'Kryptoměna', hotovost: 'Hotovost' };
const CUR = ['CZK', 'USD', 'EUR', 'GBP'];

const statusEl = document.getElementById('status');
const statEls = {
  value: document.getElementById('stat-value'),
  invested: document.getElementById('stat-invested'),
  gain: document.getElementById('stat-gain'),
  gainPct: document.getElementById('stat-gainpct'),
};
const tbody = document.getElementById('positions-body');
const emptyEl = document.getElementById('positions-empty');
const historySection = document.getElementById('history-section');
const historyBody = document.getElementById('history-body');
const allocWrap = document.getElementById('alloc-wrap');
const refreshBtn = document.getElementById('refresh-btn');
const lastUpdateEl = document.getElementById('last-update');
const displayCurEl = document.getElementById('display-currency');
const addBtn = document.getElementById('add-btn');
const modal = document.getElementById('position-modal');
const modalTitle = document.getElementById('modal-title');
const form = document.getElementById('position-form');
const fType = document.getElementById('f-type');
const fSymbol = document.getElementById('f-symbol');
const fSymbolHint = document.getElementById('f-symbol-hint');
const fName = document.getElementById('f-name');
const fQty = document.getElementById('f-qty');
const fPrice = document.getElementById('f-price');
const fCurrency = document.getElementById('f-currency');
const fManual = document.getElementById('f-manual');
const fPrimary = document.getElementById('f-primary');
const fTotalHint = document.getElementById('f-total-hint');
const fUrl = document.getElementById('f-url');
const fNote = document.getElementById('f-note');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const closeBtn = document.getElementById('modal-close');

const CUR_SUFFIX = { CZK: ' Kč', EUR: ' €', USD: ' $', GBP: ' £' };
// Velké částky bez haléřů, drobné se dvěma desetinnými místy (jinak by 9,45 € bylo "9 €").
const fmtIn = (n, cur) => {
  if(n == null || isNaN(n)) return '—';
  const dec = Math.abs(n) >= 100 ? 0 : 2;
  return n.toLocaleString('cs-CZ', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    + (CUR_SUFFIX[cur] || ' ' + cur);
};
const fmtMoney = n => fmtIn(n, displayCur); // součty a graf – tam se sčítají různé měny
const signed = (n, cur) => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + fmtIn(n, cur);

/** Hlavní údaj v měně pozice + pod ním přepočet do zvolené měny (jen když se liší). */
function withSecondary(primary, secondaryAmount, posCurrency, isSigned){
  if(secondaryAmount == null || posCurrency === displayCur) return primary;
  const txt = isSigned ? signed(secondaryAmount, displayCur) : fmtIn(secondaryAmount, displayCur);
  return primary + '<span class="sub">' + txt + '</span>';
}
const fmtNum = (n, d = 4) => (n == null || isNaN(n)) ? '—' : n.toLocaleString('cs-CZ', { maximumFractionDigits: d });
const fmtPct = n => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' %';

let positions = [];
let pricesCache = {}; // id -> { priceNative, currency, error }
let computed = {};    // id -> { value, invested, gain, gainPct }
let editingId = null;
let stockApiKey = ''; // sdílený Twelve Data klíč (viz assets/settings.js)
let lastProxy = '';   // sdílená adresa vlastní CORS proxy
let fxWarnEl = null;  // hláška o nedostupných kurzech měn (viz updateFxWarning)
let priceWarnEl = null; // hláška, proč se nepodařilo stáhnout ceny (viz updatePriceWarning)

/* ---------- Zobrazovací měna ----------
   V jaké měně se ukazují hodnoty a součty. Je to jen předvolba zobrazení, takže ji
   držíme v prohlížeči (každý si může přehled zobrazit po svém) – uložené pozice se
   nemění, jen se přepočítávají aktuálním kurzem. */
const DISPLAY_CUR_KEY = 'portfolio-display-currency-v1';
const DISPLAY_CURRENCIES = ['CZK', 'EUR', 'USD'];
let displayCur = 'CZK';
try {
  const saved = localStorage.getItem(DISPLAY_CUR_KEY);
  if(DISPLAY_CURRENCIES.includes(saved)) displayCur = saved;
} catch(e){}

/* ---------- Backend (Firestore realtime, s fallbackem na localStorage) ---------- */
const LOCAL_KEY = 'portfolio-pozice-v1';

function localBackend(){
  let items = [];
  try { items = JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch(e){ items = []; }
  const save = () => localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
  return {
    subscribe(cb){ cb(items); this._cb = cb; },
    add(data){ items.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2,7), ...data }); save(); this._cb(items); },
    update(id, data){ items = items.map(p => p.id === id ? { ...p, ...data } : p); save(); this._cb(items); },
    remove(id){ items = items.filter(p => p.id !== id); save(); this._cb(items); }
  };
}

async function firebaseBackend(){
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy }
    = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const col = collection(db, POSITIONS_COLLECTION);

  return {
    subscribe(cb){
      onSnapshot(query(col, orderBy('ts', 'desc')), snap => {
        cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, err => {
        console.error(err);
        statusEl.innerHTML = '⚠️ Chyba připojení k databázi – zkontroluj pravidla Firestore pro kolekci "' + POSITIONS_COLLECTION + '".';
        statusEl.className = 'statusbar warn';
      });
    },
    add(data){ return addDoc(col, data); },
    update(id, data){ return updateDoc(doc(db, POSITIONS_COLLECTION, id), data); },
    remove(id){ return deleteDoc(doc(db, POSITIONS_COLLECTION, id)); }
  };
}

let backend;
const useFirebase = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey.length > 10;

/* ---------- Výpočty ----------
   Každá hodnota se počítá dvakrát: `*Native` v měně dané pozice (to je to hlavní, co se
   v tabulce ukazuje – souhlasí to s nákupní i aktuální cenou) a bez přípony v aktuálně
   zvolené zobrazovací měně (druhý řádek pod tím a součty nahoře, kde se sčítají různé
   měny dohromady). Když kurz zrovna není k dispozici, nativní hodnoty se zobrazí dál. */
async function toDisplay(amount, from){
  if(amount == null) return null;
  try { return await convert(amount, from, displayCur); } catch(e){ return null; }
}

/* Měna hlavního (horního) údaje řádku. Normálně je to měna pozice, protože v ní je
   i nákupní cena. Pozice ale může mít `primaryCurrency` – pak se všechny její údaje
   přepočítají do ní (bitcoin je koupený za koruny, ale zbytek portfolia je v eurech,
   takže se v tabulce hodí vidět i bitcoin primárně v eurech). Nákupní cena zůstává
   uložená v původní měně, přepočítává se až při zobrazení aktuálním kurzem. */
function nativeCur(p){ return p.primaryCurrency || p.currency; }
async function toNative(amount, p){
  if(amount == null) return null;
  const nc = nativeCur(p);
  if(nc === p.currency) return amount;
  try { return await convert(amount, p.currency, nc); } catch(e){ return null; }
}

async function recompute(){
  computed = {};
  for(const p of positions){
    if(p.type === 'hotovost'){
      const v = await toNative(p.quantity, p);
      computed[p.id] = {
        nativeCur: nativeCur(p),
        valueNative: v, investedNative: v, gainNative: 0, gainPct: 0,
        value: await toDisplay(p.quantity, p.currency), invested: await toDisplay(p.quantity, p.currency), gain: 0
      };
      continue;
    }
    if(p.closed){
      const costNative = p.quantity * p.avgBuyPrice;
      const realizedNative = p.sellPrice != null ? p.quantity * (p.sellPrice - p.avgBuyPrice) : null;
      // Uzavřené (prodané) pozice se nepočítají do aktuální hodnoty ani vloženého kapitálu –
      // jsou to jen historické záznamy s realizovaným ziskem/ztrátou (viz renderHistory).
      computed[p.id] = {
        nativeCur: nativeCur(p),
        value: null, invested: null, gain: null, gainPct: null,
        valueNative: null, investedNative: null, gainNative: null,
        costNative: await toNative(costNative, p), realizedNative: await toNative(realizedNative, p),
        buyNative: await toNative(p.avgBuyPrice, p),
        sellNative: await toNative(p.sellPrice, p),
        cost: await toDisplay(costNative, p.currency),
        realized: await toDisplay(realizedNative, p.currency)
      };
      continue;
    }
    const price = pricesCache[p.id];
    const investedNative = p.quantity * p.avgBuyPrice;
    let valueNative = null, priceInPos = null;
    if(price && price.priceNative != null){
      // Cena chodí v měně burzy (Saab se obchoduje ve SEK, krypto z CoinGecka v CZK),
      // kdežto nákupní cena je v měně pozice – proto se vždy přepočítá.
      try {
        priceInPos = await convert(price.priceNative, price.currency, p.currency);
        valueNative = p.quantity * priceInPos;
      } catch(e){ valueNative = null; priceInPos = null; }
    }
    const gainPct = (valueNative != null && investedNative)
      ? ((valueNative - investedNative) / investedNative) * 100 : null;

    const invested = await toDisplay(investedNative, p.currency);
    const value = await toDisplay(valueNative, p.currency);
    const gain = (value != null && invested != null) ? value - invested : null;

    // Hlavní údaje se ještě přepočítají do zobrazovací měny řádku (viz nativeCur).
    const investedN = await toNative(investedNative, p);
    const valueN = await toNative(valueNative, p);
    const gainN = (valueN != null && investedN != null) ? valueN - investedN : null;
    computed[p.id] = {
      nativeCur: nativeCur(p),
      valueNative: valueN, investedNative: investedN, gainNative: gainN, gainPct,
      value, invested, gain,
      priceInPos: await toNative(priceInPos, p),
      buyNative: await toNative(p.avgBuyPrice, p)
    };
  }
}

function totals(){
  let value = 0, invested = 0, any = false;
  positions.forEach(p => {
    const c = computed[p.id];
    if(c && c.value != null){ value += c.value; any = true; }
    if(c && c.invested != null) invested += c.invested;
  });
  const gain = value - invested;
  const gainPct = invested ? (gain / invested) * 100 : null;
  return { value: any ? value : null, invested, gain: any ? gain : null, gainPct: any ? gainPct : null };
}

/* ---------- Vykreslení ---------- */
function render(){
  const t = totals();
  statEls.value.textContent = fmtMoney(t.value);
  statEls.invested.textContent = fmtMoney(t.invested);
  statEls.gain.textContent = (t.gain == null ? '—' : (t.gain >= 0 ? '+' : '') + fmtMoney(t.gain));
  statEls.gain.className = (t.gain == null ? '' : (t.gain >= 0 ? 'up' : 'down'));
  statEls.gainPct.textContent = fmtPct(t.gainPct);
  statEls.gainPct.className = (t.gainPct == null ? '' : (t.gainPct >= 0 ? 'up' : 'down'));

  renderTable();
  renderHistory();
  renderAlloc(t);
  updateFxWarning();
  updatePriceWarning();
}

// Bez kurzu měn nejde spočítat hodnota nic v cizí měně – neschovávej to do pomlčky,
// ale řekni to nahlas, jinak uživatel netuší, proč je tabulka poloprázdná.
/* Když se u nějaké pozice nepodaří stáhnout živou cenu, ukaž DŮVOD – i když se místo ní
   použije ruční cena. Bez toho vypadá stará ruční cena jako v pořádku a nedá se poznat,
   že zdroj cen nefunguje. */
function updatePriceWarning(){
  if(!priceWarnEl) return;
  const msgs = new Map();
  positions.forEach(p => {
    if(p.closed || p.type === 'hotovost') return;
    const r = pricesCache[p.id];
    const err = r && (r.error || r.staleError);
    if(!err) return;
    if(!msgs.has(err)) msgs.set(err, []);
    msgs.get(err).push(p.symbol);
  });
  if(!msgs.size){ priceWarnEl.innerHTML = ''; return; }
  priceWarnEl.innerHTML = ' · ⚠️ ' + [...msgs.entries()]
    .map(([err, syms]) => escapeHtml(syms.join(', ') + ': ' + err)).join(' · ');
}

function updateFxWarning(){
  if(!fxWarnEl) return;
  const s = fxStatus();
  if(s.ok){
    fxWarnEl.innerHTML = '';
  } else if(s.stale){
    fxWarnEl.innerHTML = ' · ⚠️ Kurzy měn se nepodařilo obnovit – počítám s posledním známým kurzem.';
  } else {
    fxWarnEl.innerHTML = ' · ⚠️ Kurz měn není dostupný, hodnoty v jiných měnách zatím nejdou přepočítat.';
  }
}

function renderTable(){
  tbody.innerHTML = '';
  const openList = positions.filter(p => !p.closed);
  if(!openList.length){
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  openList.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach(p => {
    const isCash = p.type === 'hotovost';
    const price = pricesCache[p.id];
    const c = computed[p.id] || {};
    const cur = c.nativeCur || p.currency; // měna hlavního údaje řádku
    const tr = document.createElement('tr');
    let priceCell;
    if(isCash){
      priceCell = '—';
    } else if(price && price.priceNative != null){
      // Máme cenu → chybu z posledního (neúspěšného) pokusu nekřič, jen naznač stáří.
      let note = '';
      if(price.live) note = 'živě · ' + price.live;
      else if(price.manual) note = 'ručně zadaná' + (price.error ? ' · ' + shortReason(price.error) : '');
      else if(price.staleError && price.cachedAt) note = 'z ' + new Date(price.cachedAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
      else if(price.staleError) note = 'poslední známá';
      // Cena dorazila z jiné burzy téhož titulu (uložený ticker Yahoo nezná).
      if(price.altSymbol) note = (note ? note + ' · ' : '') + 'burza ' + price.altSymbol;
      // Cena se ukazuje v měně pozice, ať se dá porovnat s nákupní cenou; když burza
      // kotuje v jiné měně (Saab ve SEK), je původní kurz pod tím drobným písmem.
      const otherCur = price.currency !== cur && c.priceInPos != null;
      const main = otherCur ? fmtNum(c.priceInPos, 2) + ' ' + cur
                            : fmtNum(price.priceNative, 2) + ' ' + price.currency;
      const sub = [otherCur ? fmtNum(price.priceNative, 2) + ' ' + price.currency : '', note]
        .filter(Boolean).join(' · ');
      priceCell = main + (sub ? '<span class="sub">' + sub + '</span>' : '');
    } else if(price && price.error){
      priceCell = '<span class="pricerr">⚠️ ' + escapeHtml(price.error) + '</span>';
    } else {
      priceCell = '…';
    }
    const buyCell = isCash ? '—'
      : fmtNum(c.buyNative != null ? c.buyNative : p.avgBuyPrice, 2) + ' ' + cur
        + (cur !== p.currency ? '<span class="sub">' + fmtNum(p.avgBuyPrice, 2) + ' ' + p.currency + '</span>' : '');

    // Hlavní údaj v měně pozice, pod ním (jen když se liší) přepočet do zvolené měny.
    const gainClassNative = (c.gainNative == null || isCash) ? '' : (c.gainNative >= 0 ? 'gain' : 'loss');
    const valueCell = withSecondary(fmtIn(c.valueNative, cur),
      c.valueNative == null ? null : c.value, cur);
    const gainCell = (isCash || c.gainNative == null) ? '—'
      : withSecondary(signed(c.gainNative, cur) + ' (' + fmtPct(c.gainPct) + ')',
          c.gain, cur, true);

    const url = isCash ? null : infoUrl(p);
    const nameHtml = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Otevřít detail titulu">${escapeHtml(p.name || p.symbol)} <span class="extlink">↗</span></a>`
      : `<b>${escapeHtml(p.name || p.symbol)}</b>`;

    tr.innerHTML = `
      <td><span class="chip acc">${TYPE_LABEL[p.type] || p.type}</span></td>
      <td><b>${nameHtml}</b>${isCash ? '' : '<span class="sub">' + escapeHtml(p.symbol) + '</span>'}</td>
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${buyCell}</td>
      <td class="num">${priceCell}</td>
      <td class="num">${valueCell}</td>
      <td class="num ${gainClassNative}">${gainCell}</td>
      <td>
        <div class="rowactions">
          ${isCash ? '' : `<button class="iconbtn chart${openCharts.has(p.id) ? ' on' : ''}" title="Graf vývoje ceny">📈</button>`}
          ${isCash ? '' : '<button class="iconbtn sell" title="Označit jako prodané">💰</button>'}
          <button class="iconbtn edit" title="Upravit">✏️</button>
          <button class="iconbtn del" title="Smazat">🗑</button>
        </div>
      </td>`;

    const chartBtn = tr.querySelector('.chart');
    if(chartBtn){
      chartBtn.addEventListener('click', () => {
        if(openCharts.has(p.id)){
          openCharts.delete(p.id);
          chartBtn.classList.remove('on');
          const next = tr.nextElementSibling;
          if(next && next.classList.contains('chartrow')) next.remove();
        } else {
          openCharts.add(p.id);
          chartBtn.classList.add('on');
          tr.after(chartRow(p));
        }
      });
    }
    const sellBtnEl = tr.querySelector('.sell');
    if(sellBtnEl){
      sellBtnEl.addEventListener('click', () => {
        const priceStr = prompt(`Prodejní cena za kus (${p.currency}) pro "${p.name || p.symbol}":`);
        if(priceStr == null) return;
        const sellPrice = parseFloat(priceStr.replace(',', '.'));
        if(isNaN(sellPrice)){ alert('Neplatná cena.'); return; }
        backend.update(p.id, { closed: true, sellPrice, closedAt: Date.now() });
      });
    }
    tr.querySelector('.edit').addEventListener('click', () => openModal(p));
    tr.querySelector('.del').addEventListener('click', () => {
      if(confirm(`Smazat pozici "${p.name || p.symbol}"?`)) backend.remove(p.id);
    });
    tbody.appendChild(tr);
    // Překreslení tabulky (nové ceny, změna měny) nesmí zavřít rozbalený graf.
    if(openCharts.has(p.id)) tbody.appendChild(chartRow(p));
  });
}

function renderHistory(){
  if(!historySection) return;
  const closedList = positions.filter(p => p.closed);
  if(!closedList.length){ historySection.style.display = 'none'; return; }
  historySection.style.display = '';
  historyBody.innerHTML = '';

  closedList.slice().sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).forEach(p => {
    const c = computed[p.id] || {};
    const cur = c.nativeCur || p.currency;
    const tr = document.createElement('tr');
    const gainClass = c.realizedNative == null ? '' : (c.realizedNative >= 0 ? 'gain' : 'loss');
    const realizedCell = c.realizedNative == null ? '—'
      : withSecondary(signed(c.realizedNative, cur), c.realized, cur, true);
    tr.innerHTML = `
      <td><span class="chip acc">${TYPE_LABEL[p.type] || p.type}</span></td>
      <td><b>${escapeHtml(p.name || p.symbol)}</b><span class="sub">${escapeHtml(p.symbol)}</span></td>
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${fmtNum(c.buyNative != null ? c.buyNative : p.avgBuyPrice, 2)} ${cur}</td>
      <td class="num">${p.sellPrice != null ? fmtNum(c.sellNative != null ? c.sellNative : p.sellPrice, 2) + ' ' + cur : '—'}</td>
      <td class="num ${gainClass}">${realizedCell}</td>
      <td>
        <div class="rowactions">
          <button class="iconbtn del" title="Smazat záznam">🗑</button>
        </div>
      </td>`;
    tr.querySelector('.del').addEventListener('click', () => {
      if(confirm(`Smazat historický záznam "${p.name || p.symbol}"?`)) backend.remove(p.id);
    });
    historyBody.appendChild(tr);
  });
}

function renderAlloc(t){
  // Vedle podílu na portfoliu sčítáme i vložený kapitál, ať jde u každé skupiny ukázat
  // zisk/ztrátu – jinak je z rozpadu vidět jen „kolik toho je", ne „jak si to vede".
  const byType = { akcie: 0, krypto: 0, hotovost: 0 };
  const investedByType = { akcie: 0, krypto: 0, hotovost: 0 };
  positions.forEach(p => {
    const c = computed[p.id];
    if(!c || c.value == null) return;
    byType[p.type] = (byType[p.type] || 0) + c.value;
    if(c.invested != null) investedByType[p.type] = (investedByType[p.type] || 0) + c.invested;
  });
  const total = byType.akcie + byType.krypto + byType.hotovost;
  if(!total){
    allocWrap.innerHTML = '<div class="donut-empty">Zatím nejsou žádné pozice s načtenou cenou.</div>';
    return;
  }
  const seg = (label, type, color) => {
    const val = byType[type], inv = investedByType[type];
    // U hotovosti nemá zisk smysl (nákupní cena = 1), tak ho neukazuj.
    const gain = (type === 'hotovost' || !inv) ? null : val - inv;
    return { label, val, color, gain, gainPct: gain == null ? null : (gain / inv) * 100 };
  };
  const segs = [
    seg('Akcie & ETF', 'akcie', 'var(--series-1)'),
    seg('Kryptoměny', 'krypto', 'var(--series-2)'),
    seg('Hotovost', 'hotovost', 'var(--series-3)')
  ].filter(s => s.val > 0);

  const r = 60, cx = 70, cy = 70, circumference = 2 * Math.PI * r;
  const gap = segs.length > 1 ? circumference * 0.012 : 0;
  let offset = 0;
  const circles = segs.map(s => {
    const frac = s.val / total;
    const len = Math.max(frac * circumference - gap, 0);
    const dasharray = `${len} ${circumference - len}`;
    const dashoffset = -offset;
    offset += frac * circumference;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="20"
      stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
  }).join('');

  const legend = segs.map(s => `
    <div class="aleg-row">
      <span class="aleg-dot" style="background:${s.color}"></span>
      <span class="aleg-label">${s.label}</span>
      <span class="aleg-val">${fmtMoney(s.val)} · ${((s.val / total) * 100).toFixed(0)} %</span>
      <span class="aleg-gain ${s.gain == null ? '' : (s.gain >= 0 ? 'gain' : 'loss')}">${
        s.gain == null ? '' : signed(s.gain, displayCur) + ' (' + fmtPct(s.gainPct) + ')'}</span>
    </div>`).join('');

  allocWrap.innerHTML = `
    <svg class="donut" width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Alokace portfolia">
      ${circles}
    </svg>
    <div class="alloclegend">${legend}</div>`;
}

/* ---------- Odkaz na detail titulu ----------
   U krypta je uložené přímo CoinGecko id, takže odkaz sedí vždy. U akcií se skládá
   z tickeru pro Yahoo Finance (`RHM.DE`, `HO.PA` sedí); když by u nějakého titulu
   neseděl, jde vlastní adresu zadat do pole "Odkaz na detail" v editaci pozice. */
function infoUrl(p){
  if(p.infoUrl) return p.infoUrl;
  if(p.type === 'krypto') return 'https://www.coingecko.com/en/coins/' + encodeURIComponent(p.symbol);
  if(p.type === 'akcie') return 'https://finance.yahoo.com/quote/' + encodeURIComponent(p.symbol);
  return null;
}

/* ---------- Graf vývoje ceny (rozklik) ---------- */
const openCharts = new Set(); // id pozic s rozbaleným grafem – ať přežije překreslení

async function fillChart(host, p){
  host.innerHTML = '<div class="chart-empty">Načítám graf…</div>';
  const res = await fetchPriceHistory(p, stockApiKey);
  if(!res.points){
    host.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'pricerr';
    err.textContent = '⚠️ ' + (res.error || 'Historii se nepodařilo načíst');
    host.appendChild(err);
    return;
  }
  // Data z posledních hodin jsou normální stav (přišla spolu s cenou) – hlásit se má
  // jen graf, který je opravdu starý nebo se ho nepovedlo obnovit.
  const ageMs = Date.now() - (res.at || 0);
  const note = (res.cached && (res.error || ageMs > 3 * 60 * 60 * 1000))
    ? 'Data z ' + new Date(res.at).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
      + (res.error ? ' · novější se nepodařilo načíst' : '')
    : '';
  renderPriceChart(host, res.points, res.currency || p.currency, { note });
}

function chartRow(p){
  const tr = document.createElement('tr');
  tr.className = 'chartrow';
  const td = document.createElement('td');
  td.colSpan = 8;
  const host = document.createElement('div');
  host.className = 'chartbox';
  td.appendChild(host);
  tr.appendChild(td);
  fillChart(host, p);
  return tr;
}

/* Krátké zařazení chyby přímo do řádku – celá hláška je ve status baru, ale ta je
   dlouhá a na screenshotu bývá odstřižená. Tohle napoví, jestli je problém v tickeru
   (opraví se změnou symbolu) nebo ve zdroji dat (opraví se sám). */
function shortReason(err){
  const e = String(err || '');
  if(/nezná ticker/i.test(e)) return 'neplatný ticker';
  if(/přímo ani přes proxy|nedostupn|limit/i.test(e)) return 'zdroj cen nedostupný';
  return 'živá cena selhala';
}

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

/* ---------- Ceny ----------
   Twelve Data účtuje 1 kredit za KAŽDÝ symbol (free tarif má jen 8 kreditů/minutu),
   takže se ceny drží v cache s platností PRICE_TTL_MS – přežije i reload stránky
   (localStorage) a stahují se jen symboly, které v cache nejsou nebo už jsou staré.
   Bez toho jedno otevření stránky spálilo několikanásobek limitu a API vracelo 429. */
const PRICE_CACHE_KEY = 'portfolio-price-cache-v1';
// Ceny akcií zdarma jsou zpožděné ~15 min, takže častější dotazy nic nepřinesou –
// dvě minuty jsou kompromis mezi svěžestí a šetrností k veřejným proxy.
const PRICE_TTL_MS = 115 * 1000;
// Chyby (typicky 429 – vyčerpané kredity za minutu) drž kratší dobu, ať se to samo
// zkusí znovu, jakmile se limit obnoví, ale ne hned při každém překreslení.
const PRICE_ERR_TTL_MS = 45 * 1000;
let priceFetchInFlight = null;

const priceCacheKey = p => `${p.type}:${p.symbol}:${p.currency}`;

function loadSymbolCache(){
  try { return JSON.parse(localStorage.getItem(PRICE_CACHE_KEY)) || {}; } catch(e){ return {}; }
}
function saveSymbolCache(cache){
  try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache)); } catch(e){}
}

function setBusy(busy){
  refreshBtn.disabled = busy;
  refreshBtn.textContent = busy ? '⏳ Aktualizuji…' : '🔄 Aktualizovat ceny';
}

/* Zapsání stažených cen do pricesCache. Neúspěšný pokus NESMÍ zahodit dřív načtenou
   platnou cenu – jinak by po kliknutí na aktualizaci tabulka spadla z živých cen
   zpátky na ruční/prázdné. */
function applyFetched(fetched){
  Object.entries(fetched).forEach(([id, r]) => {
    const prev = pricesCache[id];
    // Živá cena z burzy je čerstvější než cokoli staženého dotazem – tu nepřepisuj.
    if(prev && prev.live) return;
    const gotPrice = r && r.priceNative != null && !r.manual;
    if(gotPrice){
      pricesCache[id] = { ...r, cachedAt: Date.now() };
    } else if(!prev || prev.priceNative == null){
      pricesCache[id] = r;
    } else {
      pricesCache[id] = { ...prev, staleError: r.error || null };
    }
  });
}

async function refreshPrices({ force = false } = {}){
  if(priceFetchInFlight) return priceFetchInFlight;   // už běží – nezakládej druhý dotaz
  const priceable = positions.filter(p => !p.closed && p.type !== 'hotovost');
  if(!priceable.length){ render(); return; }

  const symCache = loadSymbolCache();
  const now = Date.now();

  // Nejdřív dopň, co víme z cache (ať je hned co zobrazit i bez dotazu).
  priceable.forEach(p => {
    const c = symCache[priceCacheKey(p)];
    if(!c || pricesCache[p.id]) return;
    if(c.priceNative != null){
      pricesCache[p.id] = { priceNative: c.priceNative, currency: c.currency, cachedAt: c.at, staleError: c.error || null };
    } else if(p.manualPrice != null && !isNaN(p.manualPrice)){
      pricesCache[p.id] = { priceNative: p.manualPrice, currency: p.currency, manual: true, error: c.error };
    } else {
      pricesCache[p.id] = { priceNative: null, currency: c.currency, error: c.error };
    }
  });

  // Čerstvá je buď platná cena v rámci PRICE_TTL_MS, nebo nedávná chyba (ať se po
  // neúspěchu nezkouší hned znovu a nepálí kredity).
  const isFresh = p => {
    const c = symCache[priceCacheKey(p)];
    if(!c) return false;
    if(c.priceNative != null && (now - (c.at || 0)) < PRICE_TTL_MS) return true;
    if(c.error && (now - (c.errAt || 0)) < PRICE_ERR_TTL_MS) return true;
    return false;
  };
  const needed = force ? priceable : priceable.filter(p => !isFresh(p));

  // Co víme z cache, ukaž HNED – ať se během stahování nekouká na samá „…".
  if(Object.keys(pricesCache).length){
    await recompute();
    render();
  }

  if(!needed.length){
    await recompute();
    const newest = Math.max(...priceable.map(p => (symCache[priceCacheKey(p)] || {}).at || 0));
    if(newest > 0) lastUpdateEl.textContent = 'Ceny z ' + new Date(newest).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    render();
    return;
  }

  setBusy(true);
  let gotFresh = 0;
  priceFetchInFlight = (async () => {
    try {
      // Akcie a krypto se stahují z jiných zdrojů, takže je pouštíme jako dvě nezávislé
      // skupiny a každou zobrazíme, jakmile dorazí. Dřív se čekalo na obě naráz – když
      // se zasekly akcie, tabulka neukázala ani bitcoin a jen svítilo „…".
      const groups = [needed.filter(p => p.type === 'krypto'), needed.filter(p => p.type !== 'krypto')]
        .filter(g => g.length);
      const fetched = {};
      await Promise.all(groups.map(async group => {
        const part = await fetchAllPrices(group, stockApiKey);
        Object.assign(fetched, part);
        applyFetched(part);
        await recompute();
        render();
      }));

      // Neúspěšný pokus NESMÍ zahodit dřív načtenou platnou cenu – jinak by po
      // kliknutí na aktualizaci (nebo po zásahu hlídače kreditů) tabulka spadla
      // z živých cen zpátky na ruční/prázdné.
      applyFetched(fetched);

      // Ulož i chyby – ať se při dalším překreslení hned neopakuje dotaz do limitu.
      // Výjimka: hlášky označené `local` (chybí klíč, šetření kreditů) nejsou odpovědí
      // API, jen náš vlastní stav – cachovat je nesmíme, jinak by po pominutí důvodu
      // zůstaly viset až do vypršení TTL.
      needed.forEach(p => {
        const r = fetched[p.id];
        if(!r || r.local) return;
        const key = priceCacheKey(p);
        const prev = symCache[key] || {};
        if(!r.manual && r.priceNative != null){
          symCache[key] = { priceNative: r.priceNative, currency: r.currency, at: Date.now(), error: null, errAt: 0 };
        } else {
          // Chyba z API: poslední známou cenu si nech, jen si poznač chybu a její čas.
          symCache[key] = { ...prev, currency: r.currency || prev.currency, error: r.error || null, errAt: Date.now() };
        }
      });
      saveSymbolCache(symCache);
      gotFresh = needed.filter(p => {
        const r = fetched[p.id];
        return r && r.priceNative != null && !r.manual;
      }).length;
      await recompute();
    } catch(e){
      console.error(e);
    } finally {
      setBusy(false);
      // Čas říká, co se opravdu stalo. „Poslední aktualizace 22:33" u cen z 12:07 je lež –
      // pokus proběhl, ale nová cena nedorazila, a to musí být na první pohled vidět.
      const now = new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
      lastUpdateEl.textContent = gotFresh === 0
        ? `Pokus ${now} – nové ceny nedorazily`
        : (gotFresh < needed.length
            ? `Ceny z ${now} (${gotFresh} z ${needed.length})`
            : `Ceny z ${now}`);
      lastUpdateEl.classList.toggle('warn', gotFresh === 0);
      render();
      priceFetchInFlight = null;
    }
  })();
  return priceFetchInFlight;
}

/* ---------- Živá cena krypta (WebSocket / burza) ----------
   Kryptoburzy posílají cenu samy, takže se na ni neptáme v intervalu. Běží to vedle
   běžného stahování cen: když živé spojení nechytne (nebo vypadne), stránka funguje
   dál na CoinGecku. Vykreslení se schválně omezuje na jednou za sekundu – cena se
   může měnit několikrát za vteřinu a překreslovat kvůli tomu celou tabulku nemá smysl. */
const LIVE_RENDER_MS = 1000;
const liveStops = new Map();   // symbol -> funkce pro zastavení
let liveRenderTimer = null;
let livePending = false;

function scheduleLiveRender(){
  if(liveRenderTimer){ livePending = true; return; }
  const run = async () => {
    await recompute();
    render();
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = null;
      if(livePending){ livePending = false; run(); }
    }, LIVE_RENDER_MS);
  };
  run();
}

function syncLivePrices(){
  const wanted = new Set(positions
    .filter(p => !p.closed && p.type === 'krypto' && hasLiveSource(p.symbol))
    .map(p => p.symbol));

  liveStops.forEach((stop, symbol) => {
    if(wanted.has(symbol)) return;
    stop();
    liveStops.delete(symbol);
  });

  wanted.forEach(symbol => {
    if(liveStops.has(symbol)) return;
    const stop = startLivePrice(symbol, ({ price, currency, source }) => {
      let touched = false;
      positions.forEach(p => {
        if(p.closed || p.type !== 'krypto' || p.symbol !== symbol) return;
        pricesCache[p.id] = { priceNative: price, currency, cachedAt: Date.now(), live: source };
        touched = true;
      });
      if(touched) scheduleLiveRender();
    }, st => {
      if(st.live) return;
      // Spojení stojí – ceny zůstávají poslední známé, jen se přestanou hýbat.
      positions.forEach(p => {
        const r = pricesCache[p.id];
        if(r && r.live && p.symbol === symbol) delete r.live;
      });
      scheduleLiveRender();
    });
    liveStops.set(symbol, stop);
  });
}

/* ---------- Automatická obnova cen akcií ----------
   Zdarma dostupné ceny evropských burz jsou zpožděné (~15 min), takže častěji než
   jednou za minutu nemá smysl se ptát – a mimo obchodní hodiny vůbec, protože se
   stejně nic nemění. Burzy, kde uživatel drží tituly (XETRA, Paříž, Milán, Madrid,
   Stockholm), obchodují 9:00–17:30 středoevropského času. */
const AUTO_REFRESH_MS = 120 * 1000;

function marketOpen(now = new Date()){
  // Časy ber ve středoevropském čase, ať to sedí i když má někdo v mobilu jinou zónu.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  if(parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return mins >= 9 * 60 && mins <= 17 * 60 + 35;
}

function startAutoRefresh(){
  setInterval(() => {
    if(document.hidden) return;      // na skryté záložce se ptát nemusíme
    if(!marketOpen()) return;
    if(!positions.some(p => !p.closed && p.type === 'akcie')) return;
    refreshPrices();                 // respektuje TTL cache, takže nic nepřetěžuje
  }, AUTO_REFRESH_MS);

  // Návrat na záložku po delší době = ceny jsou nejspíš staré, dotáhni je.
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) refreshPrices();
  });
}

/* ---------- Diagnostika cen ----------
   Tlačítko 🩺 vypíše, co přesně vrátila každá cesta ke zdroji cen. Bez toho se problém
   („nejdou ceny") dohaduje přes screenshoty, na kterých bývá status bar odstřižený. */
function diagnosticsText(){
  const t = new Date().toLocaleString('cs-CZ');
  const version = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';
  const ls = k => { try { return localStorage.getItem(k) || '—'; } catch(e){ return '?'; } };
  const lines = [
    `Portfolio – diagnostika cen · ${t} · verze ${version}`,
    `Prohlížeč: ${navigator.userAgent}`,
    `Zapamatovaná brána: ${ls('portfolio-yahoo-gateway-v1')}`,
    `Vlastní proxy: ${lastProxy || '—'}`,
    `Náhradní burzy: ${ls('portfolio-symbol-alias-v1')}`,
    `Kurzy měn: ${JSON.stringify(fxStatus())}`,
    '',
    'STAV POZIC:'
  ];
  positions.filter(p => !p.closed && p.type !== 'hotovost').forEach(p => {
    const r = pricesCache[p.id] || {};
    const parts = [];
    if(r.priceNative != null) parts.push(`${r.priceNative} ${r.currency || '?'}`);
    if(r.live) parts.push('živě z ' + r.live);
    if(r.manual) parts.push('ruční cena');
    if(r.altSymbol) parts.push('burza ' + r.altSymbol);
    if(r.gateway) parts.push('přes ' + r.gateway);
    if(r.cachedAt) parts.push('čas ' + new Date(r.cachedAt).toLocaleTimeString('cs-CZ'));
    const err = r.error || r.staleError;
    lines.push(`  ${p.symbol}: ${parts.join(', ') || 'bez ceny'}${err ? '\n     CHYBA: ' + err : ''}`);
  });
  const diag = priceDiagnostics();
  lines.push('', 'POSLEDNÍ POKUSY (Yahoo):');
  if(!diag.length) lines.push('  (žádné – ceny se braly z cache, dej „Aktualizovat ceny")');
  diag.forEach(d => {
    lines.push(`  ${new Date(d.at).toLocaleTimeString('cs-CZ')} ${d.symbol} · ${d.gateway}`
      + ` · ${d.ok ? 'OK' : 'chyba'} · ${d.ms} ms · ${d.note}`);
  });
  return lines.join('\n');
}

function setupDiagnostics(){
  const btn = document.getElementById('diag-btn');
  const box = document.getElementById('diagbox');
  const text = document.getElementById('diagtext');
  if(!btn || !box || !text) return;
  const show = () => { text.textContent = diagnosticsText(); box.hidden = false; };
  btn.addEventListener('click', () => { if(box.hidden) show(); else box.hidden = true; });
  document.getElementById('diag-close').addEventListener('click', () => { box.hidden = true; });
  document.getElementById('diag-copy').addEventListener('click', async () => {
    const b = document.getElementById('diag-copy');
    try {
      await navigator.clipboard.writeText(text.textContent);
      b.textContent = 'Zkopírováno ✓';
    } catch(e){
      // Bez schránky (starší prohlížeč, http) aspoň označ text, ať jde zkopírovat ručně.
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(text);
      sel.addRange(range);
      b.textContent = 'Označeno – Ctrl+C';
    }
    setTimeout(() => { b.textContent = 'Kopírovat'; }, 2500);
  });
}

/* ---------- Formulář ---------- */
function updateSymbolHint(){
  if(fType.value === 'hotovost'){
    fSymbolHint.textContent = 'Pro hotovost stačí měna – doplní se automaticky, "Množství" je částka.';
    if(!fSymbol.value) fSymbol.value = fCurrency.value;
    fPrice.value = '1';
    fPrice.readOnly = true;
  } else {
    fPrice.readOnly = false;
    fSymbolHint.textContent = fType.value === 'krypto'
      ? 'ID z CoinGecko, např. "bitcoin", "ethereum", "solana" (najdeš v URL na coingecko.com/en/coins/…).'
      : 'Ticker v konvenci Yahoo Finance, např. "AAPL", "RHM.DE" (XETRA), "HO.PA" (Paříž) – ověříš na finance.yahoo.com.';
  }
}
fType.addEventListener('change', updateSymbolHint);
fCurrency.addEventListener('change', () => { if(fType.value === 'hotovost') fSymbol.value = fCurrency.value; });
updateSymbolHint();

/* Pole chce cenu za JEDEN kus, ne celkovou investici – tenhle živý přepočet tu záměnu
   odhalí hned při psaní (jednou se stala a portfolio pak ukazovalo nesmyslný zisk). */
function updateTotalHint(){
  if(!fTotalHint) return;
  if(fType.value === 'hotovost'){ fTotalHint.textContent = ''; return; }
  const q = parseFloat(fQty.value), pr = parseFloat(fPrice.value);
  fTotalHint.textContent = (isNaN(q) || isNaN(pr))
    ? 'Cena za jeden kus, ne celkem investovaná částka.'
    : 'Celkem investováno: ' + fmtIn(q * pr, fCurrency.value);
}
[fQty, fPrice, fCurrency, fType].forEach(el => {
  if(!el) return;
  el.addEventListener('input', updateTotalHint);
  el.addEventListener('change', updateTotalHint);
});

function openModal(pos){
  editingId = pos ? pos.id : null;
  modalTitle.textContent = pos ? 'Upravit pozici' : 'Přidat pozici';
  fType.value = pos ? pos.type : 'akcie';
  fSymbol.value = pos ? pos.symbol : '';
  fName.value = pos ? (pos.name || '') : '';
  fQty.value = pos ? pos.quantity : '';
  fPrice.value = pos ? pos.avgBuyPrice : '';
  fCurrency.value = pos ? pos.currency : 'CZK';
  fManual.value = (pos && pos.manualPrice != null) ? pos.manualPrice : '';
  if(fPrimary) fPrimary.value = pos ? (pos.primaryCurrency || '') : '';
  fNote.value = pos ? (pos.note || '') : '';
  if(fUrl) fUrl.value = pos ? (pos.infoUrl || '') : '';
  updateSymbolHint();
  updateTotalHint();
  modal.classList.add('open');
  setTimeout(() => fSymbol.focus(), 50);
}
function closeModal(){ modal.classList.remove('open'); editingId = null; form.reset(); }

addBtn.addEventListener('click', () => openModal(null));
closeBtn.addEventListener('click', closeModal);
cancelBtn.addEventListener('click', closeModal);
modal.addEventListener('click', e => { if(e.target === modal) closeModal(); });

form.addEventListener('submit', async e => {
  e.preventDefault();
  const manual = parseFloat(fManual.value);
  const data = {
    type: fType.value,
    symbol: fSymbol.value.trim(),
    name: fName.value.trim(),
    quantity: parseFloat(fQty.value),
    avgBuyPrice: parseFloat(fPrice.value),
    currency: fCurrency.value,
    manualPrice: (fType.value === 'hotovost' || isNaN(manual)) ? null : manual,
    // Prázdné = hlavní údaje řádku zůstanou v měně pozice.
    primaryCurrency: (fPrimary && fPrimary.value && fPrimary.value !== fCurrency.value) ? fPrimary.value : '',
    note: fNote.value.trim(),
    infoUrl: fUrl ? fUrl.value.trim() : '',
  };
  if(!data.symbol || !data.quantity || !data.avgBuyPrice){ return; }
  saveBtn.disabled = true;
  try {
    if(editingId) await backend.update(editingId, data);
    else await backend.add({ ...data, ts: Date.now() });
    closeModal();
    refreshPrices();
  } catch(err){
    console.error(err);
    alert('Pozici se nepodařilo uložit.');
  } finally {
    saveBtn.disabled = false;
  }
});

refreshBtn.addEventListener('click', () => refreshPrices({ force: true }));

// Změna zobrazovací měny je jen přepočet už stažených cen – žádné nové dotazy do API.
if(displayCurEl){
  displayCurEl.value = displayCur;
  displayCurEl.addEventListener('change', async () => {
    displayCur = DISPLAY_CURRENCIES.includes(displayCurEl.value) ? displayCurEl.value : 'CZK';
    try { localStorage.setItem(DISPLAY_CUR_KEY, displayCur); } catch(e){}
    await recompute();
    render();
  });
}

/* ---------- Inicializace ---------- */
async function init(){
  if(useFirebase){
    try {
      backend = await firebaseBackend();
      statusEl.innerHTML = '🟢 Sdílené online – pozice vidí oba v reálném čase.';
      statusEl.className = 'statusbar ok';
    } catch(e){
      console.error(e);
      backend = localBackend();
      statusEl.innerHTML = '⚠️ Online databázi se nepodařilo načíst – používá se lokální ukládání jen v tomto prohlížeči.';
      statusEl.className = 'statusbar warn';
    }
  } else {
    backend = localBackend();
    statusEl.innerHTML = '🔒 Jen na tomto zařízení.';
    statusEl.className = 'statusbar';
  }

  fxWarnEl = document.createElement('span');
  statusEl.appendChild(fxWarnEl);
  priceWarnEl = document.createElement('span');
  statusEl.appendChild(priceWarnEl);
  // Klíč už není potřeba (ceny akcií jdou z Yahoo), takže se na jeho chybějící hodnotu
  // neupozorňuje – jen se zaznamená pro případ, že by Yahoo u některého titulu selhalo.
  subscribeSettings(({ twelveDataKey, corsProxy }) => {
    const changed = twelveDataKey !== stockApiKey || corsProxy !== lastProxy;
    stockApiKey = twelveDataKey;
    lastProxy = corsProxy;
    setCustomProxy(corsProxy);
    // Klíč mohl dorazit až po prvním pokusu o ceny. Vynucovat se to nesmí (spálilo by
    // to kredity při každém načtení) – chybové stavy se necachují nadlouho, takže se
    // ceny dotáhnou i tímhle běžným, cache-respektujícím voláním.
    if(changed && positions.length) refreshPrices();
  });

  backend.subscribe(async list => {
    positions = list;
    await recompute();
    render();
    refreshPrices();
    syncLivePrices();
  });
  startAutoRefresh();
  setupDiagnostics();
}

init();
