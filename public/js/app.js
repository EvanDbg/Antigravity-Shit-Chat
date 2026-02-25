/**
 * App Entry — WebSocket, routing, state management
 */
import { escapeHtml, getQuotaColor, getQuotaEmoji, shortenLabel } from './utils.js';
import './chat.js?v=202611'; // Shadow DOM chat view (self-initializing)
import './drawer.js'; // Left drawer (self-initializing)
import './toast.js'; // Toast notifications (self-initializing)
import './settings.js'; // Settings / More view (self-initializing)

// --- State ---
let cascades = [];
let currentCascadeId = null;
let ws = null;
const quotaCache = {};

// --- DOM refs (resolved after DOMContentLoaded) ---
let $chatHost, $topbarTitle, $sendBtn, $messageInput;
let $loginScreen, $appShell, $loginBtn, $loginPassword;

// --- Exports for other modules ---
export function getCascades() { return cascades; }
export function getCurrentCascadeId() { return currentCascadeId; }
export function getQuotaCache() { return quotaCache; }
export function setCurrentCascadeId(id) { currentCascadeId = id; }

// ------------------------------------------------------------------
// Login
// ------------------------------------------------------------------
async function tryLogin(password) {
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (res.ok) {
      $loginScreen.style.display = 'none';
      $appShell.style.display = 'flex';
      connect();
    } else {
      $loginPassword.classList.add('shake');
      setTimeout(() => $loginPassword.classList.remove('shake'), 500);
    }
  } catch (e) {
    console.error('Login error:', e);
  }
}

async function checkAuth() {
  try {
    const res = await fetch('/cascades');
    if (res.ok) {
      $loginScreen.style.display = 'none';
      $appShell.style.display = 'flex';
      connect();
    }
  } catch (_) { /* not authed */ }
}

// ------------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'cascade_list') {
      cascades = data.cascades;
      for (const c of cascades) {
        if (c.quota) quotaCache[c.id] = c.quota;
      }
      renderCascadeList();
      if (!currentCascadeId && cascades.length > 0) {
        const activeCascade = cascades.find(c => c.active);
        selectCascade(activeCascade ? activeCascade.id : cascades[0].id);
      }
    }

    if (data.type === 'snapshot_update') {
      if (data.cascadeId === currentCascadeId) {
        document.dispatchEvent(new CustomEvent('snapshot-update', { detail: { id: data.cascadeId } }));
      }
    }

    if (data.type === 'quota_update') {
      quotaCache[data.cascadeId] = data.quota;
      document.dispatchEvent(new CustomEvent('cascades-updated', { detail: { cascades, currentCascadeId } }));
    }

    if (data.type === 'css_update') {
      if (data.cascadeId === currentCascadeId) {
        document.dispatchEvent(new CustomEvent('css-update', { detail: { id: data.cascadeId } }));
      }
    }

    if (data.type === 'ai_complete') {
      document.dispatchEvent(new CustomEvent('ai-complete', {
        detail: { title: data.title || 'Unknown', cascadeId: data.cascadeId }
      }));
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
}

// ------------------------------------------------------------------
// Cascade list (rendered in drawer, title updated in topbar)
// ------------------------------------------------------------------
function renderCascadeList() {
  $topbarTitle.textContent = cascades.length > 0
    ? (cascades.find(c => c.id === currentCascadeId)?.title || cascades[0].title || 'Antigravity')
    : 'No sessions';

  // Dispatch event for drawer to update
  document.dispatchEvent(new CustomEvent('cascades-updated', { detail: { cascades, currentCascadeId } }));

  if (cascades.length === 0) {
    $chatHost.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔌</div>
        <h3>Antigravity is not running</h3>
        <p>No IDE instance detected. Launch one to start.</p>
        <button class="btn btn-primary" id="emptyLaunchBtn">🚀 Launch Antigravity</button>
      </div>`;
    const btn = document.getElementById('emptyLaunchBtn');
    if (btn) btn.addEventListener('click', launchAntigravity);
  }
}

export function selectCascade(id) {
  currentCascadeId = id;
  $topbarTitle.textContent = cascades.find(c => c.id === id)?.title || 'Antigravity';
  document.dispatchEvent(new CustomEvent('cascade-selected', { detail: { id } }));
  document.dispatchEvent(new CustomEvent('cascades-updated', { detail: { cascades, currentCascadeId } }));
}

// ------------------------------------------------------------------
// Send message
// ------------------------------------------------------------------
async function sendMessage() {
  const text = $messageInput.value;
  if (!text || !currentCascadeId) return;

  $messageInput.value = '';
  $messageInput.style.height = 'auto';

  try {
    await fetch(`/send/${currentCascadeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    document.dispatchEvent(new CustomEvent('snapshot-update', { detail: { id: currentCascadeId } }));
  } catch (e) {
    console.error('Send failed', e);
    $messageInput.value = text;
    $messageInput.style.height = 'auto';
    $messageInput.style.height = $messageInput.scrollHeight + 'px';
  }
}

// ------------------------------------------------------------------
// Launch Antigravity
// ------------------------------------------------------------------
export async function launchAntigravity() {
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    if (data.success) {
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const r = await fetch('/cascades');
          if (r.ok) {
            const list = await r.json();
            if (list.length > 0) {
              clearInterval(poll);
              window.location.reload();
              return;
            }
          }
        } catch (_) { }
        if (attempts >= 20) clearInterval(poll);
      }, 3000);
    } else if (data.error === 'RESTART_REQUIRED') {
      alert('Antigravity is already running without remote debugging.\n\nPlease Quit (Cmd+Q) manually, then Launch again.');
    }
  } catch (err) {
    console.error('Launch error:', err);
  }
}

