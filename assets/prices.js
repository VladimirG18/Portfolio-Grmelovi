/* Stahování aktuálních cen – kryptoměny (CoinGecko, bez klíče) a akcie/ETF
   (Twelve Data, potřebuje vlastní zdarma API klíč, viz nastaveni.html).
   Kurzy měn (USD/EUR → CZK) přes Frankfurter (bez klíče). */

const TD_KEY_STORAGE = 'portfolio-td-key';
const FX_CACHE_STORAGE = 'portfolio-fx-cache-v1';

export function getStockApiKey(){
  try { return localStorage.getItem(TD_KEY_STORAGE) || ''; } catch(e){ return ''; }
}
export function setStockApiKey(key){
  try { localStorage.setItem(TD_KEY_STORAGE, key.trim()); } catch(e){}
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

/* ---------- Akcie / ETF (Twelve Data) ---------- */
async function fetchStockPrices(symbols, apiKey){
  if(!symbols.length || !apiKey) return {};
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Twelve Data HTTP ' + res.status);
  const data = await res.json();
  const out = {};
  if(symbols.length === 1){
    if(data && data.price && !data.code) out[symbols[0]] = parseFloat(data.price);
  } else {
    symbols.forEach(sym => {
      const d = data[sym];
      if(d && d.price && !d.code) out[sym] = parseFloat(d.price);
    });
  }
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
 * Vrací mapu id -> { priceNative, currency, error }
 * U krypta je "currency" vždy 'CZK' (cena rovnou v CZK).
 * U akcií je cena v měně pozice (currency z formuláře) – ber to jako
 * nejlepší dostupný odhad, Twelve Data konverzi měny nedělá.
 */
export async function fetchAllPrices(positions){
  const out = {};
  const cryptoIds = [...new Set(positions.filter(p => p.type === 'krypto').map(p => p.symbol))];
  const stockSymbols = [...new Set(positions.filter(p => p.type === 'akcie').map(p => p.symbol))];
  const apiKey = getStockApiKey();

  const [cryptoRes, stockRes] = await Promise.allSettled([
    fetchCryptoPrices(cryptoIds),
    fetchStockPrices(stockSymbols, apiKey)
  ]);

  const cryptoPrices = cryptoRes.status === 'fulfilled' ? cryptoRes.value : {};
  const stockPrices = stockRes.status === 'fulfilled' ? stockRes.value : {};
  const cryptoErr = cryptoRes.status === 'rejected' ? String(cryptoRes.reason) : null;
  const stockErr = stockRes.status === 'rejected' ? String(stockRes.reason) : null;

  positions.forEach(p => {
    if(p.type === 'krypto'){
      const price = cryptoPrices[p.symbol];
      out[p.id] = price != null
        ? { priceNative: price, currency: 'CZK' }
        : { priceNative: null, currency: 'CZK', error: cryptoErr || 'Symbol nenalezen na CoinGecko' };
    } else {
      if(!apiKey){
        out[p.id] = { priceNative: null, currency: p.currency, error: 'Chybí API klíč pro akcie (nastav ho v Nastavení)' };
      } else {
        const price = stockPrices[p.symbol];
        out[p.id] = price != null
          ? { priceNative: price, currency: p.currency }
          : { priceNative: null, currency: p.currency, error: stockErr || 'Symbol nenalezen' };
      }
    }
  });

  return out;
}
