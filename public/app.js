// amaaii PWA client — Phase B (multi-page SPA)

const TOKEN_KEY = 'amaaii.token';
const USER_KEY = 'amaaii.user';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ---- Views & nav ---------------------------------------------------------
const VIEWS = ['home', 'chat', 'history', 'profile'];
const $loginView = $('login-view');
const $appView = $('app-view');

// ---- Login ---------------------------------------------------------------
const $loginForm = $('loginForm');
const $phone = $('phone');
const $loginError = $('loginError');
const $loginBtn = $('loginBtn');

// ---- Chat ---------------------------------------------------------------
const $chat = $('chat');
const $form = $('composer');
const $input = $('input');
const $send = $('sendBtn');
const $reset = $('resetBtn');

// ---- Common ---------------------------------------------------------------
const $userBadge = $('userBadge');
const $logout = $('logoutBtn');
const $logoutMobile = $('topbarLogout');

let welcomeNode; // snapshot for chat reset
let homeLoaded = false;
let profileLoaded = false;
let historyLoaded = false;

// ---- Auth helpers --------------------------------------------------------
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
}
function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function api(path, opts = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    opts.headers || {}
  );
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    clearSession();
    showLogin();
    throw new Error('unauthorized');
  }
  return res;
}

// ---- View switching ------------------------------------------------------
function showLogin() {
  $appView.hidden = true;
  $loginView.hidden = false;
  document.body.classList.remove('app-mode');
  document.body.classList.add('login-mode');
  setTimeout(() => $phone.focus(), 50);
}
function showApp() {
  $loginView.hidden = true;
  $appView.hidden = false;
  document.body.classList.remove('login-mode');
  document.body.classList.add('app-mode');
  const u = getUser();
  if (u && u.phone) $userBadge.textContent = u.phone.replace(/^whatsapp:/, '');
  // Mark all routes hidden, then show the one matching the current hash.
  if (!location.hash || location.hash === '#') location.hash = '#/home';
  else router();
}

// ---- Router --------------------------------------------------------------
function router() {
  const route = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'home';
  const view = VIEWS.includes(route) ? route : 'home';
  $$('.view').forEach((sec) => {
    sec.hidden = sec.dataset.view !== view;
  });
  $$('.nav-link, .bnav-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === view);
  });
  // Lazy-load per-view data the first time it's shown.
  if (view === 'home' && !homeLoaded) loadHome();
  if (view === 'profile' && !profileLoaded) loadProfile();
  if (view === 'history' && !historyLoaded) loadHistory();
  if (view === 'chat') setTimeout(() => $input.focus(), 60);
}
window.addEventListener('hashchange', router);

// ---- Login submit --------------------------------------------------------
$loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $loginError.hidden = true;
  $loginBtn.disabled = true;
  $loginBtn.textContent = 'Signing in…';
  try {
    const raw = $phone.value.trim();
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: raw }),
    });
    const data = await res.json();
    if (!res.ok) {
      $loginError.textContent = data.message || 'Could not sign in. Check the phone number.';
      $loginError.hidden = false;
      return;
    }
    setSession(data.token, data.user);
    homeLoaded = profileLoaded = historyLoaded = false;
    showApp();
  } catch (err) {
    $loginError.textContent = 'Network trouble. Please try again.';
    $loginError.hidden = false;
  } finally {
    $loginBtn.disabled = false;
    $loginBtn.textContent = 'Continue';
  }
});

// ---- Logout --------------------------------------------------------------
function doLogout() {
  clearSession();
  homeLoaded = profileLoaded = historyLoaded = false;
  newSession(); // wipe visible chat
  showLogin();
}
$logout?.addEventListener('click', doLogout);
$logoutMobile?.addEventListener('click', doLogout);

// ---- Chat ----------------------------------------------------------------
function clearChat() {
  while ($chat.firstChild) $chat.removeChild($chat.firstChild);
}
function newSession() {
  $chat.classList.remove('has-messages');
  clearChat();
  $chat.appendChild(welcomeNode.cloneNode(true));
  wireSuggestions();
  $input.focus();
}
function appendBubble(role, text, urgency) {
  $chat.classList.add('has-messages');
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (role === 'bot' && (urgency === 'critical' || urgency === 'high')) div.classList.add(urgency);
  div.textContent = text;
  $chat.appendChild(div);
  scrollToBottom();
  return div;
}
function showTyping() {
  $chat.classList.add('has-messages');
  const t = document.createElement('div');
  t.className = 'typing';
  t.id = '__typing';
  for (let i = 0; i < 3; i++) t.appendChild(document.createElement('span'));
  $chat.appendChild(t);
  scrollToBottom();
}
function hideTyping() { document.getElementById('__typing')?.remove(); }
function scrollToBottom() {
  requestAnimationFrame(() => $chat.scrollTo({ top: $chat.scrollHeight, behavior: 'smooth' }));
}

