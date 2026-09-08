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
- `nastaveni.html` – nastavení **nepovinného** záložního API klíče (Twelve Data); ceny
  akcií i krypta jdou bez klíče (viz §4e).
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
  akcie/ETF přes **Yahoo Finance** (bez klíče, jedním dotazem cena i roční historie – viz §4e;
  Twelve Data je jen záloha, `fetchAllPrices(positions, apiKey)` klíč jen předává),
  kurzy měn přes několik zdrojů za sebou (`FX_SOURCES`:
  frankfurter.dev → frankfurter.app → open.er-api.com), s cache v `localStorage`.
  **Na kurzu závisí hodnota všeho v cizí měně**, takže když všechny zdroje selžou, použije se
  poslední známý kurz (i starý) a `fxStatus()` to ohlásí – `updateFxWarning()` v `portfolio.js`
  to vypíše do status baru. Dřív se selhání kurzu jen tiše projevilo pomlčkami v celé tabulce
  a nedalo se poznat proč.
- `assets/live.js` – **živá cena kryptoměn z burzy** (viz §4g): Coinmate (REST po 10 s,
  cena v CZK) → Kraken (WebSocket v2, EUR) → Binance (WebSocket, EUR), první funkční
  vyhrává. `startLivePrice(symbol, onPrice, onStatus)` vrací funkci pro zastavení.
- `assets/chart.js` – spojnicový graf vývoje ceny (inline SVG, bez knihovny): rozsahy
  1 měsíc / 3 měsíce / 1 rok, hover zaměřovač s bublinou, ovládání i šipkami z klávesnice.
  **viewBox je v reálných pixelech šířky kontejneru** (a překresluje se přes `ResizeObserver`) –
  s pevným viewBoxem a `preserveAspectRatio="none"` se roztahoval i text popisků.
  **Pozor:** `el.hidden = true/false` na SVG prvku nefunguje (není to HTML prvek) – skrývání
  zaměřovače jde přes `setAttribute('hidden')` + vlastní CSS pravidlo.
- `assets/portfolio.js` – hlavní logika dashboardu: Firestore CRUD (kolekce `portfolio_pozice`),
  přihlášení k odběru sdíleného API klíče, přepočty na CZK, vykreslení tabulky a alokačního
  grafu (inline SVG donut).

## 4) Datový model pozice (Firestore `portfolio_pozice`)

```
{
  type: 'akcie' | 'krypto' | 'hotovost',
  symbol: string,       // ticker v konvenci Yahoo (akcie: RHM.DE, HO.PA, SAAB-B.ST, BY6.DE)
                         // nebo CoinGecko id (krypto);
                         // u hotovosti jen popisek (typicky = měna), cena se nefetchuje
  name: string,         // volitelný lidský název
  quantity: number,     // u hotovosti = částka
  avgBuyPrice: number,  // za kus, v měně "currency"; u hotovosti vždy 1
  currency: 'CZK'|'USD'|'EUR'|'GBP',
  manualPrice: number|null, // volitelná ručně zadaná aktuální cena za kus (v "currency");
                            // použije se JEN když automatická cena selže (viz §4c)
  primaryCurrency: string,  // volitelné; prázdné = hlavní údaje řádku jsou v "currency".
                            // Když je vyplněné (bitcoin má 'EUR'), přepočítají se v tabulce
                            // VŠECHNY hlavní údaje řádku do téhle měny aktuálním kurzem –
                            // uložená data (nákupní cena) se nemění, jen zobrazení (viz §4f)
  note: string,
  ts: number,           // Date.now() při vytvoření (u historických importů = datum nákupu)

  // volitelně – uzavřená (prodaná) pozice, viz §4b:
  closed: boolean,
  sellPrice: number,    // za kus, v měně "currency"
  closedAt: number       // Date.now() při uzavření (u historických importů = datum prodeje)
}
```

### Zobrazovací měna

