import { firebaseConfig, POSITIONS_COLLECTION } from './firebase-config.js';
import { fetchAllPrices, convertToCZK, getStockApiKey } from './prices.js';

const TYPE_LABEL = { akcie: 'Akcie / ETF', krypto: 'Kryptoměna' };
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
  renderAlloc(t);
}

function renderTable(){
  tbody.innerHTML = '';
  if(!positions.length){
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  positions.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach(p => {
    const price = pricesCache[p.id];
    const c = computed[p.id] || {};
    const tr = document.createElement('tr');
    const gainClass = c.gainCZK == null ? '' : (c.gainCZK >= 0 ? 'gain' : 'loss');
    tr.innerHTML = `
      <td><span class="chip acc">${TYPE_LABEL[p.type] || p.type}</span></td>
      <td><b>${escapeHtml(p.name || p.symbol)}</b><span class="sub">${escapeHtml(p.symbol)}</span></td>
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${fmtNum(p.avgBuyPrice, 2)} ${p.currency}</td>
      <td class="num">${price && price.priceNative != null ? fmtNum(price.priceNative, 2) + ' ' + price.currency : (price && price.error ? '<span title="' + escapeHtml(price.error) + '">⚠️ chyba</span>' : '…')}</td>
      <td class="num">${fmtCZK(c.valueCZK)}</td>
      <td class="num ${gainClass}">${c.gainCZK == null ? '—' : (c.gainCZK >= 0 ? '+' : '') + fmtCZK(c.gainCZK) + ' (' + fmtPct(c.gainPct) + ')'}</td>
      <td>
        <div class="rowactions">
          <button class="iconbtn edit" title="Upravit">✏️</button>
          <button class="iconbtn del" title="Smazat">🗑</button>
        </div>
      </td>`;
    tr.querySelector('.edit').addEventListener('click', () => openModal(p));
    tr.querySelector('.del').addEventListener('click', () => {
      if(confirm(`Smazat pozici "${p.name || p.symbol}"?`)) backend.remove(p.id);
    });
    tbody.appendChild(tr);
  });
}

function renderAlloc(t){
  const byType = { akcie: 0, krypto: 0 };
  positions.forEach(p => {
    const c = computed[p.id];
    if(c && c.valueCZK != null) byType[p.type] = (byType[p.type] || 0) + c.valueCZK;
  });
  const total = byType.akcie + byType.krypto;
  if(!total){
    allocWrap.innerHTML = '<div class="donut-empty">Zatím nejsou žádné pozice s načtenou cenou.</div>';
    return;
  }
  const segs = [
    { label: 'Akcie & ETF', val: byType.akcie, color: 'var(--series-1)' },
    { label: 'Kryptoměny', val: byType.krypto, color: 'var(--series-2)' }
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
    pricesCache = await fetchAllPrices(positions);
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
  fSymbolHint.textContent = fType.value === 'krypto'
    ? 'ID z CoinGecko, např. "bitcoin", "ethereum", "solana" (najdeš v URL na coingecko.com/en/coins/…).'
    : 'Ticker pro Twelve Data, např. "AAPL", "MSFT", "CSPX.L" (najdeš na twelvedata.com).';
}
fType.addEventListener('change', updateSymbolHint);
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

  if(!getStockApiKey()){
    const warn = document.createElement('span');
    warn.innerHTML = ' · ⚠️ Pro ceny akcií/ETF nejdřív nastav API klíč v <a href="nastaveni.html">Nastavení</a>.';
    statusEl.appendChild(warn);
  }

  backend.subscribe(async list => {
    positions = list;
    await recompute();
    render();
    refreshPrices();
  });
}

init();
