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
  a nahraď konstantu `HASH` v `assets/gate.js`.
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
  type: 'akcie' | 'krypto',
  symbol: string,       // ticker pro Twelve Data (akcie) nebo CoinGecko id (krypto)
  name: string,         // volitelný lidský název
  quantity: number,
  avgBuyPrice: number,  // za kus, v měně "currency"
  currency: 'CZK'|'USD'|'EUR'|'GBP',
  note: string,
  ts: number            // Date.now() při vytvoření
}
```

Součty v dashboardu jsou vždy v CZK – cizí měny se přepočítávají aktuálním kurzem
(Frankfurter), ne historickým kurzem ke dni nákupu.

## 5) Známá omezení / co dodělat příště, když si to řeknou

- Twelve Data free tarif má rate limit (~8 req/min, 800/den) – při velkém počtu pozic
  zvážit dávkování nebo cache.
- Currency konverze je jen k okamžiku zobrazení, ne historická k datu nákupu.
- Nemovitosti/hotovost/spoření zatím nejsou v datovém modelu (uživatel zatím chtěl jen
  akcie/ETF + krypto) – přidání by šlo jako další `type`.
- Heslo na stránce je jen klientská ochrana (viz §1) – při zvýšení nároků na soukromí
  zvážit přechod na Firebase Auth nebo private GitHub Pages (GitHub Pro).

## 6) Konvence

- Odpovídej **česky**, stručně a k věci.
- Commituj a nasazuj rovnou (push do `main`), po nasazení napiš, že je to na produkci.
- Do commitů/PR nepiš konkrétní částky ani API klíče.
