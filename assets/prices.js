/* Stahování aktuálních cen – kryptoměny (CoinGecko) a akcie/ETF (Yahoo Finance).
   Obojí je bez klíče. Twelve Data zůstává jen jako záloha pro akcie, když je klíč
   uložený v nastavení (assets/settings.js) – jeho free tarif ale evropské burzy
   nepokrývá, takže hlavní zdroj je Yahoo. Kurzy měn přes Frankfurter (bez klíče). */

const FX_CACHE_STORAGE = 'portfolio-fx-cache-v1';

/* ---------- fetch s časovým limitem ----------
   Bez limitu dokáže jeden zaseknutý zdroj (typicky veřejná CORS proxy) držet celé
   načítání cen klidně minuty a stránka pak jen ukazuje „…". Každý dotaz proto musí
   sám od sebe skončit a nechat kód sáhnout po dalším zdroji. */
const TIMEOUT_MS = 7000;
async function fetchJson(url, ms = TIMEOUT_MS){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if(!res.ok){
      // Chybové odpovědi často nesou vysvětlení v těle: Yahoo u neznámého tickeru vrací
      // 404 s popisem, Twelve Data 429 se zprávou o kreditech. Bez přečtení těla by se
      // chyba dat (špatný symbol – opraví se jinam) tvářila jako výpadek spojení.
      let body = null;
      try { body = await res.json(); } catch(e){}
      if(body){
        try { Object.defineProperty(body, '__httpStatus', { value: res.status, enumerable: false }); } catch(e){}
        return body;
      }
      throw new Error('HTTP ' + res.status);
    }
    return await res.json();
  } catch(e){
    if(e && e.name === 'AbortError') throw new Error(`nestihl odpovědět do ${Math.round(ms / 1000)} s`);
    throw e;
  } finally { clearTimeout(timer); }
}

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
  const data = await fetchJson(url);
  const out = {};
  ids.forEach(id => {
    if(data[id] && typeof data[id].czk === 'number') out[id] = data[id].czk;
  });
  return out;
}

/* ---------- Akcie / ETF ----------
   HLAVNÍ ZDROJ JE YAHOO FINANCE, ne Twelve Data: free tarif Twelve Data nepokrývá
   evropské burzy (XETRA, Euronext…) a na tyhle tituly vrací "This symbol is available
   starting with the Grow or Venture plan" – tedy přesně to, co uživatel drží. Yahoo je
   bez klíče, bez kreditů a jedním dotazem vrátí cenu i roční historii pro graf.
   Twelve Data zůstává jako záloha (má-li uživatel klíč, hodí se pro americké tituly).

   Yahoo neposílá CORS hlavičky spolehlivě, takže se zkouší přímé volání a teprve když
   selže, veřejné CORS proxy. Ven jde jen ticker, žádné částky ani osobní údaje.
   Symboly proto pište v konvenci Yahoo (`RHM.DE`, `HO.PA`, `BY6.DE`). */
/* Vlastní proxy (např. Cloudflare Worker) z Nastavení. Veřejné CORS proxy bývají
   zablokované rozšířeními nebo DNS filtrem a Yahoo z evropských IP často vyžaduje
   souhlas s cookies – vlastní proxy obojí obchází a je spolehlivá. Očekává se adresa,
   na kterou se připojí cílové URL (…/?url= nebo …/ – doplní se automaticky). */
let customProxy = '';
export function setCustomProxy(url){ customProxy = (url || '').trim(); }
function customGateway(){
  if(!customProxy) return null;
  const base = customProxy;
  return {
    name: 'vlastní proxy',
    wrap: u => base.includes('?') ? base + encodeURIComponent(u)
                                  : base.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(u)
  };
}

/* Ověřeno v anonymním okně (bez rozšíření), co které cesty dělají:
     přímo q1/q2   – „Failed to fetch": Yahoo z prohlížeče CORS hlavičky neposílá,
                     přímá cesta je tedy slepá (necháváme ji, selže během ms)
     corsproxy.io  – HTTP 401, chce registraci
     cors.lol      – nedostupné, whateverorigin – vrací HTML místo dat (mrtvé)
     allorigins /
     codetabs      – fungují, ale jsou POMALÉ → potřebují delší limit (viz `slow`)
   Spolehlivé je jen vlastní proxy z Nastavení (Cloudflare Worker). */
