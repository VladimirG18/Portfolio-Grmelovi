/* Sdílené chování stránek: přepínání světlého/tmavého režimu
   + zvýraznění aktivní položky v navigaci. */
(function(){
  const KEY = 'portfolio-theme';

  function apply(theme){
    if(theme === 'light' || theme === 'dark'){
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch(e){}
  apply(saved);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
    let s = null;
    try { s = localStorage.getItem(KEY); } catch(e){}
    if(!s) apply(null);
  });

  function currentIsDark(){
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.querySelector('.theme-btn');
    if(btn){
      const setIcon = ()=>{ btn.textContent = currentIsDark() ? '☀️' : '🌙'; };
      setIcon();
      btn.addEventListener('click', ()=>{
        const next = currentIsDark() ? 'light' : 'dark';
        try { localStorage.setItem(KEY, next); } catch(e){}
        apply(next);
        setIcon();
      });
    }
    const here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.navlinks a').forEach(a=>{
      if(a.getAttribute('href') === here) a.setAttribute('aria-current','page');
    });

    // Verze nasazení v patičce – ať jde poznat, jestli prohlížeč nedrží starou verzi.
    const verEl = document.getElementById('app-version');
    const meta = document.querySelector('meta[name="app-version"]');
    if(verEl && meta){
      const v = meta.getAttribute('content') || '';
      verEl.textContent = v.startsWith('__') ? ' · verze: dev' : ' · verze ' + v.slice(0, 7);
    }
  });
})();
