/* Stahování aktuálních cen – kryptoměny (CoinGecko, bez klíče) a akcie/ETF
   (Twelve Data, potřebuje API klíč – spravuje se sdíleně přes assets/settings.js).
   Kurzy měn (USD/EUR → CZK) přes Frankfurter (bez klíče). */

const FX_CACHE_STORAGE = 'portfolio-fx-cache-v1';

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
    symbols.forEach(s => { out[s] = { error: 'Chybí API klíč pro akcie (vlož ho v Nastavení)' }; });
    return out;
  }

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

/* ---------- Kurzy měn (Frankfurter) ---------- */
async function fetchFxRate(from, to){
  if(from === to) return 1;
  let cache = {};
  try { cache = JSON.parse(sessionStorage.getItem(FX_CACHE_STORAGE)) || {}; } catch(e){}
  const key = from + '_' + to;
  const now = Date.now();
  if(cache[key] && (now - cache[key].ts) < 15 * 60 * 1000) return cache[key].rate;

  const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  if(!res.ok) throw new Error('Frankfurter HTTP ' + res.status);
  const data = await res.json();
  const rate = data.rates && data.rates[to];
  if(typeof rate !== 'number') throw new Error('Chybí kurz ' + key);
  cache[key] = { rate, ts: now };
  try { sessionStorage.setItem(FX_CACHE_STORAGE, JSON.stringify(cache)); } catch(e){}
  return rate;
}

export async function convertToCZK(amount, currency){
  if(!currency || currency === 'CZK') return amount;
  const rate = await fetchFxRate(currency, 'CZK');
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
    let auto = null, error = null;
    if(p.type === 'krypto'){
      const price = cryptoPrices[p.symbol];
      if(price != null) auto = { priceNative: price, currency: 'CZK' };
      else error = cryptoErr || 'Symbol nenalezen na CoinGecko';
    } else {
      const r = stockResults[p.symbol];
      if(r && r.price != null) auto = { priceNative: r.price, currency: p.currency };
      else error = (r && r.error) || stockErr || 'Symbol nenalezen';
    }

    if(auto){ out[p.id] = auto; return; }

    // Automatická cena nedostupná – použij ručně zadanou, pokud u pozice je.
    if(p.manualPrice != null && !isNaN(p.manualPrice)){
      out[p.id] = { priceNative: p.manualPrice, currency: p.currency, manual: true, error };
    } else {
      out[p.id] = { priceNative: null, currency: p.currency, error };
    }
  });

  return out;
}