async function send(message) {
  const trimmed = (message || '').trim();
  if (!trimmed) return;
  if (location.hash !== '#/chat') location.hash = '#/chat';
  appendBubble('user', trimmed);
  $input.value = '';
  $send.disabled = true;
  showTyping();
  try {
    const res = await api('/chat', {
      method: 'POST',
      body: JSON.stringify({ message: trimmed }),
    });
    const data = await res.json();
    hideTyping();
    if (!res.ok) {
      appendBubble('bot', data.response || `Sorry — ${data.error || 'something went wrong'}.`);
    } else {
      appendBubble('bot', data.response, data.urgencyLevel);
    }
    // Invalidate cards/lists that may have changed.
    homeLoaded = false;
    historyLoaded = false;
  } catch (err) {
    if (err.message !== 'unauthorized') {
      hideTyping();
      appendBubble('bot', "Connection trouble — please try again in a moment.");
    }
  } finally {
    $send.disabled = false;
    $input.focus();
  }
}

$form.addEventListener('submit', (e) => { e.preventDefault(); send($input.value); });
$reset.addEventListener('click', newSession);

function wireSuggestions() {
  $$('.suggest', $chat).forEach((btn) => {
    btn.addEventListener('click', () => send(btn.dataset.msg));
  });
}

// Cards & nav-links with data-msg fire a chat message and route to chat.
document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-msg]');
  if (!el) return;
  if (el.tagName === 'A' || el.tagName === 'BUTTON') {
    e.preventDefault();
    send(el.dataset.msg);
  }
});

// ---- HOME ----------------------------------------------------------------
function showHomeSkeletons() {
  const ids = ['homeGreeting', 'homeSubgreeting', 'weekHeadline', 'weekDescription',
               'journalState', 'journalBody', 'tipHeadline', 'tipBody'];
  ids.forEach((id) => $(id)?.classList.add('skeleton'));
}
function hideHomeSkeletons() {
  document.querySelectorAll('.skeleton').forEach((el) => el.classList.remove('skeleton'));
}

function renderInsights(trend) {
  const card = $('cardInsights');
  if (!card) return;
  if (!trend || trend.totalEntries === 0) { card.hidden = true; return; }
  const list = $('insightsList');
  while (list.firstChild) list.removeChild(list.firstChild);
  const rows = [];
  rows.push({ label: 'Days journaled', value: `${trend.distinctDaysJournaled} of ${trend.windowDays}` });
  if (trend.avgMood != null) rows.push({ label: 'Avg mood', value: `${trend.avgMood}/10` });
  if (trend.avgSleepHours != null) rows.push({ label: 'Avg sleep', value: `${trend.avgSleepHours}h` });
  if (trend.avgWaterGlasses != null) rows.push({ label: 'Avg water', value: `${trend.avgWaterGlasses} glasses` });
  if (trend.recurringSymptoms && trend.recurringSymptoms.length > 0) {
    rows.push({
      label: 'Recurring',
      value: trend.recurringSymptoms.slice(0, 3).map((s) => `${s.symptom} (${s.days}d)`).join(', '),
    });
  }
  if (trend.redFlagDays > 0) rows.push({ label: '⚠️ Flagged days', value: String(trend.redFlagDays) });

  rows.forEach((r) => {
    const li = document.createElement('li');
    const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = r.label;
    const val = document.createElement('span'); val.className = 'value'; val.textContent = ' ' + r.value;
    li.append(lab, val);
    list.appendChild(li);
  });
  card.hidden = false;
}

