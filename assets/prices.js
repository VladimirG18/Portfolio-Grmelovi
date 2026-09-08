/* Stahování aktuálních cen – kryptoměny (CoinGecko, bez klíče) a akcie/ETF
   (Twelve Data, potřebuje API klíč – spravuje se sdíleně přes assets/settings.js).
   Kurzy měn (USD/EUR → CZK) přes Frankfurter (bez klíče). */

const FX_CACHE_STORAGE = 'portfolio-fx-cache-v1';

/* ---------- Hlídač kreditů Twelve Data ----------
   Free tarif má 8 kreditů/minutu a účtuje 1 kredit za KAŽDÝ symbol. Když se limit
   překročí, API vrací 429 – a další pokusy ho drží vyčerpaný. Proto si počítáme
   útratu sami a raději dotaz vůbec neodešleme, než abychom dostali 429. */
const CREDIT_LOG_KEY = 'portfolio-td-credits-v1';
const CREDIT_COOLDOWN_KEY = 'portfolio-td-cooldown-v1';
const CREDIT_LIMIT_PER_MIN = 8;
const CREDIT_RESERVE = 2; // rezerva, ať nenarazíme přesně na strop

function readCreditLog(){
  try {
    const log = JSON.parse(localStorage.getItem(CREDIT_LOG_KEY)) || [];
    const cutoff = Date.now() - 60000;
    return log.filter(e => e && e.at > cutoff);
  } catch(e){ return []; }
}
function spentLastMinute(){
  return readCreditLog().reduce((n, e) => n + (e.n || 0), 0);
}
function recordCredits(n){
  const log = readCreditLog();
  log.push({ at: Date.now(), n });
  try { localStorage.setItem(CREDIT_LOG_KEY, JSON.stringify(log)); } catch(e){}
}
function cooldownLeftMs(){
  try {
    const until = parseInt(localStorage.getItem(CREDIT_COOLDOWN_KEY) || '0', 10);
    return Math.max(0, until - Date.now());
  } catch(e){ return 0; }
}
function startCooldown(ms){
  try { localStorage.setItem(CREDIT_COOLDOWN_KEY, String(Date.now() + ms)); } catch(e){}
}

/* ---------- Kryptoměny (CoinGecko) ---------- */
async function fetchCryptoPrices(ids){
  if(!ids.length) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=czk`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  const data = await res.json();
  const out = {};
  ids.forEach(id => {
    if(data[id] && typeof data[id].czk === 'number') out[id] = data[id].czk;
  });
  return out;
}

/* ---------- Akcie / ETF (Twelve Data) ----------
   Vrací mapu symbol -> { price } nebo { error }. Chybovou hlášku z API
   propouštíme dál, ať je v tabulce vidět skutečný důvod (neplatný ticker,
   symbol mimo tarif, vyčerpané kredity…), ne jen "chyba". */
async function fetchStockPrices(symbols, apiKey){
  const out = {};
  if(!symbols.length) return out;
  if(!apiKey){
    symbols.forEach(s => { out[s] = { error: 'Chybí API klíč pro akcie (vlož ho v Nastavení)', local: true }; });
    return out;
  }

  // Limit vyčerpaný z minulého pokusu – nezkoušej to znovu, jen by se to protáhlo.
  const cool = cooldownLeftMs();
  if(cool > 0){
    const s = Math.ceil(cool / 1000);
    symbols.forEach(x => { out[x] = { error: `Limit Twelve Data vyčerpán, zkusím to za ${s} s`, local: true }; });
    return out;
  }
  // Nevejdeme se do minutového rozpočtu – radši dotaz vůbec neposílej.
  if(spentLastMinute() + symbols.length > CREDIT_LIMIT_PER_MIN - CREDIT_RESERVE){
    symbols.forEach(x => { out[x] = { error: 'Šetřím kredity Twelve Data (limit 8/min), zkus to za chvíli', local: true }; });
    return out;
  }
  recordCredits(symbols.length);

  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch(e){
    symbols.forEach(s => { out[s] = { error: 'Twelve Data je nedostupná: ' + e }; });
    return out;
  }

  // Chyba platná pro celý dotaz (špatný klíč, tarif, rate limit).
  if(data && (data.status === 'error' || (data.code && !data.price))){
    // 429 = vyčerpané kredity za minutu; drž chvíli klid, ať se limit stihne obnovit.
    if(data.code === 429) startCooldown(70000);
    const msg = (data.message || 'neznámá chyba') + (data.code ? ' (kód ' + data.code + ')' : '');
    symbols.forEach(s => { out[s] = { error: msg }; });
    return out;
  }

  symbols.forEach(sym => {
    // Jeden symbol => plochá odpověď {price}; víc symbolů => mapa podle symbolu.
    const d = symbols.length === 1 ? data : (data ? data[sym] : null);
    if(d && d.price != null && !d.code){
      out[sym] = { price: parseFloat(d.price) };
    } else if(d && (d.message || d.code)){
      out[sym] = { error: (d.message || 'chyba') + (d.code ? ' (kód ' + d.code + ')' : '') };
    } else {
      out[sym] = { error: 'Symbol nenalezen na Twelve Data' };
    }
  });
  return out;
}

/* ---------- Kurzy měn ----------
   Bez kurzu se nedá spočítat hodnota ničeho v cizí měně (a to je většina portfolia),
   takže nespoléhej na jediný zdroj: zkoušej je popořadě, kurz drž v localStorage a
   když všechny zdroje selžou, radši použij poslední známý kurz (označený jako starý)
   než abys nezobrazil vůbec nic. */
const FX_FRESH_MS = 12 * 60 * 60 * 1000; // kurz starší než půl dne zkus obnovit
const FX_SOURCES = [
  { name: 'frankfurter.dev', url: (f, t) => `https://api.frankfurter.dev/v1/latest?base=${f}&symbols=${t}`,
    pick: (d, t) => d && d.rates && d.rates[t] },
  { name: 'frankfurter.app', url: (f, t) => `https://api.frankfurter.app/latest?from=${f}&to=${t}`,
    pick: (d, t) => d && d.rates && d.rates[t] },
  { name: 'open.er-api.com', url: (f) => `https://open.er-api.com/v6/latest/${f}`,
    pick: (d, t) => d && d.rates && d.rates[t] },
];

