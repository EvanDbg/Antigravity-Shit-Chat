/**
 * Drawer — Left-side cascade/project drawer
 */
import { selectCascade, closeCascade, getCascades, getCurrentCascadeId, getQuotaCache, launchAntigravity } from './app.js';
import { getQuotaColor, getQuotaEmoji, shortenLabel } from './utils.js';

let isOpen = false;
let killResetTimer = null;

// --- DOM refs ---
let $drawer, $overlay, $cascadeList, $quotaOverview;

// ------------------------------------------------------------------
// Toggle
// ------------------------------------------------------------------
function openDrawer() {
  isOpen = true;
  $drawer?.classList.add('open');
  $overlay?.classList.add('active');
}

function closeDrawer() {
  isOpen = false;
  $drawer?.classList.remove('open');
  $overlay?.classList.remove('active');
}

function toggleDrawer() {
  isOpen ? closeDrawer() : openDrawer();
}

// ------------------------------------------------------------------
// Render cascade list
// ------------------------------------------------------------------
function renderCascadeList(cascades, currentCascadeId) {
  if (!$cascadeList) return;

  if (cascades.length === 0) {
    $cascadeList.innerHTML = '<div class="text-muted" style="padding:8px 12px">No active sessions</div>';
    return;
  }

  $cascadeList.innerHTML = cascades.map(c => {
    const isActive = c.id === currentCascadeId;
    const dotClass = c.active ? 'active' : '';
    return `
      <div class="cascade-item ${isActive ? 'active' : ''}" data-cascade-id="${c.id}">
        <span class="status-dot ${dotClass}"></span>
        <span class="cascade-title">${c.title || 'Untitled'}</span>
        <button class="cascade-close" data-close-cascade="${c.id}" title="Close">×</button>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------------
// Render quota overview
// ------------------------------------------------------------------
function renderQuotaOverview() {
  if (!$quotaOverview) return;
  const currentId = getCurrentCascadeId();
  if (!currentId) {
    $quotaOverview.innerHTML = '<div class="text-muted">No active session</div>';
    return;
  }
  const quota = getQuotaCache()[currentId];

  if (!quota || !quota.models || quota.models.length === 0) {
    $quotaOverview.innerHTML = '<div class="text-muted">No quota data</div>';
    return;
  }

  $quotaOverview.innerHTML = quota.models.slice(0, 4).map(m => {
    const color = getQuotaColor(m.percentage);
    const emoji = getQuotaEmoji(m.percentage);
    const pct = m.percentage !== null ? m.percentage.toFixed(0) + '%' : 'N/A';
    const w = m.percentage !== null ? m.percentage : 0;
    return `
      <div class="quota-row">
        <span class="quota-emoji">${emoji}</span>
        <span class="quota-label">${shortenLabel(m.label)}</span>
        <span class="quota-bar"><span class="quota-fill" style="width:${w}%;background:${color}"></span></span>
        <span class="quota-pct" style="color:${color}">${pct}</span>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------------
// Event handling
// ------------------------------------------------------------------
function handleCascadeClick(e) {
  // Close button
  const closeBtn = e.target.closest('[data-close-cascade]');
  if (closeBtn) {
    e.stopPropagation();
    closeCascade(closeBtn.dataset.closeCascade);
    return;
  }

  // Cascade item selection
  const item = e.target.closest('[data-cascade-id]');
  if (item) {
    selectCascade(item.dataset.cascadeId);
    closeDrawer();
  }
}

// ------------------------------------------------------------------
// Kill All
// ------------------------------------------------------------------
async function killAll() {
  if (!confirm('确定要关闭所有 Antigravity 程序吗？')) return;
  const btn = document.getElementById('killBtn');
  if (btn) btn.textContent = '⏳';
  try {
    const res = await fetch('/api/kill-all', { method: 'POST' });
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    if (btn) btn.textContent = data.success ? '✅' : '⚠️';
  } catch (err) {
    console.error('Kill-all error:', err);
    if (btn) btn.textContent = '❌';
  }
  if (killResetTimer) clearTimeout(killResetTimer);
  killResetTimer = setTimeout(() => {
    killResetTimer = null;
    if (btn) btn.textContent = '⏻ Kill All';
  }, 2000);
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  $drawer = document.getElementById('drawer');
  $overlay = document.getElementById('drawerOverlay');
  $cascadeList = document.getElementById('cascadeList');
  $quotaOverview = document.getElementById('quotaOverview');

  // Toggle button
  document.getElementById('drawerToggle')?.addEventListener('click', toggleDrawer);

  // Overlay click to close
  $overlay?.addEventListener('click', closeDrawer);

  // Cascade list clicks
  $cascadeList?.addEventListener('click', handleCascadeClick);

  // Kill all
  document.getElementById('killBtn')?.addEventListener('click', killAll);

  // Launch IDE
  document.getElementById('launchBtn')?.addEventListener('click', launchAntigravity);
});

// Listen for state updates from app.js
document.addEventListener('cascades-updated', (e) => {
  const { cascades, currentCascadeId } = e.detail;
  renderCascadeList(cascades, currentCascadeId);
  renderQuotaOverview();
});
