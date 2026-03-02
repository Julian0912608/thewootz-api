// ═══════════════════════════════════════════════════════════
// TheWootz SaaS — app.js
// ═══════════════════════════════════════════════════════════

const API = 'https://thewootz-api.vercel.app';
let currentUser = null;
let currentSession = null;
let currentStores = [];
let selectedStoreId = '';
let selectedPlatform = 'bol';
let dashboardLoading = false;

// ─── DATE INIT ────────────────────────────────────────────
const _today = new Date();
const _90ago = new Date(_today - 90 * 86400000);
document.getElementById('endDate').value   = _today.toISOString().split('T')[0];
document.getElementById('startDate').value = _90ago.toISOString().split('T')[0];

// Periode preset helper
function applyPeriodPreset(val) {
  const today = new Date();
  const fmt = d => d.toISOString().split('T')[0];
  const startEl = document.getElementById('startDate');
  const endEl   = document.getElementById('endDate');
  const sep     = document.getElementById('periodSep');

  if (val === 'custom') {
    // Toon datum inputs
    startEl.style.display = '';
    endEl.style.display   = '';
    if (sep) sep.style.display = '';
    return;
  }

  // Verberg datum inputs voor preset
  startEl.style.display = 'none';
  endEl.style.display   = 'none';
  if (sep) sep.style.display = 'none';

  const end = fmt(today);
  let start;

  if (val === '7')  start = fmt(new Date(today - 7  * 86400000));
  else if (val === '30') start = fmt(new Date(today - 30 * 86400000));
  else if (val === '90') start = fmt(new Date(today - 90 * 86400000));
  else if (val === 'thisyear')  { start = today.getFullYear() + '-01-01'; }
  else if (val === 'lastyear')  {
    const y = today.getFullYear() - 1;
    start = y + '-01-01';
    endEl.value = y + '-12-31';
    startEl.value = start;
    loadDashboard();
    return;
  }
  else if (val === 'all') {
    // 2 jaar terug — genoeg voor historische data
    start = fmt(new Date(today - 730 * 86400000));
  }

  startEl.value = start;
  endEl.value   = end;
  loadDashboard();
}

// ═══════════════════════════════════════════════════════════
// AUTH — helpers
// ═══════════════════════════════════════════════════════════
function saveSession(session, user) {
  currentSession = session;
  currentUser    = user;
  localStorage.setItem('tw_session', JSON.stringify(session));
  localStorage.setItem('tw_user', JSON.stringify(user));
}
function clearSession() {
  currentSession = null; currentUser = null;
  localStorage.removeItem('tw_session');
  localStorage.removeItem('tw_user');
}
function loadSavedSession() {
  try {
    const s = localStorage.getItem('tw_session');
    const u = localStorage.getItem('tw_user');
    if (s && u) { currentSession = JSON.parse(s); currentUser = JSON.parse(u); return true; }
  } catch {}
  return false;
}
function isSessionValid() {
  if (!currentSession) return false;
  // Controleer expiry (Supabase JWT expires_at is in seconden)
  const expiry = currentSession.expires_at * 1000;
  return Date.now() < expiry - 60000; // 1 minuut buffer
}
async function ensureSession() {
  if (isSessionValid()) return true;
  if (!currentSession?.refresh_token) return false;
  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh', refreshToken: currentSession.refresh_token })
    });
    if (!res.ok) { clearSession(); return false; }
    const data = await res.json();
    currentSession = data.session;
    localStorage.setItem('tw_session', JSON.stringify(currentSession));
    return true;
  } catch { return false; }
}
function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-User-Token': currentSession?.access_token || ''
  };
}

// ─── UI AUTH HELPERS ──────────────────────────────────────
function showAuthTab(tab) {
  document.getElementById('loginForm').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active',    tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
}
function showAuthError(id, msg)    { const el = document.getElementById(id); el.textContent = msg; el.style.display = 'block'; }
function hideAuthError(id)         { document.getElementById(id).style.display = 'none'; }
function showAuthSuccess(id, msg)  { const el = document.getElementById(id); el.textContent = msg; el.style.display = 'block'; }

// ─── LOGIN ────────────────────────────────────────────────
async function handleLogin() {
  hideAuthError('loginError');
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { showAuthError('loginError', 'Vul email en wachtwoord in'); return; }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Bezig...';

  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password })
    });
    const data = await res.json();
    if (!res.ok) { showAuthError('loginError', data.error || 'Inloggen mislukt'); return; }

    saveSession(data.session, data.user);
    enterApp();
  } catch (e) { showAuthError('loginError', 'Verbinding mislukt: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Inloggen'; }
}

// ─── REGISTER ─────────────────────────────────────────────
async function handleRegister() {
  hideAuthError('registerError');
  const fullName = document.getElementById('regName').value.trim();
  const email    = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  if (!email || !password) { showAuthError('registerError', 'Vul alle velden in'); return; }
  if (password.length < 8) { showAuthError('registerError', 'Wachtwoord minimaal 8 tekens'); return; }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.textContent = 'Account aanmaken...';

  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', email, password, fullName })
    });
    const data = await res.json();
    if (!res.ok) { showAuthError('registerError', data.error || 'Registratie mislukt'); return; }

    // Als sessie direct beschikbaar (email verificatie uitgeschakeld)
    if (data.session) { saveSession(data.session, data.user); enterApp(); return; }

    showAuthSuccess('registerSuccess', '✅ Account aangemaakt! Check je email om te bevestigen, dan kun je inloggen.');
    showAuthTab('login');
  } catch (e) { showAuthError('registerError', 'Verbinding mislukt: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Account aanmaken'; }
}

// ─── LOGOUT ───────────────────────────────────────────────
function handleLogout() {
  clearSession();
  currentStores = [];
  document.getElementById('authScreen').style.display = 'block';
  document.getElementById('appScreen').style.display  = 'none';
  document.getElementById('loginEmail').value    = '';
  document.getElementById('loginPassword').value = '';
}

