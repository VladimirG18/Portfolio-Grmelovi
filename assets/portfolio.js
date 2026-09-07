import { firebaseConfig, POSITIONS_COLLECTION } from './firebase-config.js?v=__CACHEBUST__';
import { fetchAllPrices, convertToCZK } from './prices.js?v=__CACHEBUST__';
import { subscribeStockApiKey } from './settings.js?v=__CACHEBUST__';

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
const fNote = document.getElementById('f-note');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const closeBtn = document.getElementById('modal-close');

const fmtCZK = n => (n == null || isNaN(n)) ? '—' : n.toLocaleString('cs-CZ', { maximumFractionDigits: 0 }) + ' Kč';
const fmtNum = (n, d = 4) => (n == null || isNaN(n)) ? '—' : n.toLocaleString('cs-CZ', { maximumFractionDigits: d });
const fmtPct = n => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' %';

let positions = [];
let pricesCache = {}; // id -> { priceNative, currency, error }
let computed = {};    // id -> { valueCZK, investedCZK, gainCZK, gainPct }
let editingId = null;
let stockApiKey = ''; // sdílený Twelve Data klíč (viz assets/settings.js)

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

/* ---------- Výpočty ---------- */
async function recompute(){
  computed = {};
  for(const p of positions){
    if(p.type === 'hotovost'){
      let v = null;
      try { v = await convertToCZK(p.quantity, p.currency); } catch(e){ v = null; }
      computed[p.id] = { valueCZK: v, investedCZK: v, gainCZK: v != null ? 0 : null, gainPct: v != null ? 0 : null };
      continue;
    }
    if(p.closed){
      let costCZK = null, realizedCZK = null;
      try { costCZK = await convertToCZK(p.quantity * p.avgBuyPrice, p.currency); } catch(e){ costCZK = null; }
      if(p.sellPrice != null){
        try { realizedCZK = await convertToCZK(p.quantity * (p.sellPrice - p.avgBuyPrice), p.currency); }
        catch(e){ realizedCZK = null; }
      }
      // Uzavřené (prodané) pozice se nepočítají do aktuální hodnoty ani vloženého kapitálu –
      // jsou to jen historické záznamy s realizovaným ziskem/ztrátou (viz renderHistory).
      computed[p.id] = { valueCZK: null, investedCZK: null, gainCZK: null, gainPct: null, costCZK, realizedCZK };
      continue;
    }
    const price = pricesCache[p.id];
    let valueCZK = null, investedCZK = null;
    try {
      investedCZK = await convertToCZK(p.quantity * p.avgBuyPrice, p.currency);
    } catch(e){ investedCZK = null; }
    if(price && price.priceNative != null){
      try { valueCZK = await convertToCZK(p.quantity * price.priceNative, price.currency); }
      catch(e){ valueCZK = null; }
    }
    const gainCZK = (valueCZK != null && investedCZK != null) ? valueCZK - investedCZK : null;
    const gainPct = (gainCZK != null && investedCZK) ? (gainCZK / investedCZK) * 100 : null;
    computed[p.id] = { valueCZK, investedCZK, gainCZK, gainPct };
  }
}

function totals(){
  let value = 0, invested = 0, any = false;
  positions.forEach(p => {
    const c = computed[p.id];
    if(c && c.valueCZK != null){ value += c.valueCZK; any = true; }
    if(c && c.investedCZK != null) invested += c.investedCZK;
  });
  const gain = value - invested;
  const gainPct = invested ? (gain / invested) * 100 : null;
  return { value: any ? value : null, invested, gain: any ? gain : null, gainPct: any ? gainPct : null };
}