const YAHOO_GATEWAYS = [
  // Yahoo má dva rovnocenné hostitele – když jeden omezí provoz, druhý často jede dál.
  { name: 'přímo q1', wrap: u => u },
  { name: 'přímo q2', wrap: u => u.replace('query1.', 'query2.') },
  { name: 'allorigins', slow: true, wrap: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  // /get vrací JSON obálku {contents:"<tělo jako text>"} – jiná cesta přes stejnou službu,
  // hodí se, když /raw zlobí.
  { name: 'allorigins/get', slow: true, wrap: u => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u),
    unwrap: d => (d && typeof d.contents === 'string') ? JSON.parse(d.contents) : d },
  { name: 'codetabs', slow: true, wrap: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
  // Veřejný Cloudflare Worker (stejný princip jako ten, co si jde postavit v Nastavení).
  { name: 'cors.workers.dev', slow: true, wrap: u => 'https://test.cors.workers.dev/?' + u },
];
const SLOW_TIMEOUT_MS = 20000;
/* POZOR na velikost odpovědi: rok denních dat je ~50–100 kB na titul a veřejné proxy
   to nestíhaly přenést (padalo to na časový limit). Pro CENU proto stahujeme jen pár
   dní (pár kB) a celý rok až při rozkliknutí grafu. */
const yahooUrl = (symbol, range) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  + `?range=${range || '5d'}&interval=1d`;

/* ---------- Diagnostika ----------
   Když ceny nejdou, je potřeba vidět, CO přesně která cesta vrátila – jinak se to hádá
   přes screenshoty. Poslední pokusy si proto držíme a `priceDiagnostics()` je vydá do
   panelu na stránce (tlačítko „Diagnostika" u aktualizace cen). */
let diagLog = [];
export function priceDiagnostics(){ return diagLog.slice(); }
function diagReset(){ diagLog = []; }
function diagAdd(entry){
  diagLog.push({ ...entry, at: Date.now() });
  if(diagLog.length > 80) diagLog.shift();
}

function badSymbol(msg){
  const e = new Error(msg);
  e.symbolIssue = true; // chyba dat, ne spojení – zkoušet další proxy nemá smysl
  return e;
}

/** Jedním dotazem cena + roční denní historie přes jednu bránu. { price, currency, points } */
async function fetchYahooVia(gw, symbol, range){
  const t0 = Date.now();
  try {
    const r = await fetchYahooViaRaw(gw, symbol, range);
    diagAdd({ symbol, gateway: gw.name, ok: true, ms: Date.now() - t0,
      note: `${r.price} ${r.currency || '?'}, ${r.points.length} bodů` });
    return r;
  } catch(e){
    diagAdd({ symbol, gateway: gw.name, ok: false, ms: Date.now() - t0,
      note: (e.symbolIssue ? 'data: ' : '') + String(e.message || e) });
    throw e;
  }
}

async function fetchYahooViaRaw(gw, symbol, range){
  const raw = await fetchJson(gw.wrap(yahooUrl(symbol, range)), gw.slow ? SLOW_TIMEOUT_MS : TIMEOUT_MS);
  const data = gw.unwrap ? gw.unwrap(raw) : raw;
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if(!r){
    const status = data && data.__httpStatus;
    // Yahoo hlásí problémy dvěma různými tvary a splést si je stálo hodně času:
    //   chart.error   = titul neexistuje → má smysl zkusit jinou burzu
    //   finance.error = dotaz odmítnut (401 Invalid Cookie/Crumb, souhlas s cookies
    //                   v EU, 429 limit) → jiná burza nepomůže, je potřeba jiná cesta
    const fin = data && data.finance && data.finance.error;
    if(fin) throw new Error('Yahoo dotaz odmítl: ' + (fin.description || fin.code || '?')
      + (status ? ' (HTTP ' + status + ')' : ''));
    const ch = data && data.chart && data.chart.error;
    if(ch) throw badSymbol(ch.description || ch.code || 'symbol nenalezen');
    if(status && status >= 400) throw new Error('HTTP ' + status);
    throw new Error('neznámá odpověď: ' + JSON.stringify(data).slice(0, 140));
  }
  const meta = r.meta || {};
  const stamps = r.timestamp || [];
  const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] || {}).close || [];
  const points = stamps
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter(p => typeof p.c === 'number');
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice
    : (points.length ? points[points.length - 1].c : null);
  if(price == null) throw badSymbol('odpověď bez ceny');
  return { price, currency: meta.currency || null, points };
}

