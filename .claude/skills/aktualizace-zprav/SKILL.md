---
name: aktualizace-zprav
description: Ruční aktualizace zpráv, komentáře a výhledů k pozicím portfolia (data/news.json). Použij, když uživatel řekne "aktualizuj zprávy", "co je nového u akcií/bitcoinu" nebo chce přehled, proč se pozice vyvíjejí, jak se vyvíjejí, a co čeká trh.
---

# Aktualizace zpráv k portfoliu (varianta 2 – ručně v chatu)

Výsledek se ukládá do `data/news.json` a web ho ukazuje po rozkliku 📰 u řádku pozice.
Odpovídej česky. Nejde o investiční doporučení.

## Postup

1. **Pozice**: zjisti otevřené akcie a krypto z Firestore
   (`https://firestore.googleapis.com/v1/projects/rd-modrice-e9477/databases/(default)/documents/portfolio_pozice`,
   přeskoč `closed` a `hotovost`). Klíč záznamu v `news.json` = pole `symbol`.
   Nikam nepiš ani nevypisuj množství a ceny – jen symboly a názvy.
2. **Zdroje**: seznam je v `data/sources.json` (`manual` = kam se podívat, `trusted` = důvěryhodné domény).
   Pro každou pozici hledej přes WebSearch/WebFetch zprávy z posledních ~14 dnů. Dávej přednost primárním
   zdrojům (firemní IR, Reuters, regulátoři) a konsensu analytiků (MarketScreener, Yahoo Finance).
   Zdroje za paywallem (FT, Bloomberg, WSJ) jdou použít jen na úrovni titulku – nevydávej za jejich obsah víc.
3. **Napiš záznam** (schéma níže). Pravidla:
   - každé tvrzení musí jít dohledat ve zdroji; u čísel uveď zdroj a datum,
   - **predikce nejsou moje**: do `outlook` patří jen názory třetích stran (analytik, banka, instituce)
     s `source`, `date` a `url`; u bitcoinu ukaž rozpětí názorů, ne jedno číslo,
   - když příčina vývoje není jasná, napiš to; žádné domýšlení,
   - žádné "kup/prodej".
4. **Zapiš** do `data/news.json` (zachovej ostatní záznamy, nastav `updatedAt` na aktuální ISO čas),
   `mode: "claude"`. Záznamy s `mode: "claude"` mladší 3 dnů denní automat nepřepisuje.
5. **Nasaď** podle CLAUDE.md (§2): commit a push do `main`, ověř workflow Deploy. Do commitu žádné částky.

## Schéma záznamu

```json
"RHM.DE": {
  "name": "Rheinmetall AG",
  "symbol": "RHM.DE",
  "mode": "claude",
  "asOf": "2026-10-25",
  "summary": "2–4 věty: co se děje a proč se cena vyvíjí, jak se vyvíjí",
  "drivers": ["krátký bod"],
  "outlook": [{ "source": "Jméno banky/analytika", "view": "co čekají", "target": "cílová cena", "date": "2026-10-20", "url": "https://…" }],
  "risks": ["krátký bod"],
  "headlines": [{ "title": "…", "url": "https://…", "source": "Reuters", "date": "2026-10-24" }]
}
```

`headlines` max ~8, jen http(s) odkazy. Pole, ke kterým nic nemáš, nech prázdná (`[]`, `""`).