let fxState = { ok: true, stale: false, error: null };
export function fxStatus(){ return { ...fxState }; }

function loadFxCache(){
  try { return JSON.parse(localStorage.getItem(FX_CACHE_STORAGE)) || {}; } catch(e){ return {}; }
}
function saveFxCache(cache){
  try { localStorage.setItem(FX_CACHE_STORAGE, JSON.stringify(cache)); } catch(e){}
}

async function fetchFxRate(from, to){
  if(from === to) return 1;
  const key = from + '_' + to;
  const cache = loadFxCache();
  const now = Date.now();
  const cached = cache[key];
  if(cached && (now - cached.ts) < FX_FRESH_MS) return cached.rate;

  const problems = [];
  for(const src of FX_SOURCES){
    try {
      const res = await fetch(src.url(from, to));
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const rate = src.pick(await res.json(), to);
      if(typeof rate !== 'number' || !isFinite(rate)) throw new Error('kurz v odpovědi chybí');
      cache[key] = { rate, ts: now };
      saveFxCache(cache);
      fxState = { ok: true, stale: false, error: null };
      return rate;
    } catch(e){
      problems.push(`${src.name}: ${e.message || e}`);
    }
  }

  // Žádný zdroj nedostupný – ber poslední známý kurz, i když je starý.
  if(cached){
    fxState = { ok: false, stale: true, error: problems.join('; ') };
    return cached.rate;
  }
  fxState = { ok: false, stale: false, error: problems.join('; ') };
  throw new Error('Kurz ' + from + '→' + to + ' se nepodařilo načíst (' + problems.join('; ') + ')');
}

/* ---------- Historie cen pro graf ----------
   Stahuje se AŽ na rozkliknutí grafu (u akcií stojí 1 kredit za symbol) a drží se
   v localStorage – denní data nemá smysl tahat víckrát za den. Vždycky se načte celý
   rok a kratší rozsahy se jen ořežou lokálně, ať jedno rozkliknutí = jeden dotaz. */
const HISTORY_CACHE_KEY = 'portfolio-history-cache-v1';
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;

function loadHistoryCache(){
  try { return JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY)) || {}; } catch(e){ return {}; }
}
function saveHistoryCache(cache){
  try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(cache)); } catch(e){}
}

