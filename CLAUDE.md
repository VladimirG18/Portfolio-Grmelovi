# CLAUDE.md — pracovní kontext pro AI asistenta

> Uživatel je česky mluvící (rodina Grmelových, tento web sdílí Vladimír s manželkou).
> **Odpovídej česky.** Web je statický, na GitHub Pages. Sourozenecký projekt k
> `RD-Modrice-Grmelovi-public` (dům) – stejný přístup k práci a nasazení, jen jiný obsah.

---

## 1) Co web je

Sdílený přehled rodinních investic (akcie, ETF, kryptoměny) – kolik toho mají, za kolik
to koupili a kolik to je teď hodnotné (ceny se stahují automaticky). Chráněno jednoduchým
heslem na klientovi (viz §4) – **není to skutečné zabezpečení**, jen odradí náhodné
návštěvníky. Skutečná citlivá data (přesné částky) proto ber vážně i tak – neposílej je
nikam navíc a nepiš je do commit zpráv/PR popisů.

## 2) Jak se nasazuje

Statický web na **GitHub Pages**, nasazuje se přes GitHub Actions workflow
`.github/workflows/deploy.yml` (`actions/configure-pages` + `upload-pages-artifact` +
`deploy-pages`) – spustí se automaticky při pushi do `main`. Žádné PR není potřeba
(jednouživatelský/rodinný projekt), lze pushovat rovnou do `main`, pokud uživatel
neřekne jinak. Po pushi ověř run workflow "Deploy static site to GitHub Pages" přes
GitHub MCP (`actions_list`/`actions_get`, `branch:main`) – má trvat do 1–2 minut.

**Cache-busting**: všechny lokální `<script src>`/`<link href>` v HTML a lokální ES
module importy (`from './xxx.js'`) mají v URL `?v=__CACHEBUST__`. Workflow krok
"Cache-bust local assets" tenhle placeholder při každém deploy nahradí za `github.sha`
(`sed` přes všechny `*.html`/`*.js`), takže po každé změně JS/CSS dostane návštěvník
automaticky čerstvou verzi, aniž by musel ručně mazat cache/dělat hard refresh. Když
přidáš novou stránku nebo nový lokální `<script>`/`import`, **nezapomeň k němu taky
připsat `?v=__CACHEBUST__`** – jinak se ten konkrétní soubor bude cachovat postaru a
uživatel po aktualizaci uvidí nekonzistentní směs starého a nového JS (přesně tenhle bug
se stal – hotovost/historie se nezobrazovaly správně, dokud uživatel neudělal ruční
hard refresh).

Web: `https://vladimirg18.github.io/Portfolio-Grmelovi/`

## 3) Struktura

- `index.html` – dashboard: statistiky (hodnota/vloženo/zisk), alokační donut graf,
  tabulka pozic s formulářem pro přidání/úpravu/smazání.
- `nastaveni.html` – nastavení API klíče pro ceny akcií/ETF (Twelve Data).
- `assets/style.css` – design systém (světlý/tmavý režim), vychází ze stejného systému
  jako RD Modřice, jen s vlastními accent/series barvami.
- `assets/site.js` – přepínač vzhledu + aktivní odkaz v nav (storage klíč `portfolio-theme`).
- `assets/gate.js` – heslová brána (SHA-256 hash hesla zašitý v souboru, porovnává se přes
  Web Crypto API, `localStorage` klíč `portfolio-unlock-v1`). **Změna hesla**: spočítej nový
  SHA-256 hash (`python3 -c "import hashlib;print(hashlib.sha256(b'NOVE_HESLO').hexdigest())"`)
  a nahraď konstantu `HASH` v `assets/gate.js`. Navíc volitelně **WebAuthn biometrie** (otisk/Face
  ID/Windows Hello) – po prvním zadání hesla na daném zařízení se nabídne registrace
  (`navigator.credentials.create`, `authenticatorAttachment:'platform'`), credential id se uloží
  do `localStorage` (`portfolio-webauthn-cred-v1`) a při dalších návštěvách se nabídne tlačítko
  pro odemčení biometrií (`navigator.credentials.get`) – vždy jen jako lokální náhrada hesla na
  tom jednom zařízení, bez serveru není co ověřovat vůči útočníkovi, takže bezpečnostně na stejné
  úrovni jako heslo. Reset per zařízení: `nastaveni.html` → "Zapomenout biometrii" (volá
  `window.portfolioForgetBiometric()` z gate.js).
- `assets/firebase-config.js` – **stejný Firebase projekt jako RD Modřice** (`rd-modrice-e9477`),
  nové kolekce `portfolio_pozice` a `portfolio_nastaveni`. Firestore pravidla jsou u tohoto
  projektu nastavená obecně (ne po jednotlivých vyjmenovaných kolekcích) – ověřeno zápisem
  přes REST API, nové kolekce fungují bez jakékoli úpravy pravidel.
