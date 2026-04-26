// amaaii PWA chat client (Phase A: auth + shared-with-WhatsApp user)

const TOKEN_KEY = 'amaaii.token';
const USER_KEY = 'amaaii.user';

const $ = (id) => document.getElementById(id);

// View elements
const $loginView = $('login-view');
const $appView = $('app-view');

// Login
const $loginForm = $('loginForm');
const $phone = $('phone');
const $loginError = $('loginError');
const $loginBtn = $('loginBtn');

// Chat
const $chat = $('chat');
const $form = $('composer');
const $input = $('input');
const $send = $('sendBtn');
const $reset = $('resetBtn');
const $logout = $('logoutBtn');
const $userBadge = $('userBadge');

let welcomeNode; // snapshot for reset

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
  if (u && u.phone) {
    // strip the whatsapp:+ prefix for display
    $userBadge.textContent = u.phone.replace(/^whatsapp:/, '');
  }
  setTimeout(() => $input.focus(), 50);
}

// ---- Login submit --------------------------------------------------------
$loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $loginError.hidden = true;
  $loginBtn.disabled = true;
  $loginBtn.textContent = 'Signing in…';
  try {
    const raw = $phone.value.trim();
    // Send as the user typed it; the server normalizes.
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
    showApp();
  } catch (err) {
    $loginError.textContent = 'Network trouble. Please try again.';
    $loginError.hidden = false;
  } finally {
    $loginBtn.disabled = false;
    $loginBtn.textContent = 'Continue';
  }
});

// ---- Chat ----------------------------------------------------------------
function clearChat() {
  while ($chat.firstChild) $chat.removeChild($chat.firstChild);
}

function newSession() {
  // Clears the on-screen conversation. The user (DB row) stays — this
  // is just a UI reset, not a sign-out.
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
  if (role === 'bot' && (urgency === 'critical' || urgency === 'high')) {
    div.classList.add(urgency);
  }
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
function hideTyping() {
  document.getElementById('__typing')?.remove();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $chat.scrollTo({ top: $chat.scrollHeight, behavior: 'smooth' });
  });
}

async function send(message) {
  const trimmed = (message || '').trim();
  if (!trimmed) return;
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

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  send($input.value);
});

$reset.addEventListener('click', newSession);

$logout.addEventListener('click', () => {
  clearSession();
  newSession(); // wipe visible chat
  showLogin();
});

function wireSuggestions() {
  document.querySelectorAll('.suggest').forEach((btn) => {
    btn.addEventListener('click', () => send(btn.dataset.msg));
  });
}

// ---- Boot ---------------------------------------------------------------
welcomeNode = $chat.querySelector('.welcome').cloneNode(true);
wireSuggestions();

if (getToken()) {
  showApp();
} else {
  showLogin();
}

// Service worker (best effort — non-blocking)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