// ═══════════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════════
window.addEventListener('load', async () => {
  // Enter-toets in auth forms
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const lf = document.getElementById('loginForm');
      const rf = document.getElementById('registerForm');
      if (lf && lf.style.display !== 'none') handleLogin();
      else if (rf && rf.style.display !== 'none') handleRegister();
    }
  });

  // ── Supabase email bevestiging redirect afhandelen ──────
  // Na email klik stuurt Supabase je terug met #access_token=... in de URL
  const hash = window.location.hash;
  if (hash && hash.includes('access_token=')) {
    const params = new URLSearchParams(hash.replace('#', ''));
    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn    = parseInt(params.get('expires_in') || '3600');

    if (accessToken) {
      // Haal gebruikersinfo op via de token
      try {
        const res = await fetch(`${API}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': accessToken },
          body: JSON.stringify({ action: 'me' })
        });
        // Bouw sessie op met de token uit de URL
        const session = {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Math.floor(Date.now() / 1000) + expiresIn
        };
        const user = { email: params.get('email') || '' };
        saveSession(session, user);
        // Verwijder de token uit de URL (netjes)
        window.history.replaceState({}, document.title, '/');
        enterApp();
        return;
      } catch {}
    }
  }

  if (loadSavedSession() && isSessionValid()) {
    enterApp();
  } else if (loadSavedSession() && currentSession?.refresh_token) {
    const ok = await ensureSession();
    if (ok) enterApp();
    else showAuthScreen();
  } else {
    showAuthScreen();
  }
});

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'block';
  document.getElementById('appScreen').style.display  = 'none';
}

async function enterApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appScreen').style.display  = 'block';

  // Update user info in sidebar
  const email = currentUser?.email || '';
  const name  = currentUser?.fullName || email.split('@')[0] || 'Gebruiker';
  document.getElementById('userName').textContent   = name;
  document.getElementById('userPlan').textContent   = 'Free plan';
  document.getElementById('userAvatar').textContent = name.charAt(0).toUpperCase() || 'G';

  // Navigatie events
  document.querySelectorAll('#sideNav .nav-item').forEach(item => {
    item.addEventListener('click', () => {
      switchTab(item.dataset.tab);
      // Mobile: sluit sidebar
      if (window.innerWidth <= 768) toggleSidebar(false);
    });
  });

  await loadStores();
  loadDashboard();
}

function switchTab(tab) {
  if (tab === 'analyse') initAnalyse();
  // Verberg periode selector op tabs waar het niet relevant is
  const hidePeriod = ['analyse', 'scorer', 'generator', 'concurrent', 'stores', 'settings'];
  const periodGroup = document.querySelector('.period-group');
  const syncBtn     = document.getElementById('syncBtn');
  const refreshBtn  = document.getElementById('refreshBtn');
  const livePill    = document.getElementById('livePill');
  if (periodGroup) periodGroup.style.display = hidePeriod.includes(tab) ? 'none' : '';
  if (syncBtn)     syncBtn.style.display     = hidePeriod.includes(tab) ? 'none' : '';
  const _fullSyncBtn = document.getElementById('fullSyncBtn');
  if (_fullSyncBtn) _fullSyncBtn.style.display = hidePeriod.includes(tab) ? 'none' : '';
  if (refreshBtn)  refreshBtn.style.display  = hidePeriod.includes(tab) ? 'none' : '';
  if (livePill)    livePill.style.display    = hidePeriod.includes(tab) ? 'none' : '';
  document.querySelectorAll('#sideNav .nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const navItem = document.querySelector(`[data-tab="${tab}"]`);
  if (navItem) navItem.classList.add('active');
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.classList.add('active');

  // Update topbar title
  const titles = { dashboard:'Sales Dashboard', analyse:'Advertentie Analyse', scorer:'Tekst Scorer', generator:'Tekst Generator', concurrent:'Concurrentie Analyse', stores:'Mijn Winkels' };
  document.getElementById('topbarTitle').textContent = titles[tab] || tab;
}

// ═══════════════════════════════════════════════════════════
// MOBILE SIDEBAR
// ═══════════════════════════════════════════════════════════
function toggleSidebar(forceClose) {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebarOverlay');
  const isOpen   = sidebar.classList.contains('open');
  const newState = forceClose === true ? false : !isOpen;
  sidebar.classList.toggle('open', newState);
  overlay.classList.toggle('open', newState);
}

// ═══════════════════════════════════════════════════════════
// STORES
// ═══════════════════════════════════════════════════════════
async function loadStores() {
  if (!await ensureSession()) return;
  try {
    const res = await fetch(`${API}/api/stores`, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    currentStores = data.stores || [];
    renderStoreList();
    updateStoreSelector();
  } catch (e) { console.error('loadStores:', e); }
}


// ── Stores pagina tabs ────────────────────────────────────
function switchStoreTab(tab) {
  ['retailer','ads'].forEach(t => {
    document.getElementById('storeTab-' + t).style.display     = t === tab ? 'block' : 'none';
    document.getElementById('storeTabBtn-' + t).className = t === tab ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  });
  if (tab === 'ads') refreshAdsStoreSelect();
}

function refreshAdsStoreSelect() {
  const sel = document.getElementById('adsStoreSelect');
  if (!sel) return;
  const bolStores = currentStores.filter(s => s.platform === 'bol');
  sel.innerHTML = '<option value="">— Selecteer winkel —</option>' +
    bolStores.map(s => `<option value="${s.id}">${s.name}${s.ads_client_id_enc ? ' ✓ Ads gekoppeld' : ''}</option>`).join('');
  if (bolStores.length === 1) sel.value = bolStores[0].id;
}

async function saveAdsFromPage() {
  const storeId         = document.getElementById('adsStoreSelect').value;
  const adsClientId     = document.getElementById('adsPageClientId').value.trim();
  const adsClientSecret = document.getElementById('adsPageClientSecret').value.trim();
  const errEl           = document.getElementById('adsPageError');
  const btn             = document.getElementById('adsPageSaveBtn');

  errEl.style.display = 'none';
  if (!storeId)         { errEl.textContent = 'Selecteer eerst een winkel'; errEl.style.display = 'block'; return; }
  if (!adsClientId || !adsClientSecret) { errEl.textContent = 'Vul Client ID en Secret in'; errEl.style.display = 'block'; return; }

  btn.disabled = true; btn.textContent = '⏳ Verifiëren...';

  try {
    const res  = await fetch(`${API}/api/sync/bol-ads`, {
      method: 'POST', headers: getAuthHeaders(),
      body: JSON.stringify({ storeId, adsClientId, adsClientSecret })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || 'Koppelen mislukt';
      errEl.style.display = 'block'; return;
    }

    document.getElementById('adsPageClientId').value     = '';
    document.getElementById('adsPageClientSecret').value = '';
    await loadStores();
    refreshAdsStoreSelect();
    showToast('✓ Advertising API succesvol gekoppeld!', 'success');

  } catch(e) {
    errEl.textContent = 'Fout: ' + e.message; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '📊 Advertising API koppelen';
  }
}

function renderStoreList() {
  const el = document.getElementById('storeList');
  if (!currentStores.length) {
    el.innerHTML = `<div class="empty-state" style="padding:2rem;">
      <div class="empty-icon">🏪</div>
      <p>Nog geen winkels gekoppeld.</p>
      <p style="font-size:0.8rem;color:var(--muted-fg);margin-top:0.5rem;">Koppel je eerste bol.com winkel hiernaast.</p>
    </div>`;
    return;
  }
  const platformEmoji = { bol:'🏪', etsy:'🎨', amazon:'📦', pinterest:'📌' };
  el.innerHTML = currentStores.map(s => {
    const lastSync = s.last_synced_at 
      ? 'Gesynchroniseerd: ' + new Date(s.last_synced_at).toLocaleString('nl-NL', { dateStyle:'short', timeStyle:'short' })
      : 'Nog niet gesynchroniseerd';
    return `<div class="store-card">
      <div class="store-platform-icon">${platformEmoji[s.platform] || '🏪'}</div>
      <div class="store-info">
        <div class="store-name">${s.name}</div>
        <div class="store-platform">${s.platform}</div>
        <div class="store-sync">${lastSync}</div>
      </div>
      <div style="display:flex;gap:0.5rem;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" onclick="triggerSyncForStore('${s.id}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Sync
        </button>
        ${s.platform === 'bol' && !s.ads_client_id_enc ? `<button class="btn btn-ghost btn-sm" style="font-size:0.72rem;" onclick="switchStoreTab('ads')">📊 + Ads</button>` : ''}
        ${s.platform === 'bol' && s.ads_client_id_enc ? `<span style="font-size:0.7rem;color:var(--success);font-weight:600;padding:0.2rem 0.4rem;border:1px solid var(--success);border-radius:999px;">✓ Ads</span>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteStore('${s.id}')">✕</button>
      </div>
    </div>`;
  }).join('');
}

function updateStoreSelector() {
  const sel = document.getElementById('storeSelect');
  sel.innerHTML = '<option value="">— Alle winkels —</option>' +
    currentStores.map(s => `<option value="${s.id}">${s.name} (${s.platform})</option>`).join('');
  sel.value = selectedStoreId;
}

function onStoreChange() {
  selectedStoreId = document.getElementById('storeSelect').value;
  if (document.getElementById('tab-dashboard').classList.contains('active')) {
    loadDashboard();
  }
}


function selectPlatform(p) {
  selectedPlatform = p;
  ['bol','etsy','amazon'].forEach(pl => {
    const btn = document.getElementById('platformBtn-' + pl);
    if (btn) btn.className = pl === p ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  });

  const bolForm   = document.getElementById('bolConnectForm');
  const oauthForm = document.getElementById('oauthConnectForm');
  const oauthInfo = document.getElementById('oauthPlatformInfo');

  if (p === 'bol') {
    if (bolForm)   bolForm.style.display   = 'block';
    if (oauthForm) oauthForm.style.display = 'none';
  } else {
    if (bolForm)   bolForm.style.display   = 'none';
    if (oauthForm) oauthForm.style.display = 'block';

    const platformInfo = {
      etsy: {
        icon: '🎨', name: 'Etsy',
        desc: 'Verbind je Etsy shop via veilige OAuth. Je wordt doorgestuurd naar Etsy om toegang te verlenen.',
        note: 'Vereist: een actieve Etsy seller account.',
        btnLabel: 'Verbind met Etsy'
      },
      amazon: {
        icon: '📦', name: 'Amazon',
        desc: 'Verbind je Amazon Seller account via de Selling Partner API.',
        note: '⚠️ Vereist Amazon SP-API developer goedkeuring (1-2 weken). Vraag je Developer ID aan in Amazon Seller Central.',
        btnLabel: 'Verbind met Amazon'
      }
    };

    const i = platformInfo[p] || { icon:'🔗', name: p, desc:'', note:'', btnLabel:'Verbinden' };
    if (oauthInfo) oauthInfo.innerHTML = `
      <div style="text-align:center;padding:1rem 0 0.5rem;">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;">${i.icon}</div>
        <div style="font-weight:600;font-size:1rem;margin-bottom:0.4rem;">${i.name} koppelen</div>
        <div style="font-size:0.82rem;color:var(--muted-fg);margin-bottom:0.75rem;line-height:1.5;">${i.desc}</div>
        <div class="alert alert-info" style="font-size:0.75rem;text-align:left;margin-bottom:1rem;">${i.note}</div>
        <button class="btn btn-primary" style="width:100%;" onclick="startOAuth('${p}')">🔗 ${i.btnLabel}</button>
      </div>`;
  }
}

async function startOAuth(platform) {
  if (!await ensureSession()) return;
  try {
    const res  = await fetch(`${API}/api/sync/${platform}?action=oauth-url`, { headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'OAuth starten mislukt — controleer of de API keys geconfigureerd zijn in Vercel.'); return; }
    window.open(data.url, '_blank', 'width=620,height=700,left=200,top=100');

    // Poll elke 3s of store is bijgekomen
    let polls = 0;
    const poll = setInterval(async () => {
      polls++;
      await loadStores();
      const newStore = currentStores.find(s => s.platform === platform);
      if (newStore || polls > 40) {
        clearInterval(poll);
        if (newStore) { showToast(`✅ ${platform} succesvol gekoppeld!`); switchTab('stores'); }
      }
    }, 3000);
  } catch (e) { alert('Verbinding mislukt: ' + e.message); }
}

async function addStore() {
  const name         = document.getElementById('storeName').value.trim();
  const clientId     = document.getElementById('storeClientId').value.trim();
  const clientSecret = document.getElementById('storeClientSecret').value.trim();
  const errEl        = document.getElementById('addStoreError');
  errEl.style.display = 'none';

  if (!clientId || !clientSecret) { errEl.textContent = 'Vul Client ID en Client Secret in'; errEl.style.display = 'block'; return; }
  if (!await ensureSession()) return;

  const btn = document.getElementById('addStoreBtn');
  btn.disabled = true; btn.textContent = '🔍 Valideren & koppelen...';

  try {
    const res = await fetch(`${API}/api/stores`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ platform: 'bol', name: name || undefined, clientId, clientSecret })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error + (data.detail ? ` — ${data.detail}` : '');
      errEl.style.display = 'block';
      return;
    }

    document.getElementById('storeName').value         = '';
    document.getElementById('storeClientId').value     = '';
    document.getElementById('storeClientSecret').value = '';

    // Sla advertising credentials op als ingevuld
    const adsClientId     = document.getElementById('adsClientId')?.value.trim();
    const adsClientSecret = document.getElementById('adsClientSecret')?.value.trim();
    if (adsClientId && adsClientSecret && data.store?.id) {
      await fetch(`${API}/api/sync/bol-ads`, {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({ storeId: data.store.id, adsClientId, adsClientSecret })
      });
      document.getElementById('adsClientId').value     = '';
      document.getElementById('adsClientSecret').value = '';
    }

    await loadStores();
    const storeId = data.store.id;
    const doSync  = confirm(`✅ Winkel "${data.store.name}" gekoppeld!\n\nWil je nu direct een volledige sync uitvoeren? Dit importeert je bestellingen van de afgelopen 90 dagen.\n\n(Dit duurt ~30 seconden)`);
    if (doSync) triggerSyncForStore(storeId, true);

  } catch (e) { errEl.textContent = 'Verbinding mislukt: ' + e.message; errEl.style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = '🔗 Winkel koppelen & valideren'; }
}

// Toast notificatie
function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;background:${type==='success'?'var(--success)':'var(--danger)'};color:#fff;padding:0.75rem 1.25rem;border-radius:0.6rem;font-size:0.85rem;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.2);animation:slideUp 0.3s ease;`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// Check OAuth callback params bij pagina laden
window.addEventListener('load', () => {
  const p = new URLSearchParams(window.location.search);
  if (p.get('etsy_connected'))   { setTimeout(() => { showToast('✅ Etsy winkel gekoppeld!'); loadStores(); }, 800); window.history.replaceState({}, '', '/'); }
  if (p.get('amazon_connected')) { setTimeout(() => { showToast('✅ Amazon winkel gekoppeld!'); loadStores(); }, 800); window.history.replaceState({}, '', '/'); }
  if (p.get('etsy_error') || p.get('amazon_error')) { setTimeout(() => { showToast('❌ Koppeling mislukt. Probeer opnieuw.', 'error'); }, 800); window.history.replaceState({}, '', '/'); }
});


