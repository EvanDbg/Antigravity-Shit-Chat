/**
 * Toast — Cyberpunk-style dark overlay notifications
 */

const TOAST_DURATION = 3000;
const MAX_TOASTS = 3;

let $container;

function ensureContainer() {
  if ($container) return;
  $container = document.getElementById('toastContainer');
}

// ------------------------------------------------------------------
// Show toast
// ------------------------------------------------------------------
export function showToast({ title = '', body = '', duration = TOAST_DURATION } = {}) {
  ensureContainer();
  if (!$container) return;

  // Limit max visible
  while ($container.children.length >= MAX_TOASTS) {
    $container.removeChild($container.firstChild);
  }

  const toast = document.createElement('div');
  toast.className = 'cyber-toast';
  toast.innerHTML = `
    <div class="cyber-toast-title">${title}</div>
    <div class="cyber-toast-body">${body}</div>
    <div class="cyber-toast-indicator"></div>`;

  toast.addEventListener('click', () => dismissToast(toast));
  $container.appendChild(toast);

  // Auto dismiss
  setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('fade-out');
  setTimeout(() => toast.remove(), 400);
}

// ------------------------------------------------------------------
// Listen for AI completion events
// ------------------------------------------------------------------
document.addEventListener('ai-complete', (e) => {
  showToast({
    title: '✅ AI Complete',
    body: e.detail.title || 'Task finished'
  });
});
