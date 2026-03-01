/**
 * Settings — "More" view with theme toggle, accounts, notifications
 */
import { getSnapshotTheme } from './chat.js';
import { escapeHtml, urlBase64ToUint8Array, getQuotaColor } from './utils.js';

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Theme toggle
  const themeText = document.getElementById('themeValue');
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    updateThemeLabel(themeText);
    themeBtn.addEventListener('click', () => {
      const modes = ['follow', 'light', 'dark'];
      const cur = getSnapshotTheme();
      const next = modes[(modes.indexOf(cur) + 1) % modes.length];
      
      // Dispatch event — chat.js owns setSnapshotTheme + localStorage (single source of truth)
      document.dispatchEvent(new CustomEvent('theme-toggle', { detail: { mode: next } }));
      updateThemeLabel(themeText);
    });
  }

  // Account modal
  document.getElementById('accountBtn')?.addEventListener('click', openAccountModal);

  // Notification toggle
  document.getElementById('notifToggle')?.addEventListener('click', toggleNotifications);
  checkNotifStatus();
});

function updateThemeLabel(el) {
  if (!el) return;
  const mode = getSnapshotTheme();
  const labels = { follow: 'Follow IDE', light: 'Light', dark: 'Dark' };
  el.textContent = labels[mode] || mode;
}

// ------------------------------------------------------------------
// Account Modal
// ------------------------------------------------------------------
async function openAccountModal() {
  const modal = document.getElementById('acctModal');
  const body = document.getElementById('acctModalBody');
  if (!modal || !body) return;

  modal.classList.add('active');
  body.innerHTML = '<div class="chat-loading">Loading accounts...</div>';

  try {
    const res = await fetch('/api/manager/accounts');
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (res.status === 501) {
      body.innerHTML = '<div class="text-muted" style="padding:20px;text-align:center">Manager not configured.<br><small>Set managerUrl in config.json</small></div>';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAccounts(body, data.accounts, data.current_account_id);
  } catch (e) {
    body.innerHTML = `<div class="text-muted" style="padding:20px;text-align:center">Cannot reach Manager<br><small>${escapeHtml(e.message)}</small></div>`;
  }
}

function renderAccounts(container, accounts, currentId) {
  if (!accounts || accounts.length === 0) {
    container.innerHTML = '<div class="text-muted" style="padding:20px;text-align:center">No accounts found</div>';
    return;
  }

  accounts.sort((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return (a.email || '').localeCompare(b.email || '');
  });

  container.innerHTML = accounts.map(acct => {
    const isCurrent = acct.id === currentId;
    const tier = acct.quota?.subscription_tier || '';
    return `
      <div class="account-card ${isCurrent ? 'current' : ''}">
        <div>
          <div class="account-email">${escapeHtml(acct.email || acct.id)}</div>
          <div class="account-tier">${tier}${isCurrent ? ' · Active' : ''}</div>
        </div>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------------
// Notifications
// ------------------------------------------------------------------
async function toggleNotifications() {
  if (!('serviceWorker' in navigator)) {
    alert('Service Worker not available. Push notifications require HTTPS.');
    return;
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (e) {
    alert('Service Worker failed: ' + e.message);
    return;
  }

  if (!reg.pushManager) {
    alert('Push not supported. Open from Home Screen PWA.');
    return;
  }

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
  }
  if (Notification.permission !== 'granted') {
    alert('Notification permission denied.');
    return;
  }

  const existing = await reg.pushManager.getSubscription();
  const statusEl = document.getElementById('notifValue');

  if (existing) {
    await existing.unsubscribe();
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: existing.endpoint })
    });
    if (statusEl) statusEl.textContent = 'Off';
  } else {
    try {
      const res = await fetch('/api/push/vapid-key');
      const { publicKey } = await res.json();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON())
      });
      if (statusEl) statusEl.textContent = 'On';
    } catch (err) {
      console.error('Push subscribe failed:', err);
      alert('Failed to subscribe: ' + err.message);
    }
  }
}

async function checkNotifStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const el = document.getElementById('notifValue');
    if (el) el.textContent = sub ? 'On' : 'Off';
  } catch (_) { }
}
