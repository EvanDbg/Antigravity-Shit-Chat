/**
 * Drawer — Left-side cascade/project drawer
 */
import { selectCascade, closeCascade, getCurrentCascadeId, getQuotaCache, launchAntigravity } from './app.js';
import { getQuotaColor, getQuotaEmoji, shortenLabel } from './utils.js';
import { showToast } from './toast.js';

let isOpen = false;
let killResetTimer = null;
let selectedProjectPath = '';
let projectRequestSeq = 0;

// --- DOM refs ---
let $drawer, $overlay, $cascadeList, $quotaOverview;
let $projectModal, $projectList, $projectBreadcrumb, $projectOpenBtn;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getCascadeDisplayTitle(cascade, allCascades) {
  if (!cascade) return 'Untitled';
  const baseTitle = (cascade.title || 'Untitled').trim() || 'Untitled';
  const baseTitleLower = baseTitle.toLowerCase();
  const duplicateCount = allCascades.filter(c => ((c.title || 'Untitled').trim() || 'Untitled').toLowerCase() === baseTitleLower).length;
  if (duplicateCount <= 1) return baseTitle;
  return `${baseTitle} · ${String(cascade.id || '').slice(-4)}`;
}

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

function normalizeDrawerOverlayState(forceClosed = false) {
  const drawerOpen = !forceClosed && !!$drawer?.classList.contains('open');
  isOpen = drawerOpen;
  if ($drawer) $drawer.classList.toggle('open', drawerOpen);
  if ($overlay) $overlay.classList.toggle('active', drawerOpen);
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
    const displayTitle = getCascadeDisplayTitle(c, cascades);
    const safeTitle = escapeHtml(displayTitle);
    return `
      <div class="cascade-item ${isActive ? 'active' : ''}" data-cascade-id="${c.id}">
        <span class="status-dot ${dotClass}"></span>
        <span class="cascade-title" title="${safeTitle}">${safeTitle}</span>
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

function updateProjectOpenButton() {
  if (!$projectOpenBtn) return;
  const hasSelection = !!selectedProjectPath;
  $projectOpenBtn.disabled = !hasSelection;
  $projectOpenBtn.textContent = hasSelection ? 'Open' : 'Select Folder';
}

function renderProjectBreadcrumb(pathText) {
  if (!$projectBreadcrumb) return;
  const path = String(pathText || '').trim();
  if (!path) {
    $projectBreadcrumb.innerHTML = '<span>/</span>';
    return;
  }

  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/|$)/);
  const isAbsoluteUnix = normalized.startsWith('/');

  let crumbs = [];
  let acc = '';

  if (driveMatch) {
    acc = `${driveMatch[1]}\\`;
    crumbs.push({ label: driveMatch[1], path: acc });
    const rest = normalized.slice(driveMatch[0].length).split('/').filter(Boolean);
    for (const part of rest) {
      acc = `${acc}${part}\\`;
      crumbs.push({ label: part, path: acc });
    }
  } else {
    if (isAbsoluteUnix) {
      acc = '/';
      crumbs.push({ label: '/', path: '/' });
    }
    for (const part of parts) {
      if (acc === '' || acc === '/') acc = `${acc}${part}`;
      else acc = `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }

  $projectBreadcrumb.innerHTML = crumbs.map((c, idx) => {
    const isLast = idx === crumbs.length - 1;
    if (isLast) {
      return `<strong>${c.label}</strong>`;
    }
    return `<span data-project-nav="${encodeURIComponent(c.path)}">${c.label}</span><span>/</span>`;
  }).join('');
}

function renderProjectList(items, parentPath) {
  if (!$projectList) return;

  const rows = [];
  if (parentPath) {
    rows.push(`
      <div class="account-card" data-project-nav="${encodeURIComponent(parentPath)}">
        <div class="account-email">⬆️ ..</div>
        <div class="account-tier">Parent</div>
      </div>
    `);
  }

  if (!items || items.length === 0) {
    rows.push('<div class="text-muted" style="padding:12px 4px">No folders here</div>');
  } else {
    for (const item of items) {
      const isSelected = item.path === selectedProjectPath;
      rows.push(`
        <div class="account-card ${isSelected ? 'current' : ''}" data-project-path="${encodeURIComponent(item.path)}">
          <div class="account-email">📁 ${item.name}</div>
          <div class="account-tier">Tap to select</div>
          <button class="btn btn-secondary" type="button" data-project-nav="${encodeURIComponent(item.path)}">Enter</button>
        </div>
      `);
    }
  }

  $projectList.innerHTML = rows.join('');
}

function setProjectLoading(text = 'Loading...') {
  if ($projectList) {
    $projectList.innerHTML = `<div class="text-muted" style="padding:12px 4px">${text}</div>`;
  }
}