async function loadHome() {
  showHomeSkeletons();
  try {
    const res = await api('/me');
    if (!res.ok) return;
    const me = await res.json();
    hideHomeSkeletons();
    homeLoaded = true;

    const name = (me.user && me.user.name) || 'friend';
    $('homeGreeting').textContent = `Hello, ${name} 👋`;

    const week = me.user && me.user.pregnancy_week;
    if (week) {
      $('homeSubgreeting').textContent = `Week ${week} of your journey.`;
      $('weekHeadline').textContent = `Week ${week}`;
      $('weekDescription').textContent = me.weekDescription || `You're moving along beautifully. Each week brings new milestones for you and baby.`;
    } else {
      $('homeSubgreeting').textContent = `Tell me about your pregnancy so I can show stage-appropriate care here.`;
    }

    const j = me.todayJournal;
    const count = me.todayCheckinCount || 0;
    const cta = $('journalCta');
    if (j && j.completed) {
      const checkinWord = count === 1 ? 'check-in' : 'check-ins';
      $('journalState').textContent = `✓ ${count} ${checkinWord} today`;
      $('journalBody').textContent = `Latest mood ${j.emotional_state || '—'}/10. You can do another check-in anytime.`;
      cta.textContent = 'New check-in →';
      cta.setAttribute('href', '#/chat');
      cta.setAttribute('data-msg', 'journal');
    } else if (j && !j.completed) {
      $('journalState').textContent = 'In progress';
      $('journalBody').textContent = `Pick up where you left off.`;
      cta.textContent = 'Continue →';
      cta.setAttribute('href', '#/chat');
      cta.setAttribute('data-msg', 'journal');
    } else {
      $('journalState').textContent = 'Not started';
      $('journalBody').textContent = `A 2-minute check-in helps me notice patterns over time.`;
      cta.textContent = 'Start journal →';
      cta.setAttribute('href', '#/chat');
      cta.setAttribute('data-msg', 'journal');
    }

    if (me.tip) {
      $('tipHeadline').textContent = me.tip.headline;
      $('tipBody').textContent = me.tip.body;
    }
    renderInsights(me.trend);
  } catch (e) { /* surfaces 401 → login */ }
}

// ---- PROFILE -------------------------------------------------------------
let profileLang = 'en';

function paintSegmented(lang) {
  profileLang = lang;
  $$('.seg-opt').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.lang === lang));
  });
}

async function loadProfile() {
  try {
    const res = await api('/me');
    if (!res.ok) return;
    const me = await res.json();
    profileLoaded = true;
    $('profName').value = me.user?.name || '';
    $('profAge').value = me.user?.age || '';
    $('profWeek').value = me.user?.pregnancy_week || '';
    $('profLocation').value = me.user?.location || '';
    $('profilePhone').textContent = (me.user?.phone || '').replace(/^whatsapp:/, '') || '—';
    paintSegmented(me.user?.language || 'en');
    await loadMedicalHistory();
  } catch (_) {}
}

// Wire segmented language control. Click toggles the visual selection;
// the actual save happens on form submit (alongside other profile fields)
// — keeps a single round-trip and a single 'Saved ✓' confirmation.
document.body.addEventListener('click', (e) => {
  const opt = e.target.closest('.seg-opt');
  if (!opt) return;
  paintSegmented(opt.dataset.lang);
});

// ---- Medical history (Phase D) -------------------------------------------
function renderMHChips(mh) {
  const wrap = $('mhChips');
  if (!wrap) return;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  if (!mh) { wrap.hidden = true; return; }

  function chip(label, value) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return;
    const c = document.createElement('span');
    c.className = 'chip';
    const s = document.createElement('strong'); s.textContent = label;
    c.appendChild(s);
    c.appendChild(document.createTextNode(Array.isArray(value) ? value.join(', ') : String(value)));
    wrap.appendChild(c);
  }
  chip('Gravida', mh.gravida);
  chip('Parity', mh.parity);
  chip('Miscarriages', mh.miscarriages);
  chip('Conditions', mh.chronic_conditions);
  chip('Past complications', mh.past_complications);
  chip('Medications', mh.medications);
  chip('Allergies', mh.allergies);
  if (Array.isArray(mh.previous_deliveries) && mh.previous_deliveries.length) {
    const pd = mh.previous_deliveries.map((d) => {
      const bits = [d.mode || '?'];
      if (d.complications) bits.push(d.complications);
      if (d.year) bits.push(d.year);
      return bits.join(' / ');
    }).join('; ');
    chip('Previous deliveries', pd);
  }
  wrap.hidden = !wrap.firstChild;
}

async function loadMedicalHistory() {
  try {
    const res = await api('/me/medical-history');
    if (!res.ok) return;
    const data = await res.json();
    const mh = data.medicalHistory;
    if (mh) {
      $('mhText').value = mh.rawText || '';
      renderMHChips(mh);
      if (mh.updatedAt) {
        const u = $('mhUpdated');
        u.textContent = `Last updated ${new Date(mh.updatedAt).toLocaleString()}`;
        u.hidden = false;
      }
    }
  } catch (_) {}
}