Uživatel si nahoře u tabulky přepíná, v jaké měně se přehled zobrazuje (`CZK`/`EUR`/`USD`,
`DISPLAY_CURRENCIES` v `assets/portfolio.js`). Volba se drží v `localStorage`
(`portfolio-display-currency-v1`) – je to předvolba zobrazení, ne sdílená data, takže
každý může mít svou. Přepnutí **jen přepočítá už stažené ceny** (`recompute()` + `render()`),
nespouští žádné nové dotazy na ceny.

**V tabulce je hlavní údaj vždy v měně dané pozice** (souhlasí s nákupní i aktuální cenou)
a zvolená měna je jen menší druhý řádek pod ním – a zobrazí se, **jen když se od měny
pozice liší** (jinak by tam bylo dvakrát totéž). Dělá to helper `withSecondary()`.
Součty nahoře a alokační graf jsou naopak celé ve zvolené měně, protože sčítají pozice
v různých měnách dohromady.

Proto má `computed` od každé hodnoty dvě varianty:
- `valueNative`, `investedNative`, `gainNative`, `costNative`, `realizedNative` – v měně
  pozice (`p.currency`); počítají se **bez kurzu**, takže fungují i když je kurzová služba
  mimo provoz,
- `value`, `invested`, `gain`, `cost`, `realized` – převedené do zvolené měny přes
  `toDisplay()` (aktuálním kurzem, ne kurzem ke dni nákupu).

Nikdy nepřepočítávej `avgBuyPrice`/`sellPrice`/`manualPrice` v databázi – ty zůstávají
v původní měně pozice.

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

### 4bb) Odkazy na detail a graf vývoje

V tabulce je název pozice odkaz na detail titulu: u krypta `coingecko.com/en/coins/<symbol>`
(uložený symbol JE CoinGecko id, takže vždy sedí), u akcií `finance.yahoo.com/quote/<symbol>`
(sedí u tickerů s burzovní příponou jako `RHM.DE`, `HO.PA`). Když u nějakého titulu
neodpovídá, jde vlastní adresu uložit do pole `infoUrl` (v editaci "Odkaz na detail") –
ta má přednost.

Tlačítko 📈 rozbalí pod řádkem graf vývoje ceny (`fetchPriceHistory` v `assets/prices.js`):
- **u akcií je historie zadarmo spolu s cenou** – Yahoo vrací v jednom dotazu `meta` i roční
  denní řadu, takže `fetchStockPrices()` ji rovnou uloží (`cacheStockHistory`) a rozkliknutí
  grafu nevolá vůbec nic; u krypta se řada stáhne z CoinGecku až na rozkliknutí,
- vždy se drží **celý rok denních dat** a kratší rozsahy se ořezávají lokálně
  (přepínání rozsahu je zadarmo),
- cache 12 h v `localStorage` (`portfolio-history-cache-v1`); klíč je `akcie:<symbol>`
  (Yahoo kotuje v měně burzy, ne v měně pozice) a `krypto:<symbol>:<měna>`,
- při selhání se ukáže starší graf z cache (s poznámkou), ne prázdno; poznámka „Data z…"
  se ukazuje jen u dat starších než 3 h nebo když se obnova nepovedla.

Rozbalené grafy si drží `openCharts` (Set id pozic), aby překreslení tabulky (nové ceny,
změna měny) graf nezavřelo.

### 4c) Chyby cen a ruční cena

Když se živou cenu nepodaří stáhnout, je to vidět i tehdy, když se místo ní použije ruční
cena: v tabulce je poznámka „ručně zadaná · živá cena selhala" a ve status baru vypíše
`updatePriceWarning()` celý důvod (seskupeně podle hlášky). Bez toho vypadala stará ruční
cena jako v pořádku a nešlo poznat, že zdroj cen nefunguje.

`fetchStockPrices()` v `assets/prices.js` propouští **skutečnou hlášku ze zdroje**
(neznámý ticker, nedostupné Yahoo i proxy, u zálohy chyba Twelve Data) až do tabulky, kde se
vypíše viditelně červeně (`.pricerr`) – dřív se schovávala do `title` tooltipu, který je
na mobilu nedostupný, takže uživatel viděl jen "chyba" a nedalo se to diagnostikovat.
**Nevracej se k tomu.**