async function loadProjectDirectory(pathToLoad, opts = {}) {
  const { preserveSelection = false } = opts;
  if (!$projectList) return;

  const reqId = ++projectRequestSeq;
  setProjectLoading('Loading folders...');

  try {
    const query = pathToLoad ? `?path=${encodeURIComponent(pathToLoad)}` : '';
    const res = await fetch(`/api/browse${query}`);
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Browse failed (${res.status})`);
    }

    if (reqId !== projectRequestSeq) return;

    const currentProjectPath = data.currentPath || pathToLoad || '';
    if (!preserveSelection || !selectedProjectPath) {
      selectedProjectPath = currentProjectPath;
    }
    renderProjectBreadcrumb(currentProjectPath);
    renderProjectList(data.items || [], data.parentPath || null);
    updateProjectOpenButton();
  } catch (err) {
    console.error('Browse project error:', err);
    if (reqId !== projectRequestSeq) return;
    setProjectLoading(`Browse failed: ${err.message || 'Unknown error'}`);
    showToast({
      title: '⚠️ Browse Failed',
      body: err.message || 'Cannot list directories'
    });
  }
}

async function openProjectModal() {
  if (!$projectModal || !$projectList) return;

  selectedProjectPath = '';
  updateProjectOpenButton();
  $projectModal.classList.add('active');

  try {
    const rootRes = await fetch('/api/workspace-root');
    if (rootRes.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const rootData = await rootRes.json().catch(() => ({}));
    const initialRoot = rootData.root || '';
    await loadProjectDirectory(initialRoot);
  } catch (err) {
    console.error('Workspace root error:', err);
    setProjectLoading(`Init failed: ${err.message || 'Unknown error'}`);
    showToast({
      title: '⚠️ Init Failed',
      body: err.message || 'Cannot resolve workspace root'
    });
  }
}

async function submitOpenProject() {
  if (!selectedProjectPath || !$projectOpenBtn) {
    showToast({ title: 'ℹ️ Select a Folder', body: 'Choose a directory first' });
    return;
  }

  const originalText = $projectOpenBtn.textContent;
  $projectOpenBtn.disabled = true;
  $projectOpenBtn.textContent = 'Opening...';

  try {
    const res = await fetch('/api/open-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: selectedProjectPath })
    });

    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Open failed (${res.status})`);
    }

    $projectModal?.classList.remove('active');
    closeDrawer();

    const methodTag = data.method ? ` via ${data.method}` : '';
    showToast({
      title: '✅ Project Opened',
      body: `Opening ${selectedProjectPath}${methodTag}`
    });
  } catch (err) {
    console.error('Open project error:', err);
    showToast({
      title: '❌ Open Failed',
      body: err.message || 'Unable to open project in IDE'
    });
  } finally {
    $projectOpenBtn.textContent = originalText || 'Open';
    updateProjectOpenButton();
  }
}

function handleProjectListClick(e) {
  const nav = e.target.closest('[data-project-nav]');
  if (nav) {
    const nextPath = decodeURIComponent(nav.dataset.projectNav || '');
    if (nextPath) loadProjectDirectory(nextPath, { preserveSelection: false });
    return;
  }

  const folder = e.target.closest('[data-project-path]');
  if (!folder) return;
  const pathValue = decodeURIComponent(folder.dataset.projectPath || '');
  if (!pathValue) return;

  selectedProjectPath = pathValue;
  updateProjectOpenButton();

  const cards = $projectList?.querySelectorAll('[data-project-path]') || [];
  cards.forEach(card => {
    const cardPath = decodeURIComponent(card.dataset.projectPath || '');
    card.classList.toggle('current', cardPath === selectedProjectPath);
  });
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  $drawer = document.getElementById('drawer');
  $overlay = document.getElementById('drawerOverlay');
  $cascadeList = document.getElementById('cascadeList');
  $quotaOverview = document.getElementById('quotaOverview');
  $projectModal = document.getElementById('projectModal');
  $projectList = document.getElementById('projectList');
  $projectBreadcrumb = document.getElementById('projectBreadcrumb');
  $projectOpenBtn = document.getElementById('projectOpenBtn');

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

  document.getElementById('openProjectBtn')?.addEventListener('click', openProjectModal);
  $projectOpenBtn?.addEventListener('click', submitOpenProject);
  $projectList?.addEventListener('click', handleProjectListClick);
  $projectBreadcrumb?.addEventListener('click', handleProjectListClick);

  updateProjectOpenButton();
});

// Listen for state updates from app.js
document.addEventListener('cascades-updated', (e) => {
  const { cascades, currentCascadeId } = e.detail;
  normalizeDrawerOverlayState();
  renderCascadeList(cascades, currentCascadeId);
  renderQuotaOverview();
});

document.addEventListener('cascade-selected', () => {
  normalizeDrawerOverlayState();
});
