/* Jednoduchá klientská ochrana heslem – NENÍ to silné zabezpečení
   (kdokoli se znalostí JS umí hash obejít), jen odradí náhodné návštěvníky.
   Skutečná data (Firestore) chrání jen svá pravidla, ne tahle stránka. */
(function(){
  const KEY = 'portfolio-unlock-v1';
  const HASH = '9c6d59766058c7d8e04c449eed4bd50de25b9ea3eba2441a6456799985de7093';

  async function sha256(text){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  function isOpen(){
    try { return localStorage.getItem(KEY) === '1'; } catch(e){ return false; }
  }

  function unlock(){
    try { localStorage.setItem(KEY, '1'); } catch(e){}
    document.documentElement.setAttribute('data-gate', 'open');
    const ov = document.getElementById('gate-overlay');
    if(ov) ov.remove();
  }

  function buildOverlay(){
    const ov = document.createElement('div');
    ov.className = 'gate-overlay';
    ov.id = 'gate-overlay';
    ov.innerHTML = `
      <div class="gate-card">
        <div class="logo">🔒</div>
        <h1>Portfolio Grmelovi</h1>
        <p>Stránka je chráněná heslem – zadej ho pro vstup.</p>
        <input type="password" id="gate-pass" placeholder="Heslo" autocomplete="current-password" />
        <button class="btn primary" id="gate-go">Vstoupit</button>
        <div class="gate-err" id="gate-err"></div>
      </div>`;
    document.body.appendChild(ov);

    const input = ov.querySelector('#gate-pass');
    const err = ov.querySelector('#gate-err');
    const go = ov.querySelector('#gate-go');

    async function tryUnlock(){
      const val = input.value;
      if(!val){ input.focus(); return; }
      go.disabled = true;
      const h = await sha256(val);
      go.disabled = false;
      if(h === HASH){ unlock(); }
      else {
        err.textContent = 'Špatné heslo, zkus to znovu.';
        input.value = '';
        input.focus();
      }
    }
    go.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', e => { if(e.key === 'Enter') tryUnlock(); });
    setTimeout(()=> input.focus(), 50);
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    if(isOpen()){
      document.documentElement.setAttribute('data-gate', 'open');
    } else {
      document.documentElement.setAttribute('data-gate', 'locked');
      buildOverlay();
    }
  });
})();