/* ---------- Vykreslení ---------- */
function render(){
  const t = totals();
  statEls.value.textContent = fmtCZK(t.value);
  statEls.invested.textContent = fmtCZK(t.invested);
  statEls.gain.textContent = (t.gain == null ? '—' : (t.gain >= 0 ? '+' : '') + fmtCZK(t.gain));
  statEls.gain.className = (t.gain == null ? '' : (t.gain >= 0 ? 'up' : 'down'));
  statEls.gainPct.textContent = fmtPct(t.gainPct);
  statEls.gainPct.className = (t.gainPct == null ? '' : (t.gainPct >= 0 ? 'up' : 'down'));

  renderTable();
  renderHistory();
  renderAlloc(t);
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
    const tr = document.createElement('tr');
    const gainClass = (c.gainCZK == null || isCash) ? '' : (c.gainCZK >= 0 ? 'gain' : 'loss');
    const priceCell = isCash ? '—'
      : (price && price.priceNative != null ? fmtNum(price.priceNative, 2) + ' ' + price.currency
        : (price && price.error ? '<span title="' + escapeHtml(price.error) + '">⚠️ chyba</span>' : '…'));
    const buyCell = isCash ? '—' : fmtNum(p.avgBuyPrice, 2) + ' ' + p.currency;
    const gainCell = isCash ? '—' : (c.gainCZK == null ? '—' : (c.gainCZK >= 0 ? '+' : '') + fmtCZK(c.gainCZK) + ' (' + fmtPct(c.gainPct) + ')');
    tr.innerHTML = `
      <td><span class="chip acc">${TYPE_LABEL[p.type] || p.type}</span></td>
      <td><b>${escapeHtml(p.name || p.symbol)}</b>${isCash ? '' : '<span class="sub">' + escapeHtml(p.symbol) + '</span>'}</td>
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${buyCell}</td>
      <td class="num">${priceCell}</td>
      <td class="num">${fmtCZK(c.valueCZK)}</td>
      <td class="num ${gainClass}">${gainCell}</td>
      <td>
        <div class="rowactions">
          ${isCash ? '' : '<button class="iconbtn sell" title="Označit jako prodané">💰</button>'}
          <button class="iconbtn edit" title="Upravit">✏️</button>
          <button class="iconbtn del" title="Smazat">🗑</button>
        </div>
      </td>`;
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
    const tr = document.createElement('tr');
    const gainClass = c.realizedCZK == null ? '' : (c.realizedCZK >= 0 ? 'gain' : 'loss');
    tr.innerHTML = `
      <td><span class="chip acc">${TYPE_LABEL[p.type] || p.type}</span></td>
      <td><b>${escapeHtml(p.name || p.symbol)}</b><span class="sub">${escapeHtml(p.symbol)}</span></td>
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${fmtNum(p.avgBuyPrice, 2)} ${p.currency}</td>
      <td class="num">${p.sellPrice != null ? fmtNum(p.sellPrice, 2) + ' ' + p.currency : '—'}</td>
      <td class="num ${gainClass}">${c.realizedCZK == null ? '—' : (c.realizedCZK >= 0 ? '+' : '') + fmtCZK(c.realizedCZK)}</td>
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
  const byType = { akcie: 0, krypto: 0, hotovost: 0 };
  positions.forEach(p => {
    const c = computed[p.id];
    if(c && c.valueCZK != null) byType[p.type] = (byType[p.type] || 0) + c.valueCZK;
  });
  const total = byType.akcie + byType.krypto + byType.hotovost;
  if(!total){
    allocWrap.innerHTML = '<div class="donut-empty">Zatím nejsou žádné pozice s načtenou cenou.</div>';
    return;
  }
  const segs = [
    { label: 'Akcie & ETF', val: byType.akcie, color: 'var(--series-1)' },
    { label: 'Kryptoměny', val: byType.krypto, color: 'var(--series-2)' },
    { label: 'Hotovost', val: byType.hotovost, color: 'var(--series-3)' }
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
      <span class="aleg-val">${fmtCZK(s.val)} · ${((s.val / total) * 100).toFixed(0)} %</span>
    </div>`).join('');

  allocWrap.innerHTML = `
    <svg class="donut" width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Alokace portfolia">
      ${circles}
    </svg>
    <div class="alloclegend">${legend}</div>`;
}

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

/* ---------- Ceny ---------- */
async function refreshPrices(){
  if(!positions.length){ render(); return; }
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⏳ Aktualizuji…';
  try {
    const priceable = positions.filter(p => !p.closed && p.type !== 'hotovost');
    pricesCache = await fetchAllPrices(priceable, stockApiKey);
    await recompute();
  } catch(e){
    console.error(e);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '🔄 Aktualizovat ceny';
    lastUpdateEl.textContent = 'Poslední aktualizace: ' + new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    render();
  }
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
      : 'Ticker pro Twelve Data, např. "AAPL", "MSFT", "CSPX.L" (najdeš na twelvedata.com).';
  }
}
fType.addEventListener('change', updateSymbolHint);
fCurrency.addEventListener('change', () => { if(fType.value === 'hotovost') fSymbol.value = fCurrency.value; });
updateSymbolHint();

function openModal(pos){
  editingId = pos ? pos.id : null;
  modalTitle.textContent = pos ? 'Upravit pozici' : 'Přidat pozici';
  fType.value = pos ? pos.type : 'akcie';
  fSymbol.value = pos ? pos.symbol : '';
  fName.value = pos ? (pos.name || '') : '';
  fQty.value = pos ? pos.quantity : '';
  fPrice.value = pos ? pos.avgBuyPrice : '';
  fCurrency.value = pos ? pos.currency : 'CZK';
  fNote.value = pos ? (pos.note || '') : '';
  updateSymbolHint();
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
  const data = {
    type: fType.value,
    symbol: fSymbol.value.trim(),
    name: fName.value.trim(),
    quantity: parseFloat(fQty.value),
    avgBuyPrice: parseFloat(fPrice.value),
    currency: fCurrency.value,
    note: fNote.value.trim(),
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

refreshBtn.addEventListener('click', refreshPrices);

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

  const apiKeyWarnEl = document.createElement('span');
  statusEl.appendChild(apiKeyWarnEl);
  subscribeStockApiKey(key => {
    const changed = key !== stockApiKey;
    stockApiKey = key;
    apiKeyWarnEl.innerHTML = stockApiKey ? '' : ' · ⚠️ Pro ceny akcií/ETF nejdřív nastav API klíč v <a href="nastaveni.html">Nastavení</a>.';
    if(changed && positions.length) refreshPrices();
  });

  backend.subscribe(async list => {
    positions = list;
    await recompute();
    render();
    refreshPrices();
  });
}

init();
