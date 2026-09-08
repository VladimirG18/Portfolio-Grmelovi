/* Živá cena kryptoměn – burzy ji dávají zdarma a bez klíče.

   Proč zvlášť a ne přes prices.js: tohle není dotaz–odpověď, ale trvalé spojení.
   Burza sama pošle novou cenu, jakmile se změní (klidně několikrát za sekundu), takže
   se na nic neptáme každých pár vteřin. WebSocket navíc nepodléhá CORS, což je u
   statického webu bez backendu velká výhoda – odpadá trápení s proxy jako u akcií.

   Zdroje se zkoušejí popořadě, první funkční vyhrává:
     1. Coinmate  – česká burza, cena rovnou v CZK (REST, dotaz po 10 s – WebSocket
                    mají přes Pusher a nestojí to za tu závislost)
     2. Kraken    – WebSocket v2, BTC/EUR
     3. Binance   – WebSocket, BTCEUR
   Když neprojde žádný, stránka dál funguje na běžném stahování cen (CoinGecko). */

const FIRST_PRICE_TIMEOUT_MS = 8000;
const POLL_MS = 10000;
const RECONNECT_DELAYS = [2000, 5000, 15000, 30000];

/* Páry podle CoinGecko id (to je to, co máme uložené u pozice). */
const PAIRS = {
  bitcoin:  { coinmate: 'BTC_CZK', kraken: 'BTC/EUR', binance: 'btceur' },
  ethereum: { coinmate: 'ETH_CZK', kraken: 'ETH/EUR', binance: 'etheur' },
  litecoin: { coinmate: 'LTC_CZK', kraken: 'LTC/EUR', binance: 'ltceur' },
  solana:   {                      kraken: 'SOL/EUR', binance: 'soleur' },
};

const num = v => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return (typeof n === 'number' && isFinite(n) && n > 0) ? n : null;
};

/* ---------- Coinmate (REST, cena v korunách) ---------- */
function coinmateSource(pair){
  return {
    name: 'Coinmate',
    currency: 'CZK',
    async start(onPrice){
      const url = `https://coinmate.io/api/ticker?currencyPair=${encodeURIComponent(pair)}`;
      const tick = async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FIRST_PRICE_TIMEOUT_MS);
        try {
          const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
          if(!res.ok) throw new Error('HTTP ' + res.status);
          const d = await res.json();
          const price = num((d && d.data && d.data.last) != null ? d.data.last : (d && d.last));
          if(price == null) throw new Error('odpověď bez ceny');
          onPrice(price);
        } finally { clearTimeout(timer); }
      };
      await tick(); // první dotaz musí projít, jinak se zkusí další zdroj
      const id = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
      return () => clearInterval(id);
    }
  };
}

/* ---------- WebSocket burzy ---------- */
function wsSource({ name, currency, url, subscribe, parse }){
  return {
    name, currency,
    start(onPrice){
      return new Promise((resolve, reject) => {
        let ws, settled = false;
        const timer = setTimeout(() => {
          if(settled) return;
          settled = true;
          try { ws.close(); } catch(e){}
          reject(new Error(`${name}: první cena nepřišla do ${FIRST_PRICE_TIMEOUT_MS / 1000} s`));
        }, FIRST_PRICE_TIMEOUT_MS);

        try { ws = new WebSocket(url); } catch(e){ clearTimeout(timer); reject(e); return; }

        ws.addEventListener('open', () => { if(subscribe) ws.send(JSON.stringify(subscribe)); });
        ws.addEventListener('message', ev => {
          let price = null;
          try { price = parse(JSON.parse(ev.data)); } catch(e){ return; }
          if(price == null) return;
          onPrice(price);
          if(!settled){
            settled = true;
            clearTimeout(timer);
            resolve(() => { try { ws.close(); } catch(e){} });
          }
        });
        const fail = () => {
          if(settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(name + ': spojení se nepodařilo navázat'));
        };
        ws.addEventListener('error', fail);
        ws.addEventListener('close', fail);
      });
    }
  };
}

function sourcesFor(symbol){
  const p = PAIRS[symbol];
  if(!p) return [];
  const out = [];
  if(p.coinmate) out.push(coinmateSource(p.coinmate));
  if(p.kraken) out.push(wsSource({
    name: 'Kraken', currency: 'EUR', url: 'wss://ws.kraken.com/v2',
    subscribe: { method: 'subscribe', params: { channel: 'ticker', symbol: [p.kraken] } },
    parse: m => (m && m.channel === 'ticker' && Array.isArray(m.data) && m.data[0])
      ? num(m.data[0].last) : null
  }));
  if(p.binance) out.push(wsSource({
    name: 'Binance', currency: 'EUR',
    url: `wss://stream.binance.com:9443/ws/${p.binance}@ticker`,
    parse: m => (m && m.c != null) ? num(m.c) : null
  }));
  return out;
}

/** Umí tenhle symbol živou cenu? */
export function hasLiveSource(symbol){ return !!PAIRS[symbol]; }

/**
 * Spustí živou cenu pro jeden symbol (CoinGecko id).
 * onPrice({ price, currency, source }) se volá při každé změně ceny.
 * onStatus({ live, source, error }) hlásí, jestli spojení stojí.
 * Vrací funkci pro zastavení.
 */
export function startLivePrice(symbol, onPrice, onStatus = () => {}){
  const sources = sourcesFor(symbol);
  let stopped = false, stopCurrent = null, attempt = 0;

  async function connect(){
    if(stopped) return;
    const problems = [];
    for(const src of sources){
      if(stopped) return;
      try {
        const stop = await src.start(price => {
          if(stopped) return;
          attempt = 0; // funguje – případný další výpadek začíná od nuly
          onPrice({ price, currency: src.currency, source: src.name });
        });
        if(stopped){ stop(); return; }
        stopCurrent = () => {
          stop();
          // Spadlé spojení zkus obnovit; při opakovaném neúspěchu to vzdej a nech
          // běžet obyčejné stahování cen, ať se stránka nezacyklí na mrtvé burze.
          if(stopped) return;
          const delay = RECONNECT_DELAYS[Math.min(attempt++, RECONNECT_DELAYS.length - 1)];
          if(attempt > RECONNECT_DELAYS.length){
            onStatus({ live: false, error: 'spojení opakovaně padá' });
            return;
          }
          onStatus({ live: false, error: 'spojení vypadlo, zkouším znovu' });
          setTimeout(connect, delay);
        };
        onStatus({ live: true, source: src.name });
        return;
      } catch(e){
        problems.push(String(e.message || e));
      }
    }
    onStatus({ live: false, error: problems.join('; ') });
  }

  connect();
  return () => {
    stopped = true;
    const stop = stopCurrent;
    stopCurrent = null;
    if(stop) stop();
  };
}