async function fetchCryptoHistory(id, currency){
  const vs = (currency || 'CZK').toLowerCase();
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`
    + `?vs_currency=${vs}&days=365&interval=daily`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
  const data = await res.json();
  if(!data || !Array.isArray(data.prices)) throw new Error('CoinGecko: chybí data');
  return data.prices.map(([t, c]) => ({ t, c })).filter(p => typeof p.c === 'number');
}

async function fetchStockHistory(symbol, apiKey){
  if(!apiKey) throw new Error('Chybí API klíč pro akcie (vlož ho v Nastavení)');
  const cool = cooldownLeftMs();
  if(cool > 0) throw new Error(`Limit Twelve Data vyčerpán, zkus to za ${Math.ceil(cool / 1000)} s`);
  if(spentLastMinute() + 1 > CREDIT_LIMIT_PER_MIN - CREDIT_RESERVE){
    throw new Error('Šetřím kredity Twelve Data (limit 8/min), zkus to za chvíli');
  }
  recordCredits(1);

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}`
    + `&interval=1day&outputsize=400&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if(data && (data.status === 'error' || (data.code && !data.values))){
    if(data.code === 429) startCooldown(70000);
    throw new Error((data.message || 'neznámá chyba') + (data.code ? ' (kód ' + data.code + ')' : ''));
  }
  if(!data || !Array.isArray(data.values)) throw new Error('Twelve Data: chybí data');
  return data.values
    .map(v => ({ t: Date.parse(v.datetime), c: parseFloat(v.close) }))
    .filter(p => !isNaN(p.t) && !isNaN(p.c))
    .sort((a, b) => a.t - b.t);
}

/** Historie ceny pozice (rok denních dat) v měně pozice. Vrací { points } nebo { error }. */
export async function fetchPriceHistory(position, apiKey){
  const key = `${position.type}:${position.symbol}:${position.currency}`;
  const cache = loadHistoryCache();
  const hit = cache[key];
  if(hit && hit.points && (Date.now() - hit.at) < HISTORY_TTL_MS){
    return { points: hit.points, cached: true, at: hit.at };
  }
  try {
    const points = position.type === 'krypto'
      ? await fetchCryptoHistory(position.symbol, position.currency)
      : await fetchStockHistory(position.symbol, apiKey);
    if(!points.length) throw new Error('Zdroj nevrátil žádná data');
    cache[key] = { points, at: Date.now() };
    saveHistoryCache(cache);
    return { points, at: Date.now() };
  } catch(e){
    // Radši ukaž starší graf než nic.
    if(hit && hit.points) return { points: hit.points, cached: true, at: hit.at, error: String(e.message || e) };
    return { error: String(e.message || e) };
  }
}

/** Převod částky mezi měnami (zobrazovací měnu si volí uživatel, viz portfolio.js). */
export async function convert(amount, from, to){
  const f = from || 'CZK', t = to || 'CZK';
  if(f === t) return amount;
  const rate = await fetchFxRate(f, t);
  return amount * rate;
}

/**
 * Načte aktuální ceny pro seznam pozic.
 * positions: [{ id, type:'akcie'|'krypto', symbol, currency }]
 * apiKey: sdílený Twelve Data klíč (z assets/settings.js), může být prázdný.
 * Vrací mapu id -> { priceNative, currency, error }
 * U krypta je "currency" vždy 'CZK' (cena rovnou v CZK).
 * U akcií je cena v měně pozice (currency z formuláře) – ber to jako
 * nejlepší dostupný odhad, Twelve Data konverzi měny nedělá.
 */
export async function fetchAllPrices(positions, apiKey){
  const out = {};
  const cryptoIds = [...new Set(positions.filter(p => p.type === 'krypto').map(p => p.symbol))];
  const stockSymbols = [...new Set(positions.filter(p => p.type === 'akcie').map(p => p.symbol))];

  const [cryptoRes, stockRes] = await Promise.allSettled([
    fetchCryptoPrices(cryptoIds),
    fetchStockPrices(stockSymbols, apiKey)
  ]);

  const cryptoPrices = cryptoRes.status === 'fulfilled' ? cryptoRes.value : {};
  const stockResults = stockRes.status === 'fulfilled' ? stockRes.value : {};
  const cryptoErr = cryptoRes.status === 'rejected' ? String(cryptoRes.reason) : null;
  const stockErr = stockRes.status === 'rejected' ? String(stockRes.reason) : null;

  positions.forEach(p => {
    let auto = null, error = null, local = false;
    if(p.type === 'krypto'){
      const price = cryptoPrices[p.symbol];
      if(price != null) auto = { priceNative: price, currency: 'CZK' };
      else error = cryptoErr || 'Symbol nenalezen na CoinGecko';
    } else {
      const r = stockResults[p.symbol];
      if(r && r.price != null) auto = { priceNative: r.price, currency: p.currency };
      else {
        error = (r && r.error) || stockErr || 'Symbol nenalezen';
        local = !!(r && r.local); // naše vlastní hláška, ne odpověď API – necachovat
      }
    }

    if(auto){ out[p.id] = auto; return; }

    // Automatická cena nedostupná – použij ručně zadanou, pokud u pozice je.
    if(p.manualPrice != null && !isNaN(p.manualPrice)){
      out[p.id] = { priceNative: p.manualPrice, currency: p.currency, manual: true, error, local };
    } else {
      out[p.id] = { priceNative: null, currency: p.currency, error, local };
    }
  });

  return out;
}