/** Nejčastější příčina neznámého tickeru: chybí přípona burzy (RHM.DE, HO.PA…). */
function unknownSymbolMsg(symbol, detail){
  const hint = symbol.includes('.') ? '' : ' – doplň příponu burzy, např. ' + symbol + '.DE';
  return 'Yahoo nezná ticker "' + symbol + '"' + hint + (detail ? ' (' + detail + ')' : '');
}

/** Zkusí zadané brány NAJEDNOU a vezme první, která odpoví. */
async function fetchYahooRace(symbol, gws, range){
  try {
    const r = await Promise.any(gws.map(gw => fetchYahooVia(gw, symbol, range).then(v => ({ gw, v }))));
    rememberGateway(r.gw.name);
    return r.v;
  } catch(agg){
    const errs = (agg && agg.errors) || [agg];
    // Odpověď dorazila, ale Yahoo ten ticker nezná → jiná brána to nespraví.
    const bad = errs.find(e => e && e.symbolIssue);
    if(bad) throw badSymbol(bad.message);
    throw new Error(gws.map((gw, i) => `${gw.name}: ${(errs[i] && errs[i].message) || errs[i]}`).join('; '));
  }
}

/* Která brána naposledy fungovala. Bez toho se při každém načtení čeká, až vyprší limit
   u nefunkční cesty (typicky přímé volání, které prohlížeč zablokuje kvůli CORS).
   S poznamenaným vítězem stačí na symbol jediný dotaz. */
const YAHOO_GW_KEY = 'portfolio-yahoo-gateway-v1';
function rememberGateway(name){
  try { localStorage.setItem(YAHOO_GW_KEY, name); } catch(e){}
}
function preferredGateway(){
  try {
    const name = localStorage.getItem(YAHOO_GW_KEY);
    return allGateways().find(g => g.name === name) || null;
  } catch(e){ return null; }
}

/** Cena + roční historie jednoho tickeru. Osvědčená brána, jinak všechny naráz. */
function allGateways(){
  const mine = customGateway();
  return mine ? [mine, ...YAHOO_GATEWAYS] : YAHOO_GATEWAYS;
}

async function fetchYahooSymbol(symbol, range){
  const pref = preferredGateway();
  let firstErr = null;
  if(pref){
    try {
      return await fetchYahooRace(symbol, [pref], range);
    } catch(e){
      if(e && e.symbolIssue) throw e;
      firstErr = e;
    }
  }
  const rest = allGateways().filter(g => g !== pref);
  try {
    return await fetchYahooRace(symbol, rest, range);
  } catch(e){
    if(e && e.symbolIssue) throw e;
    throw new Error('Yahoo se nepodařilo načíst – přímo ani přes proxy ('
      + (firstErr ? firstErr.message + '; ' : '') + e.message + ')');
  }
}

/* ---------- Náhradní burzy ----------
   Tentýž titul bývá na Yahoo jen na některém parkete: BYD se v Německu obchoduje spíš
   ve Frankfurtu/Stuttgartu než na XETRA, takže „BY6.DE" nemusí existovat, i když
   „BY6.F" ano. Když Yahoo ticker nezná, zkusíme sourozenecké burzy téhož titulu –
   jde o stejnou akcii ve stejné měně, jen jiné místo obchodování. */
const VENUE_ALTS = {
  '.DE': ['.F', '.SG', '.BE', '.MU', '.DU', '.HM'],   // Německo: XETRA × regionální burzy
  '.F':  ['.DE', '.SG', '.BE', '.MU', '.DU', '.HM'],
  '.SG': ['.DE', '.F', '.BE', '.MU'],
  '.MI': ['.F', '.DE'],                                // Milán → německé listingy
  '.MC': ['.F', '.DE'],                                // Madrid
  '.PA': ['.F', '.DE'],                                // Paříž
  '.ST': ['.F', '.DE'],                                // Stockholm
};
/* Která burza u daného tickeru zabrala. Bez toho by se při každé obnově znovu ptalo na
   symbol, o kterém už víme, že ho Yahoo nezná (a k tomu na všechny náhradní burzy). */
