/**
 * Settings — "More" view with theme toggle, accounts, notifications
 */
import { getSnapshotTheme } from './chat.js';
import { escapeHtml, urlBase64ToUint8Array } from './utils.js';
import { showToast } from './toast.js';

let accountModalState = {
  accounts: [],
  currentId: '',
  currentLabel: '',
  switchingId: ''
};

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
  document.getElementById('acctModalBody')?.addEventListener('click', onAccountModalClick);

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
  accountModalState = {
    accounts: [],
    currentId: '',
    currentLabel: '',
    switchingId: ''
  };
  body.innerHTML = '<div class="chat-loading">Loading accounts...</div>';

  await loadAccounts(body);
}

async function loadAccounts(body, { preserveSwitching = false } = {}) {
  const previousSwitchingId = preserveSwitching ? accountModalState.switchingId : '';

  try {
    const [accountsRes, currentRes] = await Promise.all([
      fetch('/api/manager/accounts'),
      fetch('/api/manager/current')
    ]);

    if (accountsRes.status === 401 || currentRes.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    if (accountsRes.status === 501 || currentRes.status === 501) {
      body.innerHTML = '<div class="text-muted" style="padding:20px;text-align:center">Manager not configured.<br><small>Set managerUrl and managerPassword in config.json</small></div>';
      return;
    }

    if (!accountsRes.ok) throw new Error(`HTTP ${accountsRes.status}`);
    if (!currentRes.ok) throw new Error(`HTTP ${currentRes.status}`);

    const accountsData = await accountsRes.json();
    const currentData = await currentRes.json();
    const accounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
    const currentId = getEffectiveCurrentAccountId(accountsData, currentData);
    const currentAccount = accounts.find(acct => acct?.id === currentId) || getCurrentAccountObject(currentData);

    accountModalState = {
      accounts,
      currentId,
      currentLabel: getAccountLabel(currentAccount) || getAccountLabel(getCurrentAccountObject(accountsData)) || 'Unknown account',
      switchingId: previousSwitchingId && previousSwitchingId !== currentId ? previousSwitchingId : ''
    };

    renderAccounts(body, accountModalState);
  } catch (e) {
    body.innerHTML = `<div class="text-muted" style="padding:20px;text-align:center">Cannot reach Manager<br><small>${escapeHtml(e.message)}</small></div>`;
  }
}

function getEffectiveCurrentAccountId(accountsData, currentData) {
  return pickCurrentAccountId(currentData)
    || pickCurrentAccountId(accountsData)
    || '';
}

function pickCurrentAccountId(data) {
  if (!data || typeof data !== 'object') return '';
  return data.current_account_id
    || data.currentAccountId
    || data.account_id
    || data.accountId
    || data.id
    || data.account?.id
    || data.current_account?.id
    || data.currentAccount?.id
    || '';
}

function getCurrentAccountObject(data) {
  if (!data || typeof data !== 'object') return null;
  return data.account || data.current_account || data.currentAccount || null;
}

function renderAccounts(container, state) {
  const { accounts, currentId, currentLabel, switchingId } = state;

  const currentSummary = currentId
    ? `<div class="account-current-banner">
        <div class="account-current-label">Effective current account</div>
        <div class="account-current-value">${escapeHtml(currentLabel || currentId)}</div>
      </div>`
    : '';

  if (!accounts || accounts.length === 0) {
    container.innerHTML = `${currentSummary}<div class="text-muted" style="padding:20px;text-align:center">No accounts found</div>`;
    return;
  }

  accounts.sort((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return (a.email || '').localeCompare(b.email || '');
  });

  container.innerHTML = `${currentSummary}<div class="account-list">${accounts.map(acct => {
     const isCurrent = acct.id === currentId;
      const isSwitching = acct.id === switchingId;
      const summary = getAccountSummary(acct, isCurrent);
      const details = getAccountDetails(acct);
      const quotaRows = getQuotaRows(acct);
      const badge = isCurrent
        ? '<span class="account-badge current">Current</span>'
        : (isSwitching ? '<span class="account-badge switching">Switching…</span>' : '<span class="account-badge">Switch</span>');
      const detailsMarkup = details.length
        ? `<div class="account-meta">${details.map(detail => `<span class="account-meta-chip">${escapeHtml(detail)}</span>`).join('')}</div>`
        : '';
      const quotaMarkup = quotaRows.length
        ? `<div class="account-quota-list">${quotaRows.map(row => `
            <div class="account-quota-row">
              <span class="account-quota-model">${escapeHtml(row.label)}</span>
              <span class="account-quota-value">${escapeHtml(row.value)}</span>
            </div>`).join('')}</div>`
        : '';

      return `
        <button type="button" class="account-card ${isCurrent ? 'current' : ''} ${isSwitching ? 'switching' : ''}" data-account-id="${escapeHtml(acct.id || '')}" ${isCurrent || isSwitching ? 'disabled' : ''} aria-busy="${isSwitching ? 'true' : 'false'}">
          <div class="account-card-main">
            <div class="account-email">${escapeHtml(getAccountLabel(acct))}</div>
            <div class="account-tier">${escapeHtml(summary)}</div>
            ${detailsMarkup}
            ${quotaMarkup}
          </div>
          ${badge}
        </button>`;
  }).join('')}</div>`;
}

function getAccountLabel(account) {
  if (!account || typeof account !== 'object') return '';
  return account.email || account.name || account.username || account.id || 'Unknown account';
}

function getAccountSummary(account, isCurrent) {
  const pieces = [];
  const tier = account?.quota?.subscription_tier || account?.subscription_tier || account?.tier || account?.plan;
  const status = account?.status || account?.subscription_status;

  if (tier) pieces.push(String(tier));
  if (status && String(status).toLowerCase() !== String(tier || '').toLowerCase()) {
    pieces.push(String(status));
  }
  if (isCurrent) pieces.push('Active');

  return pieces.join(' · ') || (isCurrent ? 'Active' : 'Available');
}

function getAccountDetails(account) {
  const detailFields = [
    ['quota.subscription_tier', 'Plan'],
    ['quota.last_updated', 'Updated'],
    ['quota.is_forbidden', 'Forbidden'],
    ['disabled', 'Disabled'],
    ['proxy_disabled', 'Proxy Disabled'],
    ['validation_blocked', 'Validation Blocked'],
    ['last_used', 'Last Used'],
    ['refresh_status', 'Refresh'],
    ['subscription_status', 'Subscription']
  ];

  const details = [];
  for (const [path, label] of detailFields) {
    const value = getNestedValue(account, path);
    const formatted = formatAccountDetailValue(value);
    if (!formatted) continue;
    const text = `${label}: ${formatted}`;
    if (!details.includes(text)) details.push(text);
  }
  return details.slice(0, 4);
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return value[key];
  }, obj);
}

function formatAccountDetailValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1000000000) {
      return formatTimestamp(value);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return formatTimestamp(trimmed);
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return '';
}

function getQuotaRows(account) {
  const models = Array.isArray(account?.quota?.models) ? account.quota.models : [];
  if (!models.length) return [];

  const ranked = [...models]
    .filter(model => model && typeof model === 'object')
    .sort((a, b) => {
      const pctA = typeof a.percentage === 'number' ? a.percentage : -1;
      const pctB = typeof b.percentage === 'number' ? b.percentage : -1;
      return pctA - pctB;
    })
    .slice(0, 3);

  return ranked.map(model => {
    const percent = typeof model.percentage === 'number' ? `${Math.round(model.percentage)}%` : '—';
    const reset = model.reset_time ? ` · reset ${formatTimestamp(model.reset_time)}` : '';
    return {
      label: formatModelName(model.name || 'Quota'),
      value: `${percent}${reset}`
    };
  });
}

function formatModelName(name) {
  return String(name || 'Quota')
    .split('-')
    .map(part => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function formatTimestamp(value) {
  const date = normalizeDate(value);
  if (!date) return String(value).trim().replace(/[T]/g, ' ').replace(/\.\d+Z$/, 'Z');

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function normalizeDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1000000000000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

async function onAccountModalClick(event) {
  const button = event.target.closest('[data-account-id]');
  if (!button || button.disabled) return;

  const accountId = button.dataset.accountId;
  if (!accountId || accountId === accountModalState.currentId || accountModalState.switchingId) return;

  const body = document.getElementById('acctModalBody');
  if (!body) return;

  accountModalState.switchingId = accountId;
  renderAccounts(body, accountModalState);

  try {
    const res = await fetch('/api/manager/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, accountId, id: accountId })
    });

    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        message = data?.error || data?.message || message;
      } catch (_) { }
      throw new Error(message);
    }

    showToast({
      title: 'Account switched',
      body: getAccountLabel(accountModalState.accounts.find(acct => acct.id === accountId))
    });

    body.innerHTML = '<div class="chat-loading">Refreshing accounts...</div>';
    await loadAccounts(body);
  } catch (error) {
    accountModalState.switchingId = '';
    renderAccounts(body, accountModalState);
    showToast({
      title: 'Switch failed',
      body: error.message || 'Unable to switch account'
    });
  }
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
