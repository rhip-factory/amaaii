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
async function loadHome() {
  try {
    const res = await api('/me');
    if (!res.ok) return;
    const me = await res.json();
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
    if (j && j.completed) {
      $('journalState').textContent = '✓ Done for today';
      $('journalBody').textContent = `Mood ${j.emotional_state || '—'}/10. Tap History to see the full entry.`;
      const cta = $('journalCta');
      cta.textContent = 'View today →';
      cta.setAttribute('href', '#/history');
      cta.removeAttribute('data-msg');
    } else {
      $('journalState').textContent = 'Not started';
      $('journalBody').textContent = `A 2-minute check-in helps me notice patterns over time.`;
      const cta = $('journalCta');
      cta.textContent = 'Start journal →';
      cta.setAttribute('href', '#/chat');
      cta.setAttribute('data-msg', 'journal');
    }

    if (me.tip) {
      $('tipHeadline').textContent = me.tip.headline;
      $('tipBody').textContent = me.tip.body;
    }
  } catch (e) { /* surfaces 401 → login */ }
}

// ---- PROFILE -------------------------------------------------------------
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
  } catch (_) {}
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