const ALIAS_KEY = 'portfolio-symbol-alias-v1';
function loadAliases(){
  try { return JSON.parse(localStorage.getItem(ALIAS_KEY)) || {}; } catch(e){ return {}; }
}
function saveAliases(map){
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(map)); } catch(e){}
}
function rememberAlias(from, to){
  const map = loadAliases();
  if(map[from] === to) return;
  map[from] = to;
  saveAliases(map);
}
function forgetAlias(from){
  const map = loadAliases();
  if(!(from in map)) return;
  delete map[from];
  saveAliases(map);
}

function venueAlternatives(symbol){
  const dot = symbol.lastIndexOf('.');
  if(dot < 1) return [];
  const base = symbol.slice(0, dot), suffix = symbol.slice(dot).toUpperCase();
  return (VENUE_ALTS[suffix] || []).map(s => base + s);
}

/** Cena + roční historie. Když Yahoo ticker nezná, zkusí stejný titul na jiné burze. */
async function fetchYahoo(symbol, range){
  // 1) Burza, která u tohohle tickeru zabrala minule.
  const alias = loadAliases()[symbol];
  if(alias && alias !== symbol){
    try {
      return { ...await fetchYahooSymbol(alias, range), usedSymbol: alias };
    } catch(e){
      if(!e || !e.symbolIssue) throw e;
      forgetAlias(symbol); // přestala platit, zkus to znovu od začátku
    }
  }

  // 2) Ticker tak, jak je uložený u pozice.
  let firstErr;
  try {
    const r = await fetchYahooSymbol(symbol, range);
    forgetAlias(symbol);
    return { ...r, usedSymbol: symbol };
  } catch(e){
    if(!e || !e.symbolIssue) throw e;
    firstErr = e;
  }

  // 3) Tentýž titul na jiné burze.
  const alts = venueAlternatives(symbol);
  if(!alts.length) throw new Error(unknownSymbolMsg(symbol, firstErr.message));
  try {
    const r = await Promise.any(alts.map(alt =>
      fetchYahooSymbol(alt, range).then(v => ({ ...v, usedSymbol: alt }))));
    rememberAlias(symbol, r.usedSymbol);
    return r;
  } catch(agg){
    throw new Error(unknownSymbolMsg(symbol, firstErr.message)
      + ' – nepomohly ani jiné burzy (' + alts.join(', ') + ')');
  }
}