// ------------------------------------------------------------------
// New conversation
// ------------------------------------------------------------------
async function newConversation() {
  if (!currentCascadeId) return;
  try {
    await fetch(`/new-conversation/${currentCascadeId}`, { method: 'POST' });
  } catch (err) {
    console.error('New conversation error:', err);
  }
}

// ------------------------------------------------------------------
// Close cascade
// ------------------------------------------------------------------
export async function closeCascade(id) {
  if (!confirm('Close this Antigravity window?')) return;
  try {
    const res = await fetch(`/api/close-cascade/${id}`, { method: 'POST' });
    if (res.status === 401) { window.location.href = '/login.html'; return; }
  } catch (e) {
    console.error('Close cascade error:', e);
  }
}

// ------------------------------------------------------------------
// View routing (bottom nav)
// ------------------------------------------------------------------
function setupViewRouting() {
  document.querySelectorAll('.bottomnav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetView = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelectorAll('.bottomnav-item').forEach(b => b.classList.remove('active'));
      document.getElementById(targetView)?.classList.add('active');
      btn.classList.add('active');
    });
  });
}

// ------------------------------------------------------------------
// Modal close (data-close attribute)
// ------------------------------------------------------------------
function setupModalClose() {
  document.addEventListener('click', (e) => {
    // Close button with data-close
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      const modalId = closeBtn.dataset.close;
      document.getElementById(modalId)?.classList.remove('active');
      return;
    }
    // Click on overlay background
    const overlay = e.target.closest('.modal-overlay');
    if (overlay && e.target === overlay) {
      overlay.classList.remove('active');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
  });
}

// ------------------------------------------------------------------
// Textarea auto-resize
// ------------------------------------------------------------------
function setupTextarea() {
  $messageInput.addEventListener('input', () => {
    $messageInput.style.height = 'auto';
    $messageInput.style.height = $messageInput.scrollHeight + 'px';
  });

  document.addEventListener('ide-input-sync', (e) => {
    const text = e.detail.text;
    if ($messageInput && text && !$messageInput.value.trim()) {
      $messageInput.value = text;
      // Auto-resize
      $messageInput.style.height = 'auto';
      $messageInput.style.height = $messageInput.scrollHeight + 'px';
    }
  });
}

// ------------------------------------------------------------------
// Service Worker
// ------------------------------------------------------------------
function setupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => {
      console.warn('SW registration failed:', e);
    });
  }
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Mobile Safari :active state enabler
  document.body.addEventListener('touchstart', () => {}, { passive: true });

  // Resolve DOM refs
  $chatHost = document.getElementById('chatHost');
  $topbarTitle = document.getElementById('topbarTitle');
  $sendBtn = document.getElementById('sendBtn');
  $messageInput = document.getElementById('messageInput');
  $loginScreen = document.getElementById('loginScreen');
  $appShell = document.getElementById('appShell');
  $loginBtn = document.getElementById('loginBtn');
  $loginPassword = document.getElementById('loginPassword');

  // Login
  $loginBtn.addEventListener('click', () => tryLogin($loginPassword.value));
  $loginPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryLogin($loginPassword.value);
  });

  // Send message
  $sendBtn.addEventListener('click', sendMessage);
  $messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // New conversation
  document.getElementById('newConvBtn')?.addEventListener('click', newConversation);

  // Setup
  setupViewRouting();
  setupModalClose();
  setupTextarea();
  setupServiceWorker();

  // Check if already authed
  checkAuth();
});
