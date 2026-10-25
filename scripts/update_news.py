#!/usr/bin/env python3
"""Denní sběr zpráv k pozicím → data/news.json (varianta 1, spouští GitHub Action).

Postup: pozice z Firestore (otevřené akcie a krypto) → titulky z RSS (data/sources.json)
→ krátký souhrn přes Anthropic API → data/news.json.

Souhrn smí vycházet JEN z dodaných titulků; nic si nedomýšlí. Bez ANTHROPIC_API_KEY se
obnoví jen seznam titulků (souhrn zůstane z minula). Jen standardní knihovna.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEWS_PATH = os.path.join(ROOT, 'data', 'news.json')
SOURCES_PATH = os.path.join(ROOT, 'data', 'sources.json')
FIRESTORE = ('https://firestore.googleapis.com/v1/projects/rd-modrice-e9477/'
             'databases/(default)/documents/portfolio_pozice?pageSize=200')
MODEL = os.environ.get('NEWS_MODEL', 'claude-sonnet-5-5')
API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
MAX_AGE = timedelta(days=14)
KEEP_CLAUDE_DAYS = 3   # čerstvější ruční záznam (mode "claude") se nepřepisuje
UA = {'User-Agent': 'Mozilla/5.0 (portfolio-news-bot)'}


def get(url, timeout=25, headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_positions():
    docs = json.loads(get(FIRESTORE)).get('documents', [])
    out = []
    for d in docs:
        f = d.get('fields', {})
        val = lambda k: (f.get(k) or {}).get('stringValue', '')
        closed = (f.get('closed') or {}).get('booleanValue', False)
        if closed or val('type') not in ('akcie', 'krypto'):
            continue
        out.append({'type': val('type'), 'symbol': val('symbol'), 'name': val('name') or val('symbol')})
    return out


def query_for(pos, sources):
    q = sources.get('queries', {}).get(pos['symbol'])
    if q:
        return q
    name = re.sub(r'\b(AG|SA|SE|S\.p\.A\.|AB|Class [A-Z]|Company Limited|Ltd\.?|Inc\.?|plc)\b', '', pos['name'], flags=re.I)
    return re.sub(r'\s+', ' ', name).strip() or pos['symbol']


def parse_rss(raw, feed_name):
    items = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return items
    for it in root.iter('item'):
        title = (it.findtext('title') or '').strip()
        url = (it.findtext('link') or '').strip()
        src_el = it.find('source')
        source = (src_el.text if src_el is not None and src_el.text else feed_name).strip()
        host = urllib.parse.urlparse(src_el.get('url') if src_el is not None and src_el.get('url') else url).netloc
        try:
            dt = parsedate_to_datetime(it.findtext('pubDate') or '')
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            dt = None
        if title and url:
            items.append({'title': title, 'url': url, 'source': source, 'host': host, 'dt': dt,
                          'desc': re.sub(r'<[^>]+>', ' ', it.findtext('description') or '')})
    return items


def collect(pos, sources):
    feeds = sources['feeds'].get(pos['type'], [])
    q = query_for(pos, sources)
    now = datetime.now(timezone.utc)
    items = []
    for feed in feeds:
        url = feed['url'].format(symbol=urllib.parse.quote(pos['symbol']), query=urllib.parse.quote_plus(q))
        try:
            got = parse_rss(get(url), feed['name'])
        except Exception as e:  # jeden mrtvý zdroj nesmí shodit celý běh
            print(f"  ! {feed['name']}: {e}", file=sys.stderr)
            continue
        if feed.get('filter'):  # obecné krypto feedy: jen to, co se týká titulu
            needle = q.lower()
            got = [i for i in got if needle in (i['title'] + ' ' + i['desc']).lower()]
        items += got
    items = [i for i in items if i['dt'] is None or now - i['dt'] <= MAX_AGE]
    trusted = tuple(sources.get('trusted', []))
    seen, uniq = set(), []
    for i in items:
        key = re.sub(r'\W+', '', i['title'].lower())[:60]
        if key not in seen:
            seen.add(key)
            uniq.append(i)
    # důvěryhodné zdroje napřed, uvnitř podle data
    uniq.sort(key=lambda i: (not i['host'].endswith(trusted),
                             -(i['dt'].timestamp() if i['dt'] else 0)))
    return uniq[:25]


PROMPT = """Jsi asistent, který pro české rodinné portfolio shrnuje zprávy k jedné investici.
Titul: {name} ({symbol}), typ: {type}. Dnes je {today}.

