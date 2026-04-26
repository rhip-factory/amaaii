// amaaii PWA chat client
const $chat = document.getElementById('chat');
const $form = document.getElementById('composer');
const $input = document.getElementById('input');
const $send = document.getElementById('sendBtn');
const $reset = document.getElementById('resetBtn');

const SESSION_KEY = 'amaaii.sessionId';

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function clearChat() {
  while ($chat.firstChild) $chat.removeChild($chat.firstChild);
}

function newSession() {
  localStorage.removeItem(SESSION_KEY);
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
  // rAF so the new node is laid out before we scroll.
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
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId(), message: trimmed }),
    });
    const data = await res.json();
    hideTyping();
    if (!res.ok) {
      appendBubble('bot', data.response || `Sorry — ${data.error || 'something went wrong'}.`);
    } else {
      appendBubble('bot', data.response, data.urgencyLevel);
    }
  } catch (err) {
    hideTyping();
    appendBubble('bot', "Connection trouble — please try again in a moment.");
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

function wireSuggestions() {
  document.querySelectorAll('.suggest').forEach((btn) => {
    btn.addEventListener('click', () => send(btn.dataset.msg));
  });
}

// Snapshot the welcome block so we can restore it on reset.
const welcomeNode = $chat.querySelector('.welcome').cloneNode(true);
wireSuggestions();
$input.focus();

// Service worker (best effort — non-blocking)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