Když automatická cena selže a pozice má vyplněné `manualPrice`, použije se ta a v tabulce
je označená popiskem "ručně zadaná". Automatická cena má vždy přednost (je čerstvější);
ruční je jen záchranná brzda pro tituly, které daný zdroj cen neumí.

### 4d) Kredity Twelve Data a cache cen (POZOR – tady se to už jednou rozbilo)

> Od přechodu na Yahoo (§4e) se kredity běžně vůbec neutrácejí – hlídač zůstává jen pro
> záložní cestu. Cache cen v `portfolio.js` ale platí dál a pořád má stejný smysl.

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

### 4e) Zdroj cen akcií: Yahoo Finance (a proč ne Twelve Data)

Free tarif Twelve Data **nepokrývá evropské burzy** – na XETRA/Euronext/Borsa/Madrid/Stockholm
(tedy na všechny tituly, které uživatel drží) vrací
`This symbol is available starting with the Grow or Venture plan` (kód 404). Rate limit tuhle
příčinu zpočátku maskoval; ceny akcií a grafy proto nikdy nefungovaly.

Hlavním zdrojem je proto `https://query1.finance.yahoo.com/v8/finance/chart/<ticker>?range=1y&interval=1d`:
bez klíče, bez kreditů a **jedním dotazem cena (`meta.regularMarketPrice`) i roční denní řada**
pro graf. Yahoo neposílá CORS hlavičky spolehlivě, takže `YAHOO_GATEWAYS` zkouší popořadě
přímé volání → `api.allorigins.win` → `corsproxy.io` (ven jde jen ticker, žádné částky).
Když Yahoo ticker **nezná** (`chart.error`), další brána to nespraví – hlásí se to rovnou
(u symbolu bez tečky s nápovědou doplnit příponu burzy).
Twelve Data zůstává jen jako záloha, když je klíč uložený; jinak se ani nevolá.

**Rychlost (POZOR – tady se to už jednou rozbilo):**
- **každý dotaz má časový limit** (`fetchJson`, 7 s; kurzy 6 s). Bez něj visel jeden mrtvý
  zdroj klidně minuty a stránka jen ukazovala „…";
- symboly se stahují **paralelně** a brány se **závodí** (`Promise.any`), takže načtení
  trvá nejvýš jeden limit, ne (počet symbolů × počet bran);
- vítězná brána se pamatuje (`portfolio-yahoo-gateway-v1`) a příště se zkusí první –
  jinak by se při každém načtení čekalo, až vyprší limit u cesty, kterou prohlížeč
  stejně blokuje kvůli CORS;
- akcie a krypto se v `refreshPrices()` stahují jako **dvě nezávislé skupiny** a každá se
  vykreslí hned, jak dorazí (dřív bitcoin čekal na zaseknuté akcie);
- ceny z cache se vykreslí **hned po načtení stránky**, ještě před dotazy.

**Písmo z fonts.googleapis.com se načítá neblokující cestou** (`media="print" onload=…`).
Stylesheet v hlavičce totiž blokuje spuštění skriptů – při pomalém/nedostupném Google
Fonts se start stránky odkládal o desítky sekund a vypadalo to jako pomalé ceny.
Nevracej to na obyčejný `rel="stylesheet"`.

**Neznámý ticker → zkus jinou burzu téhož titulu.** Yahoo u neznámého symbolu vrací
**HTTP 404 s JSON tělem**, ve kterém je popis (`chart.error.description`) – proto `fetchJson`
u chybové odpovědi **nejdřív zkusí přečíst tělo** a teprve pak hlásí HTTP chybu. Bez toho
se „špatný symbol" tvářil jako výpadek spojení a nešlo na to reagovat. Když Yahoo ticker
nezná, zkusí se sourozenecké burzy (`VENUE_ALTS`: `.DE` → `.F`, `.SG`, `.BE`, `.MU`…) –
typický případ je BYD, který se v Německu obchoduje ve Frankfurtu (`BY6.F`), ne na XETRA.
Funkční burza se zapamatuje (`portfolio-symbol-alias-v1`), takže se příště ptáme rovnou
jí; v tabulce je u ceny poznámka `burza BY6.F`. Uložený symbol u pozice se **nepřepisuje**.