Níže jsou JEDINÉ podklady (titulky z RSS, bez plných textů):
{headlines}

Pravidla:
- Piš česky, věcně, bez superlativů a bez investičních doporučení (nekupuj/neprodávej).
- Použij VÝHRADNĚ informace z titulků výše. Nic si nedomýšlej, nepřidávej čísla, která tam nejsou.
- Když z titulků příčina vývoje není zřejmá, napiš to ("z dostupných titulků není jasné…").
- "outlook" plň jen tehdy, když titulek zmiňuje konkrétního analytika/banku/instituci a jejich cílovou cenu,
  doporučení nebo prognózu; "source" je ten, kdo predikci vydal, "url" odkaz z podkladů. Jinak prázdné pole.
- "headline_ids" jsou čísla nejdůležitějších titulků (max 8).

Odpověz POUZE JSON bez dalšího textu:
{{"summary": "2-4 věty: co se děje a proč se cena vyvíjí, jak se vyvíjí",
  "drivers": ["krátký bod", "..."],
  "outlook": [{{"source": "", "view": "", "target": "", "date": "YYYY-MM-DD", "url": ""}}],
  "risks": ["krátký bod"],
  "headline_ids": [1, 2]}}"""


def summarize(pos, items):
    lines = '\n'.join(
        f"{n}. [{i['source']}, {i['dt'].date() if i['dt'] else '?'}] {i['title']}  <{i['url']}>"
        for n, i in enumerate(items, 1))
    body = json.dumps({
        'model': MODEL, 'max_tokens': 1500,
        'messages': [{'role': 'user', 'content': PROMPT.format(
            name=pos['name'], symbol=pos['symbol'], type=pos['type'],
            today=datetime.now(timezone.utc).date(), headlines=lines)}],
    }).encode()
    raw = get('https://api.anthropic.com/v1/messages', timeout=90, data=body, headers={
        'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    text = ''.join(b.get('text', '') for b in json.loads(raw).get('content', []))
    return json.loads(text[text.index('{'):text.rindex('}') + 1])


def main():
    sources = load_json(SOURCES_PATH, {})
    news = load_json(NEWS_PATH, {'version': 1, 'entries': {}})
    news.setdefault('entries', {})
    positions = load_positions()
    if not positions:
        print('Žádné otevřené pozice (akcie/krypto) – končím.', file=sys.stderr)
        return 1
    today = datetime.now(timezone.utc).date()
    changed = 0
    for pos in positions:
        sym = pos['symbol']
        old = news['entries'].get(sym)
        print(f'{sym}:')
        if old and old.get('mode') == 'claude':
            try:
                age = (today - datetime.fromisoformat(old['asOf']).date()).days
            except (KeyError, ValueError):
                age = 999
            if age < KEEP_CLAUDE_DAYS:
                print('  ruční záznam je čerstvý, přeskakuji')
                continue
        items = collect(pos, sources)
        print(f'  titulků: {len(items)}')
        if not items:
            continue
        entry = {'name': pos['name'], 'symbol': sym, 'mode': 'auto', 'asOf': today.isoformat(),
                 'summary': '', 'drivers': [], 'outlook': [], 'risks': [], 'headlines': []}
        picked = items[:8]
        if API_KEY:
            try:
                r = summarize(pos, items)
                entry.update({k: r.get(k) or [] for k in ('drivers', 'outlook', 'risks')})
                entry['summary'] = r.get('summary', '')
                ids = [n for n in r.get('headline_ids', []) if isinstance(n, int) and 1 <= n <= len(items)]
                picked = [items[n - 1] for n in ids[:8]] or picked
            except Exception as e:
                print(f'  ! souhrn selhal: {e}', file=sys.stderr)
                if old:  # ať nezmizí starý souhrn kvůli výpadku API
                    entry.update({k: old.get(k, entry[k]) for k in ('summary', 'drivers', 'outlook', 'risks')})
        elif old:
            entry.update({k: old.get(k, entry[k]) for k in ('summary', 'drivers', 'outlook', 'risks')})
        entry['headlines'] = [{'title': i['title'], 'url': i['url'], 'source': i['source'],
                               'date': i['dt'].date().isoformat() if i['dt'] else ''} for i in picked]
        news['entries'][sym] = entry
        changed += 1

    if not changed:
        print('Nic nového, news.json beze změny.')
        return 0
    news['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    with open(NEWS_PATH, 'w', encoding='utf-8') as f:
        json.dump(news, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'Hotovo, aktualizováno {changed} titulů.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