async function deleteStore(storeId) {
  if (!confirm('Weet je zeker dat je deze winkel wilt verwijderen? Je gesynchroniseerde data blijft bewaard.')) return;
  if (!await ensureSession()) return;

  try {
    const res = await fetch(`${API}/api/stores?id=${storeId}`, { method: 'DELETE', headers: getAuthHeaders() });
    if (res.ok) { await loadStores(); }
  } catch (e) { alert('Verwijderen mislukt: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════
// SYNC
// ═══════════════════════════════════════════════════════════
function openSyncModal(text) {
  document.getElementById('syncModalText').textContent = text || 'Bezig met synchroniseren...';
  document.getElementById('syncResult').style.display = 'none';
  document.getElementById('syncCloseBtn').style.display = 'none';
  document.getElementById('syncModal').classList.add('open');
}
function closeSyncModal() {
  document.getElementById('syncModal').classList.remove('open');
}

async function triggerSync(fullSync) {
  // Sync de actieve store of de eerste store
  const storeId = selectedStoreId || currentStores[0]?.id;
  if (!storeId) { alert('Geen winkel geselecteerd. Ga naar "Mijn Winkels" om een winkel te koppelen.'); return; }
  triggerSyncForStore(storeId, fullSync);
}

async function triggerSyncForStore(storeId, fullSync = false) {
  if (!await ensureSession()) return;

  const isFullSync = fullSync === true;
  openSyncModal(isFullSync ? 'Volledige sync gestart...' : 'Bestellingen ophalen...');

  let totalOrders = 0;
  const updateStatus = (msg) => {
    document.getElementById('syncModalText').textContent = msg + ` (${totalOrders} verwerkt)`;
  };

  try {
    // STAP 1: Open orders ophalen
    let page = 1, hasMore = true;
    while (hasMore) {
      updateStatus(`Open bestellingen — pagina ${page}`);
      const res = await fetch(`${API}/api/sync/bol`, {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify({ storeId, mode: 'orders', page })
      });
      const data = await res.json();
      if (!res.ok) { showSyncError(data.error, data.detail); return; }
      totalOrders += data.ordersNew || 0;
      hasMore = data.hasMore === true;
      page = data.nextPage || page + 1;
    }

    // STAP 2: Volledige sync — historische shipments ophalen
    if (isFullSync) {
      page = 1; hasMore = true;
      while (hasMore) {
        updateStatus(`Historische verzendingen — pagina ${page}`);
        const res = await fetch(`${API}/api/sync/bol`, {
          method: 'POST', headers: getAuthHeaders(),
          body: JSON.stringify({ storeId, mode: 'shipments', page })
        });
        const data = await res.json();
        if (!res.ok) { showSyncError(data.error, data.detail); return; }
        totalOrders += data.ordersNew || 0;
        hasMore = data.hasMore === true;
        page = data.nextPage || page + 1;
      }
    }

    // STAP 3: Finalize
    await fetch(`${API}/api/sync/bol`, {
      method: 'POST', headers: getAuthHeaders(),
      body: JSON.stringify({ storeId, mode: 'finalize' })
    });

    const resultEl = document.getElementById('syncResult');
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="alert alert-success">Sync voltooid! <strong>${totalOrders} bestellingen</strong> gesynchroniseerd.</div>`;
    document.getElementById('syncCloseBtn').style.display = 'inline-flex';
    document.getElementById('syncModalText').textContent = 'Sync voltooid!';
    await loadStores();
    loadDashboard();

  } catch (e) {
    showSyncError('Verbinding mislukt: ' + e.message);
  }
}

function showSyncError(msg, detail) {
  document.getElementById('syncResult').innerHTML = `<div class="alert alert-danger">${msg}${detail ? '<br><small>' + detail + '</small>' : ''}</div>`;
  document.getElementById('syncResult').style.display = 'block';
  document.getElementById('syncCloseBtn').style.display = 'inline-flex';
  document.getElementById('syncModalText').textContent = 'Sync mislukt';
}


// ═══════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════
async function loadDashboard() {
  if (dashboardLoading) return;
  dashboardLoading = true;

  const content    = document.getElementById('dashboardContent');
  const loading    = document.getElementById('dashboardLoading');
  const errorDiv   = document.getElementById('dashboardError');
  const noStores   = document.getElementById('dashboardNoStores');
  const syncBanner = document.getElementById('syncBanner');
  const syncBtn    = document.getElementById('syncBtn');
  const refreshBtn = document.getElementById('refreshBtn');

  content.style.display  = 'none';
  errorDiv.style.display = 'none';
  noStores.style.display = 'none';
  syncBanner.style.display = 'none';
  loading.style.display  = 'block';

  if (!await ensureSession()) { loading.style.display = 'none'; showAuthScreen(); dashboardLoading = false; return; }

  if (!currentStores.length) {
    loading.style.display  = 'none';
    noStores.style.display = 'block';
    dashboardLoading = false; return;
  }

  syncBtn.style.display    = 'inline-flex';
  const _fsb = document.getElementById('fullSyncBtn');
  if (_fsb) _fsb.style.display = 'inline-flex';
  refreshBtn.style.display = 'inline-flex';
  document.getElementById('livePill').style.display = 'inline-flex';

  const start = document.getElementById('startDate').value;
  const end   = document.getElementById('endDate').value;
  let url = `${API}/api/dashboard?startDate=${start}&endDate=${end}&compareMode=${compareMode}`;
  if (selectedStoreId) url += `&storeId=${selectedStoreId}`;

  try {
    const res  = await fetch(url, { headers: getAuthHeaders() });
    const data = await res.json();
    loading.style.display = 'none';

    if (!res.ok) {
      document.getElementById('dashboardErrorMsg').textContent    = data.error || 'Fout';
      document.getElementById('dashboardErrorDetail').textContent = data.detail || '';
      errorDiv.style.display = 'block';
      dashboardLoading = false; return;
    }

    // Toon sync banner als er geen data is maar wel een store
    if (data.samenvatting.totalBestellingen === 0 && currentStores.length > 0) {
      syncBanner.style.display = 'block';
    }

    renderDashboard(data);
  } catch (e) {
    loading.style.display = 'none';
    document.getElementById('dashboardErrorMsg').textContent = 'Verbinding mislukt: ' + e.message;
    errorDiv.style.display = 'block';
  }
  dashboardLoading = false;
}

// Vergelijkmodus: 0=vorige periode, 1=vorig jaar, 2=geen
let compareMode = 0;
let lastDashboardData = null;
let omzetChart = null;
let productChart = null;

function setCompare(mode) {
  compareMode = mode;
  [0,1,2].forEach(i => {
    const btn = document.getElementById('cmpBtn' + i);
    if (btn) btn.className = i === mode ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
  });
  if (lastDashboardData) renderDashboard(lastDashboardData);
}

function renderDashboard(data) {
  lastDashboardData = data;
  const s   = data.samenvatting || {};
  const fmt = n => '€' + (n||0).toLocaleString('nl-NL', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const fmtPct = (curr, prev) => {
    if (!prev || prev === 0) return null;
    const pct = Math.round((curr - prev) / prev * 100);
    return { pct, label: (pct >= 0 ? '+' : '') + pct + '%', pos: pct >= 0 };
  };

  document.getElementById('dashboardContent').style.display = 'block';

  const perDag = data.perDag || [];
  const actieveDagen = perDag.filter(d => d.omzet > 0).length;
  const gemPerDag = actieveDagen > 0 ? s.totalOmzet / actieveDagen : 0;

  // ── Vergelijkperiode ophalen ───────────────────────────────
  const cmpData = data.vergelijking || null;
  const cmpS    = cmpData?.samenvatting || null;
  const cmpDag  = cmpData?.perDag || [];

  // Labels voor vergelijking
  const cmpLabels = ['Vorige periode', 'Vorig jaar', ''];
  document.getElementById('cmpLabel').textContent = compareMode < 2 && cmpS ? `vs. ${cmpLabels[compareMode]}` : '';
  const cmpLegend = document.getElementById('cmpLegend');
  if (cmpLegend) cmpLegend.style.display = compareMode < 2 && cmpS ? '' : 'none';

  // ── KPI values ────────────────────────────────────────────
  document.getElementById('kpiOmzet').textContent        = fmt(s.totalOmzet);
  document.getElementById('kpiBestellingen').textContent = (s.totalBestellingen||0).toLocaleString('nl-NL');
  document.getElementById('kpiGem').textContent          = fmt(s.gemOmzetPerBestelling);
  document.getElementById('kpiPeriode').textContent      = (s.periode?.start||'') + ' → ' + (s.periode?.end||'');
  document.getElementById('kpiPerDag').textContent       = fmt(gemPerDag);

  // ── KPI badges met vergelijking ───────────────────────────
  const setBadge = (id, text, isPos) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!text) { el.textContent = '—'; el.className = 'kpi-badge'; return; }
    el.textContent = text;
    el.className = 'kpi-badge' + (isPos === false ? ' neg' : '');
  };

  if (compareMode < 2 && cmpS) {
    const o = fmtPct(s.totalOmzet,          cmpS.totalOmzet);
    const b = fmtPct(s.totalBestellingen,    cmpS.totalBestellingen);
    const g = fmtPct(s.gemOmzetPerBestelling, cmpS.gemOmzetPerBestelling);
    setBadge('kpiBadge1', o?.label, o?.pos);
    setBadge('kpiBadge2', b?.label, b?.pos);
    setBadge('kpiBadge3', g?.label, g?.pos);
  } else {
    setBadge('kpiBadge1', s.totalOmzet > 0 ? 'bol.com' : null, true);
    setBadge('kpiBadge2', actieveDagen > 0 ? actieveDagen + ' actieve dagen' : null, true);
    setBadge('kpiBadge3', null);
  }
  setBadge('kpiBadge4', actieveDagen > 0 ? Math.round(actieveDagen / (perDag.length||1) * 100) + '% bezetting' : null, actieveDagen / (perDag.length||1) > 0.5);

  // ── Omzet lijnGrafiek ─────────────────────────────────────
  const labels   = perDag.map(d => d.datum.substring(5)); // MM-DD
  const omzetNu  = perDag.map(d => Math.round(d.omzet * 100) / 100);
  const omzetCmp = cmpDag.length ? cmpDag.map(d => Math.round(d.omzet * 100) / 100) : null;

  const chartCtx = document.getElementById('omzetLineChart');
  if (chartCtx) {
    if (omzetChart) omzetChart.destroy();
    const datasets = [{
      label: 'Omzet',
      data: omzetNu,
      borderColor: 'hsl(25,95%,53%)',
      backgroundColor: 'hsla(25,95%,53%,0.08)',
      borderWidth: 2,
      pointRadius: perDag.length > 60 ? 0 : 3,
      pointHoverRadius: 5,
      fill: true,
      tension: 0.3
    }];
    if (omzetCmp && compareMode < 2) {
      datasets.push({
        label: cmpLabels[compareMode],
        data: omzetCmp.slice(0, labels.length),
        borderColor: 'hsl(210,70%,60%)',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4,3],
        pointRadius: 0,
        fill: false,
        tension: 0.3
      });
    }
    omzetChart = new Chart(chartCtx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: compareMode < 2 && cmpS },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + fmt(ctx.raw)
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
          y: { grid: { color: 'hsla(0,0%,50%,0.1)' }, ticks: { callback: v => '€' + v.toLocaleString('nl-NL'), font: { size: 10 } } }
        }
      }
    });
  }

  // ── Top producten tabel ───────────────────────────────────
  const prods = data.topProducten || [];
  if (!prods.length) {
    document.getElementById('topProductenTable').innerHTML = '<p style="color:var(--muted-fg);font-size:0.85rem;">Geen producten. Voer eerst een sync uit.</p>';
  } else {
    const maxO = Math.max(...prods.map(p => p.omzet));
    document.getElementById('topProductenTable').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Product</th><th style="text-align:right">Stuks</th><th style="text-align:right">Omzet</th></tr></thead>
      <tbody>${prods.map((p,i) => `<tr>
        <td style="color:var(--muted-fg);font-size:0.7rem;">${i+1}</td>
        <td><div style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.titel}">${p.titel}</div>
          <div style="height:3px;background:var(--muted);border-radius:999px;margin-top:4px;"><div style="height:3px;border-radius:999px;background:var(--primary);width:${Math.round(p.omzet/maxO*100)}%"></div></div>
        </td>
        <td style="text-align:right">${p.stuks}</td>
        <td style="text-align:right;font-weight:600;color:var(--primary);">${fmt(p.omzet)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // ── Product omzet grafiek ─────────────────────────────────
  const prodCtx = document.getElementById('productChart');
  if (prodCtx && prods.length) {
    if (productChart) productChart.destroy();
    const top8 = prods.slice(0, 8);
    productChart = new Chart(prodCtx, {
      type: 'line',
      data: {
        labels: top8.map(p => p.titel.substring(0, 22) + (p.titel.length > 22 ? '…' : '')),
        datasets: [{
          label: 'Omzet excl. BTW',
          data: top8.map(p => Math.round(p.omzet * 100) / 100),
          borderColor: 'hsl(25,95%,53%)',
          backgroundColor: 'hsla(25,95%,53%,0.1)',
          borderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          fill: true,
          tension: 0.2
        }, {
          label: 'Stuks',
          data: top8.map(p => p.stuks),
          borderColor: 'hsl(210,70%,55%)',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 4,
          borderDash: [4,3],
          yAxisID: 'y2',
          tension: 0.2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top', labels: { font: { size: 10 } } },
          tooltip: { callbacks: { label: ctx => ctx.datasetIndex === 0 ? ' ' + fmt(ctx.raw) : ' ' + ctx.raw + ' stuks' } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 } } },
          y:  { position: 'left',  ticks: { callback: v => '€' + v, font: { size: 9 } }, grid: { color: 'hsla(0,0%,50%,0.1)' } },
          y2: { position: 'right', ticks: { font: { size: 9 } }, grid: { display: false } }
        }
      }
    });
  }

  // ── Conversie tips ────────────────────────────────────────
  const tips = [];
  const gemW    = s.gemOmzetPerBestelling || 0;
  const inactPct = perDag.length > 0 ? Math.round((perDag.length - actieveDagen) / perDag.length * 100) : 0;
  if (prods.length > 0) {
    const top1pct = prods[0].omzet / (s.totalOmzet || 1) * 100;
    if (top1pct > 70) tips.push({ icon:'⚠️', titel:'Productrisico', tekst:`${Math.round(top1pct)}% omzet uit 1 product. Overweeg sortiment uitbreiden.` });
    tips.push({ icon:'🔗', titel:'Cross-sell kans', tekst:`Bundel "${prods[0].titel.substring(0,25)}..." met andere producten.` });
  }
  if (gemW < 25 && gemW > 0) tips.push({ icon:'💶', titel:'Verhoog orderwaarde', tekst:`Gem. ${fmt(gemW)}. Bied gratis verzending boven €30 aan.` });
  if (inactPct > 40) tips.push({ icon:'📅', titel:'Onregelmatige verkoop', tekst:`${inactPct}% van de dagen geen verkoop. Overweeg dagelijks adverteren.` });
  tips.push({ icon:'⭐', titel:'Reviews boosten', tekst:'Na levering automatisch reviewverzoek sturen via bol.com.' });
  tips.push({ icon:'🔍', titel:'SEO optimalisatie', tekst:'Gebruik de Tekst Scorer voor je top 3 producten.' });
  document.getElementById('conversieTips').innerHTML = tips.slice(0,5).map(t => `
    <div style="display:flex;gap:0.75rem;margin-bottom:0.85rem;padding-bottom:0.85rem;border-bottom:1px solid var(--border);">
      <div style="flex-shrink:0;font-size:1.1rem;">${t.icon}</div>
      <div><div style="font-weight:600;font-size:0.82rem;margin-bottom:0.15rem;">${t.titel}</div>
      <div style="font-size:0.78rem;color:var(--muted-fg);line-height:1.45;">${t.tekst}</div></div>
    </div>`).join('');

  // ── Actiepunten ───────────────────────────────────────────
  const acties = [
    { k:'var(--primary)', t:'Adverteer op bestseller', a:`Start gesponsord product voor "${(prods[0]?.titel||'je topseller').substring(0,30)}..." met €5-10/dag.`, i:'Hoog' },
    { k:'var(--success)', t:'Teksten optimaliseren',   a:'Gebruik de Tekst Scorer voor je top 3. Alles onder 70 punten heeft verbeterpotentieel.', i:'Middel' },
    { k:'var(--info)',    t:'Prijsstrategie testen',   a:`Gem. orderwaarde ${fmt(gemW)}. Test gratis verzending boven €${Math.round(gemW*1.3)}.`, i:'Middel' },
  ];
  document.getElementById('actiepunten').innerHTML = acties.map(a => `
    <div style="padding:0.85rem 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.3rem;">
        <div style="font-weight:600;font-size:0.82rem;border-left:3px solid ${a.k};padding-left:0.5rem;">${a.t}</div>
        <span class="pill pill-${a.i==='Hoog'?'orange':'blue'}">${a.i}</span>
      </div>
      <div style="font-size:0.77rem;color:var(--muted-fg);line-height:1.45;padding-left:0.75rem;">${a.a}</div>
    </div>`).join('');

  // Platform breakdown
  const platforms = data.perPlatform || [];
  if (platforms.length > 1) {
    document.getElementById('platformCard').style.display = 'block';
    document.getElementById('platformBreakdown').innerHTML = `<div class="kpi-grid">${
      platforms.map(p => `<div class="kpi-card" style="padding:1rem;">
        <div style="font-weight:600;margin-bottom:0.3rem;">${p.platform}</div>
        <div style="font-family:var(--font-h);font-size:1.3rem;font-weight:700;color:var(--primary);">${fmt(p.omzet)}</div>
        <div style="font-size:0.75rem;color:var(--muted-fg);">${p.bestellingen} bestellingen</div>
      </div>`).join('')
    }</div>`;
  }
}

// ── Zoekpositie tracker ───────────────────────────────────────
const zoekpositieCache = {};

async function checkZoekpositie() {
  const term   = document.getElementById('zoekEan').value.trim();
  const result = document.getElementById('zoekpositieResult');
  if (!term) return;

  result.innerHTML = '<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;color:var(--muted-fg);"><span class="spinner"></span> Positie opzoeken...</div>';

  try {
    const storeId = selectedStoreId || (currentStores.find(s => s.platform === 'bol')?.id || '');
    const url = `${API}/api/zoekpositie?term=${encodeURIComponent(term)}${storeId ? '&storeId=' + storeId : ''}`;
    const res  = await fetch(url, { headers: getAuthHeaders() });
    const data = await res.json();

    if (!res.ok) {
      result.innerHTML = `<div class="alert alert-danger" style="font-size:0.78rem;">${data.error || 'API fout'}</div>`;
      return;
    }

    // EAN resultaat
    if (data.ean) {
      const pos   = data.eigenAanbod?.ranking || data.positie;
      const kleur = !pos ? 'var(--muted-fg)' : pos <= 3 ? 'var(--success)' : pos <= 10 ? 'var(--primary)' : pos <= 20 ? 'hsl(45,90%,50%)' : 'var(--danger)';
      result.innerHTML = `
        <div style="padding:0.75rem;background:var(--muted);border-radius:var(--radius);font-size:0.8rem;">
          <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;">
            ${pos ? `<div style="font-size:1.8rem;font-weight:700;color:${kleur};font-family:var(--font-h);">#${pos}</div>` : '<div style="font-size:1.3rem;">—</div>'}
            <div>
              <div style="font-weight:600;">${data.titel || data.ean}</div>
              <div style="font-size:0.7rem;color:var(--muted-fg);">${data.aantalAanbieders || 0} aanbieders${data.product?.rating ? ' · ⭐ ' + data.product.rating : ''}</div>
            </div>
          </div>
          ${data.eigenPrijs ? `<div style="display:flex;gap:1rem;">
            <span>Jouw prijs: <strong>€${data.eigenPrijs}</strong></span>
            ${data.laagstePrijs && data.laagstePrijs !== data.eigenPrijs ? `<span style="color:var(--danger)">Laagste: €${data.laagstePrijs}</span>` : ''}
          </div>` : ''}
          <div style="margin-top:0.4rem;font-size:0.72rem;color:var(--muted-fg);">${data.tip || ''}</div>
        </div>`;

      if (pos) {
        if (!zoekpositieCache[term]) zoekpositieCache[term] = [];
        zoekpositieCache[term].unshift({ datum: new Date().toLocaleDateString('nl-NL'), positie: pos });
        if (zoekpositieCache[term].length > 5) zoekpositieCache[term].pop();
        renderZoekHistory(term);
      }
      return;
    }

    // Zoekterm resultaat
    if (data.resultaten) {
      result.innerHTML = `<div style="font-size:0.78rem;">
        <div style="color:var(--muted-fg);margin-bottom:0.5rem;">${data.tip}</div>
        ${data.resultaten.map(r => `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="document.getElementById('zoekEan').value='${r.ean}';checkZoekpositie();">
          <span style="color:var(--muted-fg);">#${r.positie}</span> ${r.titel?.substring(0,40) || r.ean}
          <span style="font-size:0.68rem;color:var(--primary);margin-left:0.5rem;">→ ${r.ean}</span>
        </div>`).join('')}
      </div>`;
      return;
    }

    // Fallback
    result.innerHTML = `<div class="alert alert-warning" style="font-size:0.78rem;">${data.tip || data.error || 'Geen resultaat'}</div>`;

  } catch (e) {
    result.innerHTML = `<div class="alert alert-danger" style="font-size:0.78rem;">Fout: ${e.message}</div>`;
  }
}

function renderZoekHistory(term) {
  const hist = zoekpositieCache[term] || [];
  if (hist.length < 2) return;
  const el = document.getElementById('zoekpositieHistory');
  el.innerHTML = `<div style="font-size:0.72rem;color:var(--muted-fg);margin-bottom:0.3rem;">Geschiedenis voor "${term}":</div>` +
    hist.map(h => `<div style="display:flex;justify-content:space-between;font-size:0.75rem;padding:0.2rem 0;border-bottom:1px solid var(--border);">
      <span>${h.datum}</span><strong>#${h.positie}</strong></div>`).join('');
}


// ═══════════════════════════════════════════════════════════
// ANALYSE — Advertentie analyse met dataset opslag
// ═══════════════════════════════════════════════════════════

// ── Upload modal ─────────────────────────────────────────
function openUploadModal()  { document.getElementById('uploadModal').classList.add('open'); }
function closeUploadModal() { document.getElementById('uploadModal').classList.remove('open'); }

// Sluit modal als je buiten klikt
document.getElementById('uploadModal')?.addEventListener('click', function(e) {
  if (e.target === this) closeUploadModal();
});

// ── Dataset opslag in localStorage ───────────────────────
const DATASETS_KEY = 'thewootz_analyse_datasets';

function getSavedDatasets() {
  try { return JSON.parse(localStorage.getItem(DATASETS_KEY) || '{}'); }
  catch { return {}; }
}

function saveAnalyseDataset() {
  if (!window._lastAnalyseData) return;
  const name = prompt('Naam voor deze dataset:', 'Dataset ' + new Date().toLocaleDateString('nl-NL'));
  if (!name) return;
  const datasets = getSavedDatasets();
  datasets[name] = { data: window._lastAnalyseData, savedAt: new Date().toISOString() };
  localStorage.setItem(DATASETS_KEY, JSON.stringify(datasets));
  refreshDatasetSelect();
  showToast('Dataset "' + name + '" opgeslagen!', 'success');
}

function refreshDatasetSelect() {
  const sel = document.getElementById('analyseDatasetSelect');
  if (!sel) return;
  const datasets = getSavedDatasets();
  const keys = Object.keys(datasets);
  if (!keys.length) { sel.style.display = 'none'; return; }
  sel.style.display = 'inline-block';
  sel.innerHTML = '<option value="">— Opgeslagen datasets —</option>' +
    keys.map(k => `<option value="${k}">${k} (${new Date(datasets[k].savedAt).toLocaleDateString('nl-NL')})</option>`).join('');
}

function loadAnalyseDataset(name) {
  if (!name) return;
  const datasets = getSavedDatasets();
  if (datasets[name]) {
    analyzeData(datasets[name].data);
    showToast('Dataset "' + name + '" geladen!', 'success');
  }
}

// ── File upload ───────────────────────────────────────────
function handleFileUpload(e) {
  const f = e.target.files[0];
  if (f) { closeUploadModal(); processFile(f); }
}

function processFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const text = e.target.result;
      const firstLine = text.split('\n')[0];
      const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
      function parseCSVLine(line, delim) {
        const result=[]; let current=''; let inQuotes=false;
        for (let i=0;i<line.length;i++) {
          const ch=line[i];
          if (ch==='"') { if(inQuotes&&line[i+1]==='"'){current+='"';i++;}else inQuotes=!inQuotes; }
          else if (ch===delim&&!inQuotes){result.push(current.trim());current='';}
          else current+=ch;
        }
        result.push(current.trim()); return result;
      }
      const lines = text.split('\n').filter(r=>r.trim());
      if (lines.length<2) { showDemoData(); return; }
      const headers = parseCSVLine(lines[0], delimiter);
      const rows = lines.slice(1).map(line => {
        const vals = parseCSVLine(line, delimiter);
        const obj = {};
        headers.forEach((h,i) => obj[h.trim()]=vals[i]?.trim()||'');
        return obj;
      }).filter(r=>Object.values(r).some(v=>v));
      if (rows.length===0) { showDemoData(); return; }
      analyzeData(rows);
    } catch { showDemoData(); }
  };
  reader.readAsText(file);
}

function showDemoData() {
  analyzeData([
    {'Productnaam':'TheWootz Snijplank Eiken XL','Advertentie-uitgaven':'45.20','Vertoningen':'12400','Klikken':'89','Bestellingen':'8','Omzet':'319.60'},
    {'Productnaam':'TheWootz Onderhoudsolie 250ml','Advertentie-uitgaven':'18.50','Vertoningen':'8200','Klikken':'45','Bestellingen':'5','Omzet':'74.95'},
    {'Productnaam':'TheWootz Snijplank Walnoot M','Advertentie-uitgaven':'32.10','Vertoningen':'6800','Klikken':'52','Bestellingen':'4','Omzet':'159.80'},
    {'Productnaam':'TheWootz Cadeau Set Premium','Advertentie-uitgaven':'67.80','Vertoningen':'15200','Klikken':'124','Bestellingen':'7','Omzet':'419.65'},
    {'Productnaam':'TheWootz Snijplank Bamboe S','Advertentie-uitgaven':'12.40','Vertoningen':'4100','Klikken':'28','Bestellingen':'2','Omzet':'39.90'},
  ]);
}

// ── Analyseer data ────────────────────────────────────────
let _allAnalyseProducts = [];

function analyzeData(rows) {
  if (!rows.length) { showDemoData(); return; }
  window._lastAnalyseData = rows;

  const nameKey = Object.keys(rows[0]).find(k => /naam|name|product|titel|title/i.test(k)) || Object.keys(rows[0])[0];
  const getNum = (row, ...keys) => {
    for (const k of keys) {
      const match = Object.keys(row).find(rk => rk.toLowerCase().includes(k.toLowerCase()));
      if (match) return parseFloat((row[match]||'0').toString().replace(',','.').replace(/[^0-9.-]/g,''))||0;
    }
    return 0;
  };

  const products = rows.map(row => ({
    naam: row[nameKey]||'Onbekend',
    spend: getNum(row,'uitg','spend','cost','kosten'),
    impressions: getNum(row,'vert','impr'),
    clicks: getNum(row,'klik','click'),
    orders: getNum(row,'best','order','conv'),
    revenue: getNum(row,'omzet','omz','revenue','sales')
  })).filter(p=>p.spend>0||p.revenue>0);

  if (!products.length) { showDemoData(); return; }

  const totSpend   = products.reduce((s,p)=>s+p.spend,0);
  const totRev     = products.reduce((s,p)=>s+p.revenue,0);
  const totOrders  = products.reduce((s,p)=>s+p.orders,0);
  const totClicks  = products.reduce((s,p)=>s+p.clicks,0);
  const totImpr    = products.reduce((s,p)=>s+p.impressions,0);
  const roas       = totSpend > 0 ? totRev/totSpend : 0;
  const cpc        = totClicks > 0 ? totSpend/totClicks : 0;
  const cr         = totClicks > 0 ? totOrders/totClicks*100 : 0;
  const ctr        = totImpr > 0 ? totClicks/totImpr*100 : 0;

  const productsWithConv = products.map(p=>({
    ...p,
    conv: p.clicks>0 ? p.orders/p.clicks*100 : 0,
    roas: p.spend>0 ? p.revenue/p.spend : 0,
    cpc:  p.clicks>0 ? p.spend/p.clicks : 0
  })).sort((a,b)=>b.roas-a.roas);

  _allAnalyseProducts = productsWithConv;

  const fmt = n => '€'+n.toLocaleString('nl-NL',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtNum = n => n.toLocaleString('nl-NL');

  // ── KPIs ─────────────────────────────────────────────────
  const roasKleur = roas >= 3 ? 'var(--success)' : roas >= 1.5 ? 'var(--warning)' : 'var(--danger)';
  document.getElementById('kpiGrid').innerHTML = `<div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">💰</div><span class="kpi-badge">Advertenties</span></div>
      <div class="kpi-value">${fmt(totSpend)}</div>
      <div class="kpi-label">Totale uitgaven</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">→ ${fmt(totRev)} omzet gegenereerd</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">📈</div><span class="kpi-badge" style="color:${roasKleur};">${roas>=2?'✓ Goed':roas>=1?'⚠ Laag':'✗ Verlies'}</span></div>
      <div class="kpi-value" style="color:${roasKleur};">${roas.toFixed(2)}x</div>
      <div class="kpi-label">ROAS</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">Return on Ad Spend</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">🖱️</div></div>
      <div class="kpi-value">${fmt(cpc)}</div>
      <div class="kpi-label">CPC</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">CTR: ${ctr.toFixed(2)}% · ${fmtNum(totClicks)} klikken</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">🎯</div></div>
      <div class="kpi-value">${cr.toFixed(1)}%</div>
      <div class="kpi-label">Conversiepercentage</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">${totOrders} bestellingen · ${fmtNum(totImpr)} vertoningen</div>
    </div>
  </div>`;

  // ── Top & Worst ───────────────────────────────────────────
  const top3   = productsWithConv.slice(0,3);
  const worst3 = [...productsWithConv].sort((a,b)=>a.roas-b.roas).filter(p=>p.spend>5).slice(0,3);
  document.getElementById('topConverters').innerHTML = top3.map((p,i)=>`
    <div style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0;border-bottom:1px solid var(--border);">
      <div style="font-size:1rem;width:24px;text-align:center;">${['🥇','🥈','🥉'][i]}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.82rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.naam}">${p.naam}</div>
        <div style="font-size:0.72rem;color:var(--muted-fg);">ROAS: ${p.roas.toFixed(1)}x · Conv: ${p.conv.toFixed(1)}%</div>
      </div>
    </div>`).join('');

  document.getElementById('worstPerformers').innerHTML = worst3.map(p=>`
    <div style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0;border-bottom:1px solid var(--border);">
      <div style="font-size:1rem;width:24px;text-align:center;">⚠️</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.82rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.naam}">${p.naam}</div>
        <div style="font-size:0.72rem;color:var(--muted-fg);">ROAS: ${p.roas.toFixed(1)}x · Uitgave: ${fmt(p.spend)}</div>
      </div>
    </div>`).join('');

  // ── Tips ──────────────────────────────────────────────────
  const recs = [];
  recs.push({ type: roas>=2?'success':roas>=1?'warning':'danger', msg: roas>=2 ? `✓ Sterke ROAS van ${roas.toFixed(2)}x — je advertenties presteren goed.` : roas>=1 ? `⚠️ ROAS van ${roas.toFixed(2)}x is matig. Streef naar minimaal 2x.` : `✗ ROAS onder 1x — je geeft meer uit dan je verdient. Pauzeer onderpresteerders.` });
  worst3.filter(p=>p.spend>10&&p.roas<1).forEach(p=>recs.push({type:'danger',msg:`Stop advertentie voor "${p.naam.substring(0,35)}" — ROAS slechts ${p.roas.toFixed(2)}x.`}));
  if (top3[0]) recs.push({type:'success',msg:`💡 Verhoog budget voor "${top3[0].naam.substring(0,35)}" — beste presteerder met ROAS ${top3[0].roas.toFixed(1)}x.`});
  if (cr < 2)  recs.push({type:'warning',msg:`Conversiepercentage van ${cr.toFixed(1)}% is laag. Optimaliseer je productpagina en afbeeldingen.`});
  if (cpc > 1) recs.push({type:'warning',msg:`CPC van ${fmt(cpc)} is hoog. Test lagere biedingen of specifiekere zoekwoorden.`});

  document.getElementById('recommendations').innerHTML = `
    <div class="card-title">💡 Aanbevelingen</div>
    ${recs.map(r=>`<div class="alert alert-${r.type==='danger'?'danger':r.type==='success'?'success':'warning'}" style="margin-bottom:0.5rem;font-size:0.8rem;">${r.msg}</div>`).join('')}`;

  // ── Producten tabel ───────────────────────────────────────
  renderAnalyseTable(productsWithConv, fmt);

  // ── Toon content ─────────────────────────────────────────
  document.getElementById('analyseEmpty').style.display   = 'none';
  document.getElementById('analyseContent').style.display = 'block';
  document.getElementById('saveDatasetBtn').style.display = 'inline-flex';
  refreshDatasetSelect();
}

function renderAnalyseTable(products, fmt) {
  fmt = fmt || (n => '€'+n.toLocaleString('nl-NL',{minimumFractionDigits:2,maximumFractionDigits:2}));
  document.getElementById('fullTableHead').innerHTML = '<tr><th>Product</th><th style="text-align:right">Uitgaven</th><th style="text-align:right">Klikken</th><th style="text-align:right">Bestellingen</th><th style="text-align:right">Omzet</th><th style="text-align:right">ROAS</th><th style="text-align:right">Conv.%</th></tr>';
  document.getElementById('fullTableBody').innerHTML = products.map(p=>`<tr>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.naam}">${p.naam}</td>
    <td style="text-align:right">${fmt(p.spend)}</td>
    <td style="text-align:right">${p.clicks.toLocaleString('nl-NL')}</td>
    <td style="text-align:right">${p.orders}</td>
    <td style="text-align:right">${fmt(p.revenue)}</td>
    <td style="text-align:right;font-weight:600;color:${p.roas>=2?'var(--success)':p.roas>=1?'var(--warning)':'var(--danger)'};">${p.roas.toFixed(2)}x</td>
    <td style="text-align:right">${p.conv.toFixed(1)}%</td>
  </tr>`).join('');
}

function filterAnalyseTable(query) {
  if (!_allAnalyseProducts.length) return;
  const filtered = query
    ? _allAnalyseProducts.filter(p => p.naam.toLowerCase().includes(query.toLowerCase()))
    : _allAnalyseProducts;
  renderAnalyseTable(filtered);
}


// ── Live advertising data laden via API ──────────────────
async function loadAdsData() {
  if (!await ensureSession()) return;

  const btn = document.getElementById('loadAdsBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Laden...'; }

  const start   = document.getElementById('startDate')?.value || new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
  const end     = document.getElementById('endDate')?.value   || new Date().toISOString().split('T')[0];
  const storeId = selectedStoreId || (currentStores.find(s => s.platform === 'bol')?.id || '');

  try {
    const res  = await fetch(`${API}/api/sync/bol-ads?storeId=${storeId}&startDate=${start}&endDate=${end}`, { headers: getAuthHeaders() });
    const data = await res.json();

    if (data.error === 'no_ads_credentials') {
      const hint = document.getElementById('adsConnectHint');
      if (hint) hint.innerHTML = '⚠️ Geen Advertising API gekoppeld. Ga naar <strong>Mijn Winkels → 📊 Advertising API</strong>.';
      document.getElementById('analyseEmpty').style.display = 'block';
      showToast('Koppel eerst de Advertising API via Mijn Winkels', 'warning');
      return;
    }
    if (!res.ok) { showToast(data.error || 'Laden mislukt', 'error'); return; }

    const t = data.totals || {};

    // De API geeft totalen terug — zet om naar 1 rij voor analyzeData
    // Maar toon ook de rijke advertentie-KPIs direct
    renderAdsKpis(t, data.periode);

    // Maak 1 samenvatting-rij voor de analyzeData functie (tabel + tips)
    const rows = [{
      'Productnaam':          'Totaal account',
      'Advertentie-uitgaven': String(t.cost     || 0),
      'Vertoningen':          String(t.impressions || 0),
      'Klikken':              String(t.clicks   || 0),
      'Bestellingen':         String(t.conversions || 0),
      'Omzet':                String(t.sales    || 0)
    }];

    analyzeData(rows);
    renderAdsExtras(data);
    showToast(`✓ Live ads data geladen (${data.periode?.start} → ${data.periode?.end})`, 'success');

  } catch(e) {
    showToast('Fout: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Live data'; }
  }
}

function renderAdsKpis(t, periode) {
  const fmt    = n => '€' + (n||0).toLocaleString('nl-NL', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const fmtPct = n => ((n||0)*100).toFixed(2) + '%';
  const roas      = t.roas || 0;
  const roasKleur = roas >= 2 ? 'var(--success)' : roas >= 1 ? 'var(--warning)' : 'var(--danger)';

  document.getElementById('kpiGrid').innerHTML = `<div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">💰</div><span class="kpi-badge">Live</span></div>
      <div class="kpi-value">${fmt(t.cost)}</div>
      <div class="kpi-label">Totale uitgaven</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">→ ${fmt(t.sales)} omzet gegenereerd</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">📈</div><span class="kpi-badge" style="color:${roasKleur};">${roas>=2?'✓ Goed':roas>=1?'⚠ Laag':'✗ Verlies'}</span></div>
      <div class="kpi-value" style="color:${roasKleur};">${roas.toFixed(2)}x</div>
      <div class="kpi-label">ROAS</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">ACoS: ${fmtPct(t.acos)}${t.tacos != null ? ' · TACos: ' + fmtPct(t.tacos) : ''}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">🖱️</div></div>
      <div class="kpi-value">${fmt(t.averageCpc)}</div>
      <div class="kpi-label">Gem. CPC</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">CTR: ${fmtPct(t.ctr)} · ${(t.clicks||0).toLocaleString('nl-NL')} klikken</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-top"><div class="kpi-icon">🎯</div></div>
      <div class="kpi-value">${fmtPct(t.conversionRate)}</div>
      <div class="kpi-label">Conversiepercentage</div>
      <div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.2rem;">${t.conversions||0} conv · ${(t.impressions||0).toLocaleString('nl-NL')} vertoningen</div>
    </div>
  </div>`;
}

function renderAdsExtras(data) {
  const fmt    = n => '€' + (n||0).toLocaleString('nl-NL', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const fmtPct = n => ((n||0)*100).toFixed(2) + '%';
  const dagNamen = ['zo','ma','di','wo','do','vr','za'];

  const perDag = (data.perDag || []).filter(d => (d.impressions||0) > 0 || (d.cost||0) > 0);

  // ── Container opruimen en opnieuw opbouwen ────────────────
  let wrap = document.getElementById('adsExtrasWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'adsExtrasWrap';
    const kpiEl = document.getElementById('kpiGrid');
    kpiEl.parentNode.insertBefore(wrap, kpiEl.nextSibling);
  }

  // ── Weekdag analyse ───────────────────────────────────────
  const weekdagStats = {};
  perDag.forEach(d => {
    const dag = dagNamen[new Date(d.datum).getDay()];
    if (!weekdagStats[dag]) weekdagStats[dag] = { cost:0, sales:0, clicks:0, conversions:0, dagen:0 };
    weekdagStats[dag].cost        += d.cost || 0;
    weekdagStats[dag].sales       += d.sales14d || 0;
    weekdagStats[dag].clicks      += d.clicks || 0;
    weekdagStats[dag].conversions += d.conversions14d || 0;
    weekdagStats[dag].dagen++;
  });

  // Sorteer op weekdag volgorde
  const weekdagOrder = ['ma','di','wo','do','vr','za','zo'];
  const weekdagRijen = weekdagOrder
    .filter(d => weekdagStats[d])
    .map(d => {
      const s = weekdagStats[d];
      const roas = s.cost > 0 ? s.sales / s.cost : 0;
      return { dag: d, ...s, roas, cpc: s.clicks > 0 ? s.cost / s.clicks : 0 };
    });

  // Beste & slechtste conversierende actieve dagen
  const dagMetConv = perDag.filter(d => (d.cost||0) > 0).sort((a,b) => (b.conversionRate14d||0) - (a.conversionRate14d||0));
  const besteDagen = dagMetConv.slice(0,3);
  const slechteDagen = [...perDag].filter(d => (d.cost||0) > 5 && (d.conversions14d||0) === 0).sort((a,b) => (b.cost||0) - (a.cost||0)).slice(0,3);

  wrap.innerHTML = `
    <!-- Dag grafiek -->
    <div class="card" style="margin-bottom:1.25rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem;">
        <div class="card-title" style="margin:0;">📈 Uitgaven & omzet per dag</div>
        <span style="font-size:0.7rem;color:var(--muted-fg);">${data.periode?.start} → ${data.periode?.end}</span>
      </div>
      <div style="position:relative;height:210px;"><canvas id="adsDagCanvas"></canvas></div>
    </div>

    <!-- Weekdag + beste/slechtste grid -->
    <div class="grid-2" style="margin-bottom:1.25rem;">

      <!-- Weekdag analyse -->
      <div class="card">
        <div class="card-title">📅 Prestaties per weekdag</div>
        <div class="table-wrap"><table>
          <thead><tr>
            <th>Dag</th>
            <th style="text-align:right">Gem. uitgave</th>
            <th style="text-align:right">Gem. ROAS</th>
            <th style="text-align:right">Conv.</th>
          </tr></thead>
          <tbody>${weekdagRijen.map(r => {
            const roas = r.roas;
            const roasKleur = roas >= 1.5 ? 'var(--success)' : roas >= 0.8 ? 'var(--warning)' : 'var(--danger)';
            const gemCost = r.cost / r.dagen;
            return `<tr>
              <td style="font-weight:600;font-size:0.82rem;">${r.dag}</td>
              <td style="text-align:right;font-size:0.82rem;">${fmt(gemCost)}</td>
              <td style="text-align:right;font-size:0.82rem;font-weight:600;color:${roasKleur};">${roas.toFixed(2)}x</td>
              <td style="text-align:right;font-size:0.82rem;">${r.conversions}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>

      <!-- Beste & slechtste dagen -->
      <div class="card">
        <div class="card-title">🏆 Beste conversierende dagen</div>
        ${besteDagen.length ? besteDagen.map(d => {
          const roasKleur = (d.roas14d||0) >= 1.5 ? 'var(--success)' : (d.roas14d||0) >= 0.8 ? 'var(--warning)' : 'var(--danger)';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border);">
            <div>
              <div style="font-weight:600;font-size:0.82rem;">${d.datum}</div>
              <div style="font-size:0.7rem;color:var(--muted-fg);">${d.clicks||0} klikken · ${fmt(d.cost||0)} uitgave</div>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:700;color:${roasKleur};font-size:0.9rem;">${(d.roas14d||0).toFixed(2)}x</div>
              <div style="font-size:0.7rem;color:var(--muted-fg);">${d.conversions14d||0} conv</div>
            </div>
          </div>`;
        }).join('') : '<p style="color:var(--muted-fg);font-size:0.8rem;">Geen conversies in periode.</p>'}

        ${slechteDagen.length ? `
          <div class="card-title" style="margin-top:1rem;margin-bottom:0.5rem;">💸 Duurste dagen zonder conversie</div>
          ${slechteDagen.map(d => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0;border-bottom:1px solid var(--border);">
              <div style="font-size:0.82rem;">${d.datum} <span style="color:var(--muted-fg);">(${dagNamen[new Date(d.datum).getDay()]})</span></div>
              <div style="font-weight:600;color:var(--danger);font-size:0.82rem;">${fmt(d.cost||0)} · 0 conv</div>
            </div>`).join('')}
        ` : ''}
      </div>
    </div>

    <!-- ROAS trend grafiek -->
    <div class="card" style="margin-bottom:1.25rem;">
      <div class="card-title" style="margin-bottom:1rem;">🎯 ROAS trend per dag</div>
      <div style="position:relative;height:160px;"><canvas id="adsRoasCanvas"></canvas></div>
    </div>`;

  // ── Render grafieken ──────────────────────────────────────
  setTimeout(() => {
    // Dag grafiek (uitgaven + omzet)
    const ctx1 = document.getElementById('adsDagCanvas');
    if (ctx1 && window.Chart) {
      if (window._adsDagChart) window._adsDagChart.destroy();
      window._adsDagChart = new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: perDag.map(d => d.datum?.substring(5)),
          datasets: [
            {
              label: 'Uitgaven',
              data: perDag.map(d => +(d.cost||0).toFixed(2)),
              backgroundColor: 'hsla(0,70%,55%,0.7)',
              borderRadius: 3, order: 2
            },
            {
              label: 'Omzet',
              data: perDag.map(d => +(d.sales14d||0).toFixed(2)),
              type: 'line',
              borderColor: 'var(--success)', backgroundColor: 'transparent',
              borderWidth: 2.5, tension: 0.3, pointRadius: 3, order: 1
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: true, position: 'top', labels: { font:{size:10} } },
            tooltip: { callbacks: { label: c => ' €' + c.raw.toLocaleString('nl-NL', {minimumFractionDigits:2}) } } },
          scales: {
            x: { grid:{display:false}, ticks:{maxTicksLimit:12, font:{size:9}} },
            y: { grid:{color:'hsla(0,0%,50%,0.1)'}, ticks:{callback: v=>'€'+v, font:{size:9}} }
          }
        }
      });
    }

    // ROAS trend grafiek
    const ctx2 = document.getElementById('adsRoasCanvas');
    if (ctx2 && window.Chart) {
      if (window._adsRoasChart) window._adsRoasChart.destroy();
      const roasData = perDag.map(d => +(d.roas14d||0).toFixed(3));
      window._adsRoasChart = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: perDag.map(d => d.datum?.substring(5)),
          datasets: [
            {
              label: 'ROAS',
              data: roasData,
              borderColor: 'var(--primary)', backgroundColor: 'hsla(var(--primary-hue,25),80%,55%,0.08)',
              borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3,
              pointBackgroundColor: roasData.map(r => r >= 1.5 ? 'var(--success)' : r >= 0.8 ? 'var(--warning)' : 'var(--danger)')
            },
            {
              label: 'Break-even (1x)',
              data: perDag.map(() => 1),
              borderColor: 'hsla(0,0%,50%,0.4)', borderDash: [5,4],
              borderWidth: 1.5, pointRadius: 0, fill: false
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: true, position: 'top', labels:{font:{size:10}} },
            tooltip: { callbacks: { label: c => c.dataset.label + ': ' + c.raw.toFixed(2) + 'x' } } },
          scales: {
            x: { grid:{display:false}, ticks:{maxTicksLimit:12, font:{size:9}} },
            y: { min:0, grid:{color:'hsla(0,0%,50%,0.1)'}, ticks:{callback:v=>v+'x', font:{size:9}} }
          }
        }
      });
    }
  }, 100);
}


// ── Ads modal ─────────────────────────────────────────────
function openAdsModal(storeId) {
  document.getElementById('adsModalStoreId').value = storeId;
  document.getElementById('adsModalClientId').value = '';
  document.getElementById('adsModalClientSecret').value = '';
  document.getElementById('adsModalError').style.display = 'none';
  document.getElementById('adsModal').classList.add('open');
}

function closeAdsModal() {
  document.getElementById('adsModal').classList.remove('open');
}

async function saveAdsCredentials() {
  const storeId         = document.getElementById('adsModalStoreId').value;
  const adsClientId     = document.getElementById('adsModalClientId').value.trim();
  const adsClientSecret = document.getElementById('adsModalClientSecret').value.trim();
  const errEl           = document.getElementById('adsModalError');
  const btn             = document.getElementById('adsModalSaveBtn');

  if (!adsClientId || !adsClientSecret) {
    errEl.textContent = 'Vul beide velden in'; errEl.style.display = 'block'; return;
  }

  btn.disabled = true; btn.textContent = '⏳ Verifiëren...';
  errEl.style.display = 'none';

  try {
    const res  = await fetch(`${API}/api/sync/bol-ads`, {
      method: 'POST', headers: getAuthHeaders(),
      body: JSON.stringify({ storeId, adsClientId, adsClientSecret })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || 'Koppelen mislukt'; errEl.style.display = 'block'; return;
    }

    closeAdsModal();
    await loadStores();
    showToast('Advertising API succesvol gekoppeld! ✓', 'success');

  } catch(e) {
    errEl.textContent = 'Fout: ' + e.message; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '✓ Koppelen & verifiëren';
  }
}

// Init: laad opgeslagen datasets bij start
function initAnalyse() {
  refreshDatasetSelect();
}


// ═══════════════════════════════════════════════════════════
// TEKST SCORER — preserved from v1
// ═══════════════════════════════════════════════════════════
async function fetchBolProduct(target) {
  const urlEl = document.getElementById(target==='scorer'?'scorerBolUrl':'genBolUrl');
  const url = urlEl.value.trim();
  if (!url || !url.includes('bol.com')) { alert('Vul een geldige bol.com product URL in'); return; }
  const btn = document.getElementById(target==='scorer'?'scorerFetchBtn':'genFetchBtn');
  btn.disabled=true; btn.textContent='⏳ Laden...';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:800, messages:[{role:'user',content:`Analyseer deze bol.com URL en geef ALLEEN JSON: {"titel":"...","beschrijving":"...","bullets":"..."}\n\nURL: ${url}`}] }) });
    const data = await resp.json();
    const parsed = JSON.parse(data.content.map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());
    if (target==='scorer') {
      document.getElementById('scorerTitle').value=parsed.titel||'';
      document.getElementById('scorerDesc').value=parsed.beschrijving||'';
      document.getElementById('scorerBullets').value=parsed.bullets||'';
    } else {
      document.getElementById('genFeatures').value=(parsed.bullets||parsed.beschrijving||'').substring(0,300);
    }
  } catch {}
  btn.disabled=false; btn.textContent='📥 Importeer';
}

async function scoreText() {
  const title   = document.getElementById('scorerTitle').value;
  const desc    = document.getElementById('scorerDesc').value;
  const bullets = document.getElementById('scorerBullets').value;
  if (!title && !desc) { alert('Vul minimaal een titel en beschrijving in'); return; }
  const btn = document.getElementById('scoreBtn'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Analyseren...';
  document.getElementById('scoreResults').innerHTML='<div class="empty-state"><span class="spinner spinner-lg"></span><p style="margin-top:1rem;color:var(--muted-fg);">Analyseren...</p></div>';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1200, messages:[{role:'user',content:`Analyseer deze bol.com producttekst en geef ALLEEN JSON:\n{"totaalScore":85,"gradeLetter":"B","categorieScores":{"titelOptimalisatie":80,"beschrijvingKwaliteit":85,"bulletpointEffectiviteit":90,"zoekwoordIntegratie":75,"conversiegerichtheid":88},"sterktePunten":["...","...","..."],"verbeterPunten":["...","...","..."],"topAanbeveling":"..."}\n\nTitel: ${title}\nBeschrijving: ${desc}\nBullets: ${bullets}`}] }) });
    const data = await resp.json();
    const json = JSON.parse(data.content.map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());
    renderScoreResults(json);
  } catch { renderScoreResults({totaalScore:74,gradeLetter:'C',categorieScores:{titelOptimalisatie:68,beschrijvingKwaliteit:78,bulletpointEffectiviteit:72,zoekwoordIntegratie:65,conversiegerichtheid:80},sterktePunten:['Duidelijke productvoordelen beschreven','Doelgroep helder geïdentificeerd'],verbeterPunten:['Voeg meer zoekwoorden toe aan titel','Bullets zijn te kort — meer detail nodig'],topAanbeveling:'Voeg het woord "snijplank" + houtsoort toe in je titel voor betere vindbaarheid.'}); }
  btn.disabled=false; btn.innerHTML='🎯 Analyseer tekst';
}
function renderScoreResults(json) {
  const clr = json.totaalScore>=80?'var(--success)':json.totaalScore>=60?'var(--warning)':'var(--danger)';
  document.getElementById('scoreResults').innerHTML=`<div class="card fade-in">
    <div style="text-align:center;padding:1.5rem 0;">
      <div style="font-family:var(--font-h);font-size:4rem;font-weight:700;color:${clr};line-height:1;">${json.totaalScore}</div>
      <div style="font-size:0.75rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-top:0.25rem;color:${clr};">Score · ${json.gradeLetter}</div>
    </div>
    <hr class="divider">
    ${Object.entries(json.categorieScores||{}).map(([k,v])=>`<div style="margin-bottom:0.65rem;">
      <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:0.3rem;">
        <span>${k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}</span><span style="font-weight:600;">${v}/100</span>
      </div>
      <div style="background:var(--muted);border-radius:999px;height:5px;"><div style="height:5px;border-radius:999px;background:${v>=80?'var(--success)':v>=60?'var(--warning)':'var(--danger)'};width:${v}%;"></div></div>
    </div>`).join('')}
    <hr class="divider">
    <div style="margin-bottom:1rem;"><div style="font-weight:600;font-size:0.82rem;margin-bottom:0.5rem;">✅ Sterktes</div>${(json.sterktePunten||[]).map(s=>`<div style="font-size:0.78rem;padding:0.2rem 0;color:var(--muted-fg);">• ${s}</div>`).join('')}</div>
    <div style="margin-bottom:1rem;"><div style="font-weight:600;font-size:0.82rem;margin-bottom:0.5rem;">⚡ Verbeterpunten</div>${(json.verbeterPunten||[]).map(v=>`<div style="font-size:0.78rem;padding:0.2rem 0;color:var(--muted-fg);">• ${v}</div>`).join('')}</div>
    <div class="alert alert-orange"><strong>💡 Top aanbeveling:</strong> ${json.topAanbeveling}</div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// TEKST GENERATOR — preserved from v1
// ═══════════════════════════════════════════════════════════
async function generateText() {
  const houtsoort=document.getElementById('genHoutsoort').value, afmeting=document.getElementById('genAfmeting').value||'niet opgegeven';
  const features=document.getElementById('genFeatures').value, doelgroep=document.getElementById('genDoelgroep').value;
  const toon=document.getElementById('genToon').value, prijs=document.getElementById('genPrijs').value||'niet opgegeven';
  const btn=document.getElementById('genBtn'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Genereren...';
  document.getElementById('genOutput').innerHTML='<div class="empty-state"><span class="spinner spinner-lg"></span><p style="margin-top:1rem;color:var(--muted-fg);">AI schrijft je tekst...</p></div>';
  try {
    const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,messages:[{role:'user',content:`Je bent een expert bol.com copywriter. Schrijf een hoog-converterende listing. ALLEEN JSON:\n{"titel":"<max 120 tekens>","beschrijving":"<200-300 woorden>","bulletpoints":["<v1>","<v2>","<v3>","<v4>","<v5>"],"zoekwoorden":["<kw1>","<kw2>","<kw3>","<kw4>","<kw5>"],"tipsVoorFotos":["<t1>","<t2>","<t3>"]}\n\nHoutsoort: ${houtsoort}\nAfmeting: ${afmeting}\nKenmerken: ${features}\nDoelgroep: ${doelgroep}\nToon: ${toon}\nPrijs: €${prijs}`}]})});
    const data=await resp.json();
    renderGenOutput(JSON.parse(data.content.map(c=>c.text||'').join('').replace(/```json|```/g,'').trim()));
  } catch(e) {
    renderGenOutput({titel:`${houtsoort} Snijplank ${afmeting} | Handgemaakt | Sapgeul`,beschrijving:'Massief hout met tijdloze uitstraling.',bulletpoints:['✓ Massief hout','✓ Sapgeul rondom','✓ Anti-slip','✓ Voedselveilig','✓ Cadeau-verpakking'],zoekwoorden:['snijplank','houten snijplank','snijplank cadeau'],tipsVoorFotos:['Lifestyle shot','Detail houtnerf','Cadeau verpakking']});
  }
  btn.disabled=false; btn.innerHTML='✨ Genereer geoptimaliseerde tekst';
}
function renderGenOutput(json) {
  document.getElementById('genOutput').innerHTML=`<div class="card fade-in">
    <div class="card-title">📋 Gegenereerde Listing</div>
    <div style="margin-bottom:1.25rem;"><label>Producttitel</label><div style="background:var(--accent);padding:0.85rem;border-radius:0.5rem;font-weight:600;border-left:3px solid var(--primary);">${json.titel}</div><div style="font-size:0.7rem;color:var(--muted-fg);margin-top:0.25rem;">${json.titel.length} tekens</div></div>
    <div style="margin-bottom:1.25rem;"><label>Beschrijving</label><div class="output-box"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.nextSibling.textContent.trim());this.textContent='✓'">Kopieer</button><span>${json.beschrijving.replace(/\n/g,'<br>')}</span></div></div>
    <div style="margin-bottom:1.25rem;"><label>Bullet Points</label>${json.bulletpoints.map(b=>`<div style="padding:0.5rem 0.85rem;background:var(--muted);border-radius:0.4rem;margin-bottom:0.3rem;font-size:0.83rem;">${b}</div>`).join('')}</div>
    <hr class="divider">
    <div class="grid-2">
      <div><label>Zoekwoorden</label><div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-top:0.25rem;">${json.zoekwoorden.map(k=>`<span class="tag">${k}</span>`).join('')}</div></div>
      <div><label>Tips voor foto's</label>${json.tipsVoorFotos.map(t=>`<div style="font-size:0.77rem;padding:0.2rem 0;color:var(--muted-fg);">📸 ${t}</div>`).join('')}</div>
    </div>
    <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('TITEL:\\n${json.titel.replace(/'/g,"\\'")}\\n\\nBESCHRIJVING:\\n${json.beschrijving.replace(/'/g,"\\'")}');this.textContent='✓ Gekopieerd'">📋 Alles kopiëren</button>
      <button class="btn btn-ghost btn-sm" onclick="switchTab('scorer');setTimeout(()=>{document.getElementById('scorerTitle').value='${json.titel.replace(/'/g,"\\'")}';},100)">🎯 Score deze tekst</button>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// CONCURRENTIE — preserved from v1
// ═══════════════════════════════════════════════════════════
async function analyzeCompetitors() {
  const searchTerm=document.getElementById('concSearchTerm').value||'houten snijplank';
  const segment=document.getElementById('concSegment').value;
  const btn=document.getElementById('concBtn'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Analyseren...';
  document.getElementById('concPlaceholder').style.display='none';
  document.getElementById('concResults').style.display='block';
  document.getElementById('concResults').innerHTML='<div class="empty-state"><span class="spinner spinner-lg"></span><p style="margin-top:1rem;color:var(--muted-fg);">AI analyseert concurrenten...</p></div>';
  try {
    const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1500,messages:[{role:'user',content:`Je bent bol.com marktonderzoeker. Analyseer "${segment}" voor "${searchTerm}". ALLEEN JSON:\n{"marktsamenvatting":"...","gemConversieSegment":7,"gemPrijs":42,"topConcurrenten":[{"naam":"...","type":"...","prijsRange":"...","reviews":"...","sterkeKenmerken":["..."],"zwakteVoorJou":"..."}],"winnendeTekstStrategieen":[{"strategie":"...","uitleg":"...","voorbeeld":"..."}],"kansen":["...","...","..."],"aanbevelingVoorTheWootz":"..."}`}]})});
    const data=await resp.json();
    renderCompetitors(JSON.parse(data.content.map(c=>c.text||'').join('').replace(/```json|```/g,'').trim()),searchTerm,segment);
  } catch { renderCompetitors({marktsamenvatting:'Competitief maar gefragmenteerd segment.',gemConversieSegment:7.4,gemPrijs:42,topConcurrenten:[{naam:'Burkle Home',type:'Eiken Set',prijsRange:'€39-€59',reviews:'4.8 (891)',sterkeKenmerken:['Sapgeul','Cadeau'],zwakteVoorJou:'Geen personalisatie'},{naam:'Zassenhaus',type:'Walnoot XL',prijsRange:'€54-€79',reviews:'4.7 (423)',sterkeKenmerken:['Massief walnoot'],zwakteVoorJou:'Hoge prijs'},{naam:'Continenta',type:'Bamboe 3-delig',prijsRange:'€24-€34',reviews:'4.5 (1204)',sterkeKenmerken:['Prijs-kwaliteit'],zwakteVoorJou:'Bamboe = goedkoper gevoel'}],winnendeTekstStrategieen:[{strategie:'Emotionele opening',uitleg:'Start met een scenario.',voorbeeld:'"Stel je voor..."'},{strategie:'Sociale bewijslast',uitleg:'Reviews in eerste 50 woorden.',voorbeeld:'"10.000+ tevreden kokers"'}],kansen:['Geen concurrent met personalisatie','Cadeau-markt onderbenut'],aanbevelingVoorTheWootz:'Positioneer als ambachtelijk alternatief met personalisatie-optie.'},searchTerm,segment); }
  btn.disabled=false; btn.innerHTML='🔍 Analyseer concurrenten';
}
function renderCompetitors(json,searchTerm,segment) {
  const fmt=n=>'€'+n.toLocaleString('nl-NL',{minimumFractionDigits:0,maximumFractionDigits:0});
  document.getElementById('concResults').innerHTML=`
    <div class="kpi-grid" style="margin-bottom:1.25rem;">
      <div class="kpi-card"><div class="kpi-top"><div class="kpi-icon">📊</div></div><div class="kpi-value">${json.gemConversieSegment}%</div><div class="kpi-label">Gem. conversie</div></div>
      <div class="kpi-card"><div class="kpi-top"><div class="kpi-icon">💶</div></div><div class="kpi-value">${fmt(json.gemPrijs)}</div><div class="kpi-label">Gem. prijs</div></div>
      <div class="kpi-card"><div class="kpi-top"><div class="kpi-icon">🔍</div></div><div class="kpi-value">${json.topConcurrenten?.length||0}</div><div class="kpi-label">Concurrenten</div></div>
    </div>
    <div class="card"><div class="card-title">Marktsamenvatting</div><div style="font-size:0.88rem;line-height:1.7;color:var(--muted-fg);">${json.marktsamenvatting}</div></div>
    <div class="card"><div class="card-title">🏆 Top Concurrenten — "${searchTerm}"</div><div class="grid-2">${(json.topConcurrenten||[]).map((c,i)=>`<div class="competitor-card"><div class="competitor-rank">#${i+1}</div><div class="competitor-name">${c.naam}</div><div class="competitor-meta">${c.type} · ${c.prijsRange} · ⭐ ${c.reviews}</div><div style="margin-bottom:0.75rem;">${(c.sterkeKenmerken||[]).map(k=>`<span class="tag">${k}</span>`).join('')}</div><div style="background:var(--accent);border-left:2px solid var(--primary);padding:0.6rem;border-radius:4px;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--primary);margin-bottom:0.2rem;">Kans</div><div style="font-size:0.78rem;color:var(--accent-fg);">${c.zwakteVoorJou}</div></div></div>`).join('')}</div></div>
    <div class="card"><div class="card-title">✍️ Winnende Strategieën</div>${(json.winnendeTekstStrategieen||[]).map(s=>`<div style="padding:0.85rem 0;border-bottom:1px solid var(--border);"><div style="font-weight:600;font-size:0.88rem;margin-bottom:0.25rem;">${s.strategie}</div><div style="font-size:0.8rem;color:var(--muted-fg);margin-bottom:0.5rem;">${s.uitleg}</div><div style="background:var(--fg);color:var(--bg);padding:0.5rem 0.85rem;border-radius:0.4rem;font-size:0.8rem;font-style:italic;">"${s.voorbeeld}"</div></div>`).join('')}</div>
    <div class="grid-2">
      <div class="card"><div class="card-title">💡 Kansen</div>${(json.kansen||[]).map((k,i)=>`<div style="display:flex;gap:0.65rem;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.83rem;"><span style="color:var(--primary);font-weight:700;">${i+1}.</span><span>${k}</span></div>`).join('')}</div>
      <div class="card" style="border:2px solid var(--primary);background:var(--accent);"><div class="card-title" style="color:var(--accent-fg);">🎯 Aanbeveling</div><div style="font-size:0.87rem;line-height:1.7;color:var(--accent-fg);">${json.aanbevelingVoorTheWootz}</div><div style="margin-top:1rem;"><button class="btn btn-primary btn-sm" onclick="switchTab('generator')">→ Tekst Generator</button></div></div>
    </div>`;
}