**Cena chodí v měně burzy**, ne v měně pozice (Saab `SAAB-B.ST` kotuje ve SEK, pozice je
v EUR). `fetchAllPrices` proto vrací `currency` z Yahoo a `recompute()` v `portfolio.js`
z ní počítá `priceInPos` (přepočet do měny pozice) – v tabulce je hlavní údaj v měně pozice
a původní burzovní kurz drobně pod ním. Graf zůstává v měně burzy.

### 4f) Měna hlavního údaje řádku (`primaryCurrency`)

Tabulka ukazuje hlavní údaje **v měně pozice** a menším písmem pod tím přepočet do
zvolené měny (`displayCur`). Bitcoin je ale koupený za koruny, kdežto zbytek portfolia
je v eurech – uživatel chtěl vidět i bitcoin primárně v eurech. Řeší to volitelné pole
`primaryCurrency` (ve formuláři „Zobrazovat v tabulce"): když je vyplněné, `recompute()`
přepočítá nákupní cenu, aktuální cenu, hodnotu i zisk do téhle měny (`toNative()`)
a původní hodnota v měně pozice se ukáže drobně pod tím.

**Uložená data se nemění** – `currency` a `avgBuyPrice` zůstávají tím, co uživatel
opravdu zaplatil (koruny), přepočet se dělá až při vykreslení aktuálním kurzem. Proto
zisk v % vychází stejně jako v původní měně (na obě strany se použije stejný kurz),
ale absolutní čísla se s pohybem kurzu mění. Nesnaž se to „zjednodušit" přepsáním
`avgBuyPrice` na eura – tím by se ztratil skutečný nákupní základ v korunách.

### 4g) Živé ceny krypta a automatická obnova akcií

**Krypto jede živě z burzy** (`assets/live.js`). Burzy dávají cenu zdarma, bez klíče a
**WebSocket nepodléhá CORS** – žádná proxy, žádné dotazování v intervalu, cena přijde sama.
Zdroje se zkoušejí popořadě (Coinmate v CZK → Kraken → Binance v EUR); když neprojde ani
jeden, stránka běží dál na CoinGecku a jen zmizí popisek „živě". V tabulce je u ceny
`živě · <burza>`. Vykreslení je omezené na **jednou za sekundu** (`LIVE_RENDER_MS`) – cena
se mění i vícekrát za vteřinu a překreslovat kvůli tomu celou tabulku nemá smysl.
Živou cenu **nesmí přebít** cena z běžného dotazu – hlídá to `if(prev.live) return;`
v `applyFetched()`.

**Akcie se obnovují samy každé 2 minuty, ale jen když jsou burzy otevřené**
(`startAutoRefresh()` + `marketOpen()`, po–pá 9:00–17:35 podle `Europe/Prague`, ať to sedí
i při jiné časové zóně zařízení a v zimním/letním čase). Mimo obchodní hodiny a na skryté
záložce se neptá vůbec; návrat na záložku ceny dotáhne.

**Rychleji než po 2 minutách to nemá smysl a je to i nebezpečné:** zdarma dostupné ceny
evropských burz jsou **zpožděné ~15 min** (licencovaná data – real-time je placený), takže
častější dotazy vrací pořád stejné číslo, jen by hrozilo, že nás veřejná CORS proxy
odstřihne. `PRICE_TTL_MS` (115 s) je proto sladěné s intervalem obnovy.

Co **nedělat**: tahat ceny z DEGIRO (žádné veřejné API, vyžadovalo by přihlašovací údaje
na veřejně hostovaném webu, jejich kurzy jsou stejně zpožděné) ani z Anycoinu (směnárna,
ne burza – její cena je burzovní kurz + marže).

## 5) Známá omezení / co dodělat příště, když si to řeknou

- Yahoo Finance není oficiální API – kdyby přestalo fungovat i přes proxy, dalšími
  kandidáty jsou Stooq (CSV, bez CORS → přes proxy) nebo placený tarif Twelve Data.
  Ruční ceny (`manualPrice`) fungují jako záchranná brzda vždy.
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