- `assets/settings.js` – sdílené nastavení (Firestore kolekce `portfolio_nastaveni`, dokument
  `sdilene`), zatím jen pole `twelveDataKey` (API klíč pro ceny akcií/ETF). Zadá se jednou na
  `nastaveni.html` a od té chvíle ho vidí a používá kdokoli, kdo otevře stránku (stejná databáze
  jako pozice) – nemusí ho zadávat každý zvlášť. `localStorage` slouží jen jako rychlý fallback,
  když je Firestore zrovna nedostupný.
- `assets/prices.js` – stahování cen: kryptoměny přes CoinGecko (bez klíče, `vs_currencies=czk`),
  akcie/ETF přes Twelve Data (`fetchAllPrices(positions, apiKey)` – klíč se předává jako parametr,
  bere se z `assets/settings.js`), kurzy měn přes Frankfurter (bez klíče).
- `assets/portfolio.js` – hlavní logika dashboardu: Firestore CRUD (kolekce `portfolio_pozice`),
  přihlášení k odběru sdíleného API klíče, přepočty na CZK, vykreslení tabulky a alokačního
  grafu (inline SVG donut).

## 4) Datový model pozice (Firestore `portfolio_pozice`)

```
{
  type: 'akcie' | 'krypto' | 'hotovost',
  symbol: string,       // ticker pro Twelve Data (akcie) nebo CoinGecko id (krypto);
                         // u hotovosti jen popisek (typicky = měna), cena se nefetchuje
  name: string,         // volitelný lidský název
  quantity: number,     // u hotovosti = částka
  avgBuyPrice: number,  // za kus, v měně "currency"; u hotovosti vždy 1
  currency: 'CZK'|'USD'|'EUR'|'GBP',
  manualPrice: number|null, // volitelná ručně zadaná aktuální cena za kus (v "currency");
                            // použije se JEN když automatická cena selže (viz §4c)
  note: string,
  ts: number,           // Date.now() při vytvoření (u historických importů = datum nákupu)

  // volitelně – uzavřená (prodaná) pozice, viz §4b:
  closed: boolean,
  sellPrice: number,    // za kus, v měně "currency"
  closedAt: number       // Date.now() při uzavření (u historických importů = datum prodeje)
}
```

Součty v dashboardu jsou vždy v CZK – cizí měny se přepočítávají aktuálním kurzem
(Frankfurter), ne historickým kurzem ke dni nákupu.

### 4a) Typ `hotovost`

Volný kapitál (peníze na účtu brokera, ještě nezainvestované) – nemá tiker, cena se
nefetchuje, `quantity` = přímo částka, `avgBuyPrice` je vždy `1`. Počítá se do "Aktuální
hodnoty" i "Vloženo" stejnou částkou (nulový zisk/ztráta), a má vlastní barvu v alokačním
grafu (`--series-3`). Formulář na `index.html` (`f-type` = `hotovost`) automaticky doplní
symbol podle zvolené měny a zamkne nákupní cenu na 1.

### 4b) Uzavřené (prodané) pozice – historie

Tlačítko 💰 u pozice (akcie/krypto, ne hotovost) v tabulce vyzve na prodejní cenu za kus
(`prompt()`) a nastaví `closed: true`, `sellPrice`, `closedAt` – `quantity`/`avgBuyPrice`
zůstávají jako historický nákupní záznam. Uzavřené pozice:
- **nepočítají se** do "Aktuální hodnoty" ani "Vloženo" v hlavním přehledu (viz
  `recompute()` v `assets/portfolio.js` – pro `closed` pozice se `valueCZK`/`investedCZK`
  nastaví na `null`),
- **nefetchují cenu** (vyřazené z `refreshPrices()`),
- zobrazují se ve zvlášní sekci "Historie uzavřených pozic" (`index.html`
  `#history-section`/`#history-body`, vykresluje `renderHistory()`) s realizovaným
  ziskem/ztrátou `quantity * (sellPrice - avgBuyPrice)`, přepočteným na CZK.
- Smazání řádku v historii (🗑) smaže celý záznam z Firestore – žádná "obnova" zpět na
  otevřenou pozici zatím není (kdyby bylo potřeba, jde ručně smazat pole `closed`/
  `sellPrice`/`closedAt` přes Firestore konzoli nebo REST).

### 4c) Chyby cen a ruční cena

`fetchStockPrices()` v `assets/prices.js` propouští **skutečnou hlášku z Twelve Data**
(např. neplatný ticker, symbol mimo tarif, vyčerpané kredity) až do tabulky, kde se
vypíše viditelně červeně (`.pricerr`) – dřív se schovávala do `title` tooltipu, který je
na mobilu nedostupný, takže uživatel viděl jen "chyba" a nedalo se to diagnostikovat.
**Nevracej se k tomu.**

