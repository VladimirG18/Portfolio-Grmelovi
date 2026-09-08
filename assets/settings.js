/* Sdílené nastavení (Firestore) – zatím jen API klíč pro ceny akcií/ETF (Twelve Data),
   ať ho nemusí zadávat každý zvlášť ve svém prohlížeči. Ukládá se do stejné databáze
   jako pozice (portfolio_pozice) – kdo vidí web, vidí i tohle; klíč je jen na čtení cen,
   žádná platba se přes něj neprovádí. Lokální localStorage slouží jen jako rychlý
   fallback, když je Firestore zrovna nedostupný. */
import { firebaseConfig } from './firebase-config.js?v=__CACHEBUST__';

const SETTINGS_COLLECTION = 'portfolio_nastaveni';
const SETTINGS_DOC = 'sdilene';
const LOCAL_FALLBACK_KEY = 'portfolio-td-key';
const LOCAL_PROXY_KEY = 'portfolio-cors-proxy';

let dbPromise = null;
async function getDb(){
  if(!dbPromise){
    dbPromise = (async () => {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const app = initializeApp(firebaseConfig);
      return getFirestore(app);
    })();
  }
  return dbPromise;
}

function readLocalFallback(){
  try { return localStorage.getItem(LOCAL_FALLBACK_KEY) || ''; } catch(e){ return ''; }
}

/** Zavolá cb(key) hned s aktuální hodnotou a pak znovu při každé změně. */
export async function subscribeStockApiKey(cb){
  const useFirebase = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey.length > 10;
  if(!useFirebase){ cb(readLocalFallback()); return; }
  try {
    const { doc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = await getDb();
    onSnapshot(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC), snap => {
      const key = snap.exists() ? (snap.data().twelveDataKey || '') : '';
      try { localStorage.setItem(LOCAL_FALLBACK_KEY, key); } catch(e){}
      cb(key);
    }, err => {
      console.error(err);
      cb(readLocalFallback());
    });
  } catch(e){
    console.error(e);
    cb(readLocalFallback());
  }
}

/* Vlastní CORS proxy (viz §4e v CLAUDE.md) – sdílená stejně jako klíč, ať ji nemusí
   zadávat oba. Je to jen adresa proxy, žádné tajemství. */
function readLocalProxy(){
  try { return localStorage.getItem(LOCAL_PROXY_KEY) || ''; } catch(e){ return ''; }
}

export async function subscribeSettings(cb){
  const useFirebase = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey.length > 10;
  if(!useFirebase){ cb({ twelveDataKey: readLocalFallback(), corsProxy: readLocalProxy() }); return; }
  try {
    const { doc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = await getDb();
    onSnapshot(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC), snap => {
      const d = snap.exists() ? snap.data() : {};
      const out = { twelveDataKey: d.twelveDataKey || '', corsProxy: d.corsProxy || '' };
      try {
        localStorage.setItem(LOCAL_FALLBACK_KEY, out.twelveDataKey);
        localStorage.setItem(LOCAL_PROXY_KEY, out.corsProxy);
      } catch(e){}
      cb(out);
    }, err => {
      console.error(err);
      cb({ twelveDataKey: readLocalFallback(), corsProxy: readLocalProxy() });
    });
  } catch(e){
    console.error(e);
    cb({ twelveDataKey: readLocalFallback(), corsProxy: readLocalProxy() });
  }
}

export async function saveCorsProxy(url){
  const trimmed = (url || '').trim();
  try { localStorage.setItem(LOCAL_PROXY_KEY, trimmed); } catch(e){}
  const useFirebase = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey.length > 10;
  if(!useFirebase) return;
  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const db = await getDb();
  await setDoc(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC), { corsProxy: trimmed }, { merge: true });
}

export async function saveStockApiKey(key){
  const trimmed = (key || '').trim();
  try { localStorage.setItem(LOCAL_FALLBACK_KEY, trimmed); } catch(e){}
  const useFirebase = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey.length > 10;
  if(!useFirebase) return;
  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const db = await getDb();
  await setDoc(doc(db, SETTINGS_COLLECTION, SETTINGS_DOC), { twelveDataKey: trimmed }, { merge: true });
}
