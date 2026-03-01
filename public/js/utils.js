/**
 * Shared utility functions
 */

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function getQuotaColor(pct) {
  if (pct === null || pct === undefined) return 'var(--text-muted)';
  if (pct >= 50) return 'var(--success)';
  if (pct >= 30) return 'var(--warning)';
  if (pct > 0) return 'var(--danger)';
  return 'var(--text-muted)';
}

export function getQuotaEmoji(pct) {
  if (pct === null || pct === undefined) return '⚫';
  if (pct >= 50) return '🟢';
  if (pct >= 30) return '🟡';
  if (pct > 0) return '🔴';
  return '⚫';
}

export function shortenLabel(label) {
  return label
    .replace('(Thinking)', '(T)')
    .replace('(Medium)', '(M)')
    .replace('(High)', '(H)')
    .replace('(Low)', '(L)');
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