Když automatická cena selže a pozice má vyplněné `manualPrice`, použije se ta a v tabulce
je označená popiskem "ručně zadaná". Automatická cena má vždy přednost (je čerstvější);
ruční je jen záchranná brzda pro tituly, které daný zdroj cen neumí.

### 4d) Kredity Twelve Data a cache cen (POZOR – tady se to už jednou rozbilo)

Twelve Data účtuje **1 kredit za každý symbol**, ne za dotaz, a free tarif má jen
**8 kreditů/minutu** (800/den). Uživatel drží 3 akcie → jedno stažení = 3 kredity.
Původní kód volal `refreshPrices()` několikrát po sobě (snapshot pozic + příchod klíče +
po každém zápisu), takže jedno otevření stránky spálilo 12 kreditů a API vracelo
`429 – You have run out of API credits for the current minute`.

Proto `assets/prices.js` má **vlastní hlídač kreditů** (`CREDIT_LIMIT_PER_MIN` 8 mínus
rezerva 2 → využívá max 6/min, log útraty v `localStorage` klíč `portfolio-td-credits-v1`):
když by se dotaz do rozpočtu nevešel, **vůbec se neodešle** a vrátí se hláška označená
`local: true`. Po odpovědi 429 se navíc nastaví cooldown (`portfolio-td-cooldown-v1`, 70 s).
Hlášky s `local: true` se **nikdy necachují** (není to odpověď API, jen náš stav).

A `refreshPrices()` v `assets/portfolio.js`:
- drží ceny v **localStorage cache** (`portfolio-price-cache-v1`, klíč `type:symbol:currency`),
  takže i reload stránky je zadarmo – TTL `PRICE_TTL_MS` (3 min), u chyb kratší
  `PRICE_ERR_TTL_MS` (45 s, ať se to po vyčerpání limitu samo zkusí znovu),
- stahuje **jen symboly, které v cache nejsou nebo jsou staré** (ne vždy všechny),
- má guard `priceFetchInFlight` proti souběžným dotazům,
- `force: true` (jen tlačítko "Aktualizovat ceny") obchází TTL.

**Nikdy nevolej `refreshPrices({force:true})` automaticky** (např. při příchodu API klíče) –
spálí to kredity při každém načtení. Stav "chybí API klíč" se schválně **necachuje**, takže
se ceny dotáhnou i běžným voláním, jakmile klíč dorazí.

**Neúspěšný pokus nesmí zahodit už načtenou cenu.** Jak v `pricesCache`, tak v localStorage
cache platí: když nový dotaz skončí chybou, poslední známá cena zůstává a jen se k ní
poznamená chyba (`staleError`, resp. `error`+`errAt`); v tabulce se pak ukáže cena
s poznámkou "z HH:MM" místo červené hlášky. Červená hláška je jen tam, kde žádná cena není.
(Bez tohohle spadla tabulka po kliknutí na aktualizaci z živých cen zpátky na ruční.)

V patičce se zobrazuje **verze nasazení** (7 znaků commit SHA, `assets/site.js` ji bere
z `<meta name="app-version">`) – při hlášení "nefunguje to" si tím ověř, jestli uživatel
nemá v prohlížeči starou verzi.

Pokud by v budoucnu hlášky ukázaly i omezení pokrytí burz (XETRA/Euronext/HKEX na free
tarifu), řeš to ručními cenami nebo jiným zdrojem – pozor, většina alternativ (Yahoo,
Stooq) nemá CORS a z čistě statického webu bez backendu je přímo nepoužiješ.

## 5) Známá omezení / co dodělat příště, když si to řeknou

- Twelve Data free tarif má rate limit (~8 req/min, 800/den) – při velkém počtu pozic
  zvážit dávkování nebo cache.
- Currency konverze je jen k okamžiku zobrazení, ne historická k datu nákupu (týká se i
  realizovaného zisku/ztráty u uzavřených pozic).
- Nemovitosti/spoření zatím nejsou v datovém modelu (uživatel zatím chtěl akcie/ETF,
  krypto a hotovost) – přidání by šlo jako další `type`.
- Heslo na stránce je jen klientská ochrana (viz §1) – při zvýšení nároků na soukromí
  zvážit přechod na Firebase Auth nebo private GitHub Pages (GitHub Pro).

## 6) Konvence

- Odpovídej **česky**, stručně a k věci.
- Commituj a nasazuj rovnou (push do `main`), po nasazení napiš, že je to na produkci.
- Do commitů/PR nepiš konkrétní částky ani API klíče.