/* Twelve Data – záloha, když Yahoo selže. Vrací mapu symbol -> { price } | { error }. */
async function fetchStockPricesTwelveData(symbols, apiKey){
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
    data = await fetchJson(url);
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

/** Ceny akcií: Yahoo (zdarma, pokrývá evropské burzy), Twelve Data až jako záloha.
   Symboly se stahují PARALELNĚ a u každého se závodí o nejrychlejší bránu, takže
   načtení trvá nejvýš jeden časový limit, ne (počet symbolů × počet bran). */
async function fetchStockPrices(symbols, apiKey){
  const out = {};
  if(!symbols.length) return out;
  diagReset();

  const results = await Promise.all(symbols.map(sym =>
    fetchYahoo(sym).then(y => ({ sym, y }), e => ({ sym, e }))));
  const missing = [];
  results.forEach(({ sym, y, e }) => {
    if(y){
      out[sym] = { price: y.price, currency: y.currency };
      // Cena přišla z jiné burzy, než jaká je u pozice uložená – ať je to vidět.
      if(y.usedSymbol && y.usedSymbol !== sym) out[sym].altSymbol = y.usedSymbol;
    } else {
      missing.push({ sym, error: String(e.message || e) });
    }
  });
  if(!missing.length) return out;

  // Záloha přes Twelve Data (jen když je klíč; jinak vrať chybu z Yahoo).
  if(!apiKey){
    missing.forEach(m => { out[m.sym] = { error: m.error }; });
    return out;
  }
  const td = await fetchStockPricesTwelveData(missing.map(m => m.sym), apiKey);
  missing.forEach(m => {
    const r = td[m.sym];
    out[m.sym] = (r && r.price != null) ? r
      : { error: m.error + (r && r.error ? ' · záložní Twelve Data taky ne' : ''), local: !!(r && r.local) };
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
      const rate = src.pick(await fetchJson(src.url(from, to), 6000), to);
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

/* Akcie se cachují jen podle symbolu (Yahoo posílá cenu v měně burzy, ne v měně pozice),
   krypto podle symbolu a měny (CoinGecko umí vrátit řadu rovnou v CZK). */
function historyKey(position){
  return position.type === 'krypto'
    ? `krypto:${position.symbol}:${position.currency || 'CZK'}`
    : `akcie:${position.symbol}`;
}

async function fetchCryptoHistory(id, currency){
  const vs = (currency || 'CZK').toLowerCase();
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`
    + `?vs_currency=${vs}&days=365&interval=daily`;
  const data = await fetchJson(url);
  if(!data || !Array.isArray(data.prices)) throw new Error('CoinGecko: chybí data');
  const points = data.prices.map(([t, c]) => ({ t, c })).filter(p => typeof p.c === 'number');
  return { points, currency: (currency || 'CZK') };
}

/* Twelve Data – záloha historie, když Yahoo selže (stojí 1 kredit za symbol). */
async function fetchStockHistoryTwelveData(symbol, apiKey){
  if(!apiKey) throw new Error('Chybí API klíč pro akcie (vlož ho v Nastavení)');
  const cool = cooldownLeftMs();
  if(cool > 0) throw new Error(`Limit Twelve Data vyčerpán, zkus to za ${Math.ceil(cool / 1000)} s`);
  if(spentLastMinute() + 1 > CREDIT_LIMIT_PER_MIN - CREDIT_RESERVE){
    throw new Error('Šetřím kredity Twelve Data (limit 8/min), zkus to za chvíli');
  }
  recordCredits(1);

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}`
    + `&interval=1day&outputsize=400&apikey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
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

/** Historie akcie: nejdřív Yahoo (stejný dotaz jako cena), Twelve Data jen jako záloha. */
async function fetchStockHistory(symbol, apiKey){
  let firstErr;
  try {
    const y = await fetchYahoo(symbol, '1y');
    if(y.points && y.points.length > 2) return { points: y.points, currency: y.currency };
    firstErr = new Error('Yahoo nevrátil dost dat pro graf');
  } catch(e){
    firstErr = e;
  }
  if(!apiKey) throw firstErr;
  try {
    return { points: await fetchStockHistoryTwelveData(symbol, apiKey), currency: null };
  } catch(e){
    throw new Error(String(firstErr.message || firstErr) + ' · Twelve Data: ' + String(e.message || e));
  }
}

/** Historie ceny pozice (rok denních dat). Vrací { points, currency } nebo { error }. */
export async function fetchPriceHistory(position, apiKey){
  const key = historyKey(position);
  const cache = loadHistoryCache();
  const hit = cache[key];
  if(hit && hit.points && (Date.now() - hit.at) < HISTORY_TTL_MS){
    return { points: hit.points, currency: hit.currency || null, cached: true, at: hit.at };
  }
  try {
    const r = position.type === 'krypto'
      ? await fetchCryptoHistory(position.symbol, position.currency)
      : await fetchStockHistory(position.symbol, apiKey);
    if(!r.points.length) throw new Error('Zdroj nevrátil žádná data');
    cache[key] = { points: r.points, currency: r.currency || null, at: Date.now() };
    saveHistoryCache(cache);
    return { points: r.points, currency: r.currency || null, at: Date.now() };
  } catch(e){
    // Radši ukaž starší graf než nic.
    if(hit && hit.points){
      return { points: hit.points, currency: hit.currency || null, cached: true, at: hit.at, error: String(e.message || e) };
    }
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
      if(r && r.price != null) auto = { priceNative: r.price, currency: r.currency || p.currency, altSymbol: r.altSymbol };
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
