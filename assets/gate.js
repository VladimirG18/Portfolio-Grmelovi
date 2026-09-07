/* Jednoduchá klientská ochrana heslem – NENÍ to silné zabezpečení
   (kdokoli se znalostí JS umí hash obejít), jen odradí náhodné návštěvníky.
   Skutečná data (Firestore) chrání jen svá pravidla, ne tahle stránka.

   Volitelně navíc: odemykání otiskem / Face ID / Windows Hello (WebAuthn),
   nastaví se samo po prvním zadání hesla na daném zařízení. Je to jen
   pohodlnější zámek na tomtéž zařízení, ne skutečné ověření identity vůči
   serveru (žádný server tu není) – bezpečnostně na stejné úrovni jako heslo. */
(function(){
  const KEY = 'portfolio-unlock-v1';
  const HASH = '9c6d59766058c7d8e04c449eed4bd50de25b9ea3eba2441a6456799985de7093';
  const CRED_KEY = 'portfolio-webauthn-cred-v1';

  async function sha256(text){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  function isOpen(){
    try { return localStorage.getItem(KEY) === '1'; } catch(e){ return false; }
  }

  /* ---------- WebAuthn (biometrie na tomto zařízení) ---------- */
  function b64uEncode(buf){
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function b64uDecode(str){
    str = str.replace(/-/g,'+').replace(/_/g,'/');
    while(str.length % 4) str += '=';
    const bin = atob(str);
    const buf = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function randomBytes(n){
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }
  function getStoredCred(){
    try { const raw = localStorage.getItem(CRED_KEY); return raw ? JSON.parse(raw) : null; } catch(e){ return null; }
  }
  function setStoredCred(id){
    try { localStorage.setItem(CRED_KEY, JSON.stringify({ id })); } catch(e){}
  }
  function clearStoredCred(){
    try { localStorage.removeItem(CRED_KEY); } catch(e){}
  }

  async function platformAvailable(){
    if(!window.PublicKeyCredential || !navigator.credentials) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch(e){ return false; }
  }

  async function registerBiometric(){
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'Portfolio Grmelovi' },
        user: { id: randomBytes(16), name: 'grmelovi', displayName: 'Grmelovi' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
        attestation: 'none'
      }
    });
    setStoredCred(b64uEncode(cred.rawId));
  }

  async function tryBiometricUnlock(){
    const stored = getStoredCred();
    if(!stored) return false;
    try {
      await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{ id: b64uDecode(stored.id), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      return true;
    } catch(e){ return false; }
  }
  window.portfolioForgetBiometric = clearStoredCred;
  window.portfolioHasBiometric = () => !!getStoredCred();

  /* ---------- Odemčení ---------- */
  async function unlock(opts){
    try { localStorage.setItem(KEY, '1'); } catch(e){}
    document.documentElement.setAttribute('data-gate', 'open');
    const ov = document.getElementById('gate-overlay');
    const finish = () => { if(ov) ov.remove(); };

    if(opts && opts.offerBiometric && !getStoredCred() && ov && await platformAvailable()){
      const card = document.getElementById('gate-card');
      if(card){
        card.innerHTML = `
          <div class="logo">🔓</div>
          <h1>Odemykat příště biometrií?</h1>
          <p>Na tomhle zařízení půjde příště vstoupit otiskem prstu, Face ID nebo Windows Hello
            místo přepisování hesla.</p>
          <button class="btn primary" id="bio-setup-yes">Nastavit</button>
          <button class="btn" id="bio-setup-no" style="margin-top:8px; width:100%; justify-content:center">Ne, díky</button>`;
        card.querySelector('#bio-setup-yes').addEventListener('click', async () => {
          try { await registerBiometric(); } catch(e){ console.error(e); }
          finish();
        });
        card.querySelector('#bio-setup-no').addEventListener('click', finish);
        return;
      }
    }
    finish();
  }

  function buildOverlay(){
    const ov = document.createElement('div');
    ov.className = 'gate-overlay';
    ov.id = 'gate-overlay';
    ov.innerHTML = `
      <div class="gate-card" id="gate-card">
        <div class="logo">🔒</div>
        <h1>Portfolio Grmelovi</h1>
        <p>Stránka je chráněná heslem – zadej ho pro vstup.</p>
        <button class="btn primary" id="gate-bio" type="button" style="display:none; width:100%; justify-content:center; margin-bottom:10px">🔓 Otisk / Face ID</button>
        <input type="password" id="gate-pass" placeholder="Heslo" autocomplete="current-password" />
        <button class="btn primary" id="gate-go">Vstoupit</button>
        <div class="gate-err" id="gate-err"></div>
      </div>`;
    document.body.appendChild(ov);

    const input = ov.querySelector('#gate-pass');
    const err = ov.querySelector('#gate-err');
    const go = ov.querySelector('#gate-go');
    const bioBtn = ov.querySelector('#gate-bio');

    (async () => {
      if(getStoredCred() && await platformAvailable()){
        bioBtn.style.display = '';
        bioBtn.addEventListener('click', async () => {
          bioBtn.disabled = true;
          bioBtn.textContent = '⏳ Ověřuji…';
          const ok = await tryBiometricUnlock();
          if(ok){ unlock(); }
          else {
            err.textContent = 'Biometrii se nepodařilo ověřit, zkus heslo.';
            bioBtn.disabled = false;
            bioBtn.textContent = '🔓 Otisk / Face ID';
          }
        });
      }
    })();

    async function tryUnlock(){
      const val = input.value;
      if(!val){ input.focus(); return; }
      go.disabled = true;
      const h = await sha256(val);
      go.disabled = false;
      if(h === HASH){ unlock({ offerBiometric: true }); }
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