$('mhSave')?.addEventListener('click', async () => {
  const $btn = $('mhSave');
  const $status = $('mhStatus');
  const text = $('mhText').value.trim();
  if (text.length < 5) {
    $status.textContent = 'Please add a few more details first.';
    $status.style.color = '#C53030';
    $status.hidden = false;
    return;
  }
  $status.hidden = true;
  $btn.disabled = true;
  $btn.textContent = 'Extracting…';
  try {
    const res = await api('/me/medical-history', { method: 'POST', body: JSON.stringify({ rawText: text }) });
    const data = await res.json();
    if (!res.ok) {
      $status.textContent = data.error || 'Could not save.';
      $status.style.color = '#C53030';
      $status.hidden = false;
      return;
    }
    renderMHChips(data.medicalHistory);
    $status.textContent = 'Saved ✓';
    $status.style.color = '';
    $status.hidden = false;
    if (data.medicalHistory?.updatedAt) {
      const u = $('mhUpdated');
      u.textContent = `Last updated ${new Date(data.medicalHistory.updatedAt).toLocaleString()}`;
      u.hidden = false;
    }
  } finally {
    $btn.disabled = false;
    $btn.textContent = 'Save & extract';
  }
});

// ---- Install prompt (PWA) ------------------------------------------------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  // Only show after user has signed in and visited at least twice.
  const visits = (parseInt(localStorage.getItem('amaaii.visits') || '0', 10) + 1);
  localStorage.setItem('amaaii.visits', String(visits));
  if (getToken() && visits >= 2 && !localStorage.getItem('amaaii.installDismissed')) {
    showInstallBanner();
  }
});

function showInstallBanner() {
  if (document.getElementById('installBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'installBanner';
  banner.className = 'install-banner';
  const text = document.createElement('span'); text.textContent = 'Add Amaaii to your home screen';
  const install = document.createElement('button'); install.textContent = 'Install';
  const dismiss = document.createElement('button'); dismiss.textContent = '✕'; dismiss.className = 'dismiss';
  install.onclick = async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
    }
    banner.remove();
  };
  dismiss.onclick = () => {
    localStorage.setItem('amaaii.installDismissed', '1');
    banner.remove();
  };
  banner.append(text, install, dismiss);
  document.body.appendChild(banner);
}

$('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const $btn = $('profileSave');
  const $status = $('profileStatus');
  $status.hidden = true;
  $btn.disabled = true;
  $btn.textContent = 'Saving…';
  try {
    const body = {
      name: $('profName').value.trim() || null,
      age: $('profAge').value ? parseInt($('profAge').value, 10) : null,
      pregnancy_week: $('profWeek').value ? parseInt($('profWeek').value, 10) : null,
      location: $('profLocation').value.trim() || null,
      language: profileLang,
    };
    const res = await api('/me', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      $status.textContent = 'Could not save. Please try again.';
      $status.style.color = '#C53030';
      $status.hidden = false;
      return;
    }
    $status.textContent = 'Saved ✓';
    $status.style.color = '';
    $status.hidden = false;
    homeLoaded = false; // home cards depend on this
  } finally {
    $btn.disabled = false;
    $btn.textContent = 'Save changes';
  }
});

// ---- HISTORY -------------------------------------------------------------
async function loadHistory() {
  const $list = $('historyList');
  try {
    const res = await api('/history');
    if (!res.ok) return;
    const data = await res.json();
    historyLoaded = true;
    while ($list.firstChild) $list.removeChild($list.firstChild);
    if (!data.days || data.days.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const p = document.createElement('p');
      p.textContent = 'Nothing logged yet — your daily journals will appear here as a timeline.';
      empty.appendChild(p);
      const a = document.createElement('a');
      a.className = 'primary-btn small';
      a.href = '#/chat';
      a.dataset.msg = 'journal';
      a.textContent = "Start today's journal";
      empty.appendChild(a);
      $list.appendChild(empty);
      return;
    }
    for (const day of data.days) {
      const card = document.createElement('div');
      card.className = 'history-day';
      const h = document.createElement('h4');
      h.textContent = day.label;
      card.appendChild(h);
      for (const row of day.rows) {
        const r = document.createElement('div');
        r.className = 'history-row';
        const l = document.createElement('span'); l.className = 'label'; l.textContent = row.label;
        const v = document.createElement('span'); v.className = 'value'; v.textContent = row.value;
        r.append(l, v);
        card.appendChild(r);
      }
      $list.appendChild(card);
    }
  } catch (_) {}
}

// ---- Boot ---------------------------------------------------------------
welcomeNode = $chat.querySelector('.welcome').cloneNode(true);
wireSuggestions();

if (getToken()) showApp();
else showLogin();

// Service worker (best effort — non-blocking)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
