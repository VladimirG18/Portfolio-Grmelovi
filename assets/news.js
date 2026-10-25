/* Zprávy, komentář a výhledy k pozicím (rozklik 📰 u řádku).

   Data jsou ve statickém souboru data/news.json, který plní dvě cesty:
     - mode "auto"   – denní GitHub Action (scripts/update_news.py) z titulků RSS,
     - mode "claude" – ruční aktualizace v chatu (skill aktualizace-zprav).
   Klíč záznamu = symbol pozice (RHM.DE, bitcoin…). Stránka jen čte, nic nestahuje
   z cizích webů, takže tu nejsou žádné CORS ani proxy potíže. */

let newsPromise = null;

export function loadNews(){
  if(!newsPromise){
    newsPromise = fetch('data/news.json', { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return newsPromise;
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Odkazy jen na http(s) – obsah pochází z externích zdrojů.
function link(url, text){
  return /^https?:\/\//i.test(url || '')
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)} <span class="extlink">↗</span></a>`
    : esc(text);
}

function fmtDate(iso){
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

function list(items, cls){
  return items && items.length
    ? `<ul class="${cls}">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
}

export async function fillNews(host, p){
  host.innerHTML = '<div class="chart-empty">Načítám zprávy…</div>';
  const data = await loadNews();
  const e = data && data.entries && data.entries[p.symbol];
  if(!e){
    host.innerHTML = '<div class="chart-empty">K téhle pozici zatím nejsou žádné zprávy. '
      + 'Objeví se po další aktualizaci (denní automatická, nebo ruční přes chat).</div>';
    return;
  }

  const who = e.mode === 'claude'
    ? 'Souhrn připravil Claude z veřejných zdrojů'
    : 'Automatický souhrn z titulků zpráv – může obsahovat chyby';
  const outlook = (e.outlook || []).map(o => `
    <li><b>${esc(o.source)}</b>${o.date ? ' <span class="news-date">' + esc(fmtDate(o.date)) + '</span>' : ''}
      – ${esc(o.view)}${o.target ? ' <span class="chip acc">' + esc(o.target) + '</span>' : ''}
      ${o.url ? ' ' + link(o.url, 'zdroj') : ''}</li>`).join('');
  const heads = (e.headlines || []).map(h => `
    <li>${link(h.url, h.title)}<span class="news-meta">${esc(h.source || '')}${h.date ? ' · ' + esc(fmtDate(h.date)) : ''}</span></li>`).join('');

  host.innerHTML = `
    <div class="news-head"><span class="chip">${esc(who)}</span>
      <span class="news-date">stav k ${esc(fmtDate(e.asOf))}</span></div>
    ${e.summary ? `<p class="news-summary">${esc(e.summary)}</p>` : ''}
    ${(e.drivers || []).length ? `<h4>Co to pohání</h4>${list(e.drivers, 'news-list')}` : ''}
    ${outlook ? `<h4>Výhled a predikce <small>(názory třetích stran, ne moje)</small></h4><ul class="news-list">${outlook}</ul>` : ''}
    ${(e.risks || []).length ? `<h4>Rizika</h4>${list(e.risks, 'news-list')}` : ''}
    ${heads ? `<h4>Zprávy</h4><ul class="news-heads">${heads}</ul>` : ''}
    <div class="chart-note">Informativní přehled, nejde o investiční doporučení. Predikce jsou názory
      uvedených zdrojů a často se mýlí.</div>`;
}
