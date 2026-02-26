/**
 * Chat View — Shadow DOM, morphdom, CDP click passthrough, scroll sync
 */
import { escapeHtml } from './utils.js';

let shadowRoot = null;
let currentId = null;
let scrollSyncLock = false;

// Global click interceptor to track interaction coordinates for popup positioning
let lastClickEvent = null;
window.addEventListener('click', (e) => {
    lastClickEvent = e;
}, true);

let scrollTimer = null;
let pendingScrollTop = null;

// Morphdom: loaded as UMD from vendor/
const morphdomReady = new Promise((resolve) => {
  const script = document.createElement('script');
  script.src = 'vendor/morphdom.min.js';
  script.onload = () => resolve(window.morphdom);
  script.onerror = () => {
    console.warn('morphdom failed to load, falling back to innerHTML');
    resolve(null);
  };
  document.head.appendChild(script);
});

// ------------------------------------------------------------------
// Init: attach Shadow DOM to chat host
// ------------------------------------------------------------------
export function initChatView() {
  const host = document.getElementById('chatHost');
  if (!host || host.shadowRoot) return;

  shadowRoot = host.attachShadow({ mode: 'open' });
  shadowRoot.innerHTML = `
    <style id="base-style">
      :host { display: block; min-height: 100%; }
      .loading { display:flex; align-items:center; justify-content:center; height:200px; color:#999; font-size:14px; }
    </style>
    <style id="ide-style"></style>
    <style id="snapshot-adapt"></style>
    <style id="theme-override"></style>
    <div id="chat-viewport"><div class="loading">Waiting for content...</div></div>`;

  // Load snapshot adaptation CSS and Theme CSS
  loadSnapshotCSS();
  loadChatThemeCSS();

  // Event delegation for CDP click passthrough (inside Shadow DOM)
  shadowRoot.addEventListener('click', handleCDPClick);

  // Scroll sync
  const container = document.getElementById('chatContainer');
  if (container) {
    container.addEventListener('scroll', handleScrollSync);
  }

  // Ensure saved theme is applied immediately on load
  setSnapshotTheme(getSnapshotTheme());
}

// ------------------------------------------------------------------
// Load Snapshot Adaptation & Theme CSS into Shadow DOM
// ------------------------------------------------------------------
async function loadSnapshotCSS() {
  try {
    const res = await fetch('css/snapshot.css');
    if (res.ok) {
      const css = await res.text();
      const style = shadowRoot.getElementById('snapshot-adapt');
      if (style) style.textContent = css;
    }
  } catch (_) { }
}

let _themeLoading = false;
async function loadChatThemeCSS() {
  if (_themeLoading) return; // Reentrant guard: prevent concurrent fetches
  _themeLoading = true;
  try {
    const res = await fetch(`css/chat-theme.css?v=2.5.1`);
    if (res.ok) {
      const css = await res.text();
      const style = shadowRoot.getElementById('theme-override');
      if (style) style.textContent = css;
    }
  } catch (_) { }
  _themeLoading = false;
}

// ------------------------------------------------------------------
// Apply IDE styles (fetched from server)
// ------------------------------------------------------------------
export async function applyCascadeStyles(id, signal) {
  if (!shadowRoot) return;
  try {
    const res = await fetch(`/styles/${id}`, { signal });
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    const vars = data.computedVars || {};

    let varDecls = '';
    for (const [key, val] of Object.entries(vars)) {
      if (!key.startsWith('__')) varDecls += `${key}: ${val};\n`;
    }

    const editorBg = vars['--vscode-editor-background'] || '#1e1e1e';
    const editorFg = vars['--vscode-editor-foreground'] || '#e5e7eb';

    const ideStyle = shadowRoot.getElementById('ide-style');
    if (ideStyle) {
      ideStyle.textContent = `
        #chat-viewport {
          ${varDecls}
          color: var(--theme-fc, ${editorFg});
          background: var(--theme-bc, ${editorBg});
          font-size: 14px;
          line-height: 1.6;
        }

        /* Global text-decoration reset — kill IDE underlines */
        #chat-viewport, #chat-viewport * {
          text-decoration: none !important;
        }

        ${data.css || ''}

        /* Fix overflow in web context — only top-level containers */
        #chat-viewport > #conversation,
        #chat-viewport > #cascade,
        #chat-viewport > #chat,
        #chat-viewport #conversation,
        #chat-viewport #cascade,
        #chat-viewport #chat {
          overflow-y: visible !important;
          overflow-x: hidden !important;
          max-height: none !important;
          padding-bottom: 0 !important;
          margin-bottom: 0 !important;
        }

        /* Text color inheritance */
        #chat-viewport p, #chat-viewport span, #chat-viewport div,
        #chat-viewport li, #chat-viewport td, #chat-viewport th,
        #chat-viewport h1, #chat-viewport h2, #chat-viewport h3,
        #chat-viewport h4, #chat-viewport h5, #chat-viewport h6,
        #chat-viewport label, #chat-viewport a {
          color: inherit;
        }

        #cascade, #conversation, #chat {
          background: transparent !important;
          color: var(--theme-fc, ${editorFg}) !important;
        }

        /* Prose typography */
        #chat-viewport .prose, #chat-viewport [class*="prose"] {
          --tw-prose-body: var(--theme-fc, ${editorFg}) !important;
          --tw-prose-headings: var(--theme-heading, #f3f4f6) !important;
          --tw-prose-links: ${vars['--vscode-textLink-foreground'] || '#60a5fa'} !important;
          --tw-prose-bold: var(--theme-heading, #f3f4f6) !important;
          --tw-prose-code: var(--theme-heading, #f3f4f6) !important;
          --tw-prose-pre-bg: var(--theme-pre-bg, #1f2937) !important;
          color: var(--theme-fc, ${editorFg}) !important;
        }

        /* Code blocks */
        #chat-viewport pre, #chat-viewport code {
          background: var(--theme-code-bg, #111) !important;
          color: var(--theme-code-fc, #ddd) !important;
        }
        #chat-viewport pre code { background: transparent !important; }

        /* Button/form reset */
        #chat-viewport button, #chat-viewport [type='button'] {
          -webkit-appearance: button;
          background: transparent;
          border: none;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }

        /* IDE variable fallbacks */
        #chat-viewport {
          --ide-button-background: ${vars['--vscode-button-background'] || '#0078d4'};
          --ide-button-color: ${vars['--vscode-button-foreground'] || '#ffffff'};
          --ide-chat-background: ${editorBg};
          --ide-text-color: ${editorFg};
          --ide-link-color: ${vars['--vscode-textLink-foreground'] || '#60a5fa'};
        }

        /* Fix height constraints */
        #chat-viewport .h-full { height: auto !important; }
        #chat-viewport .min-h-0 { min-height: auto !important; }
      `;
    }

    // Re-apply the user's preferred theme class in case DOM reconstruction dropped it
    // or new variables need the higher specificity of the theme class to take effect
    setSnapshotTheme(getSnapshotTheme());

  } catch (e) {
    console.error('CSS refresh failed:', e);
  }
}

// ------------------------------------------------------------------
// Popup Bubble System (Decoupled from morphdom — uses dedicated /popup API)
// ------------------------------------------------------------------

// Prepare overlay for popup (no visible loading state)
function preparePopupOverlay() {
    dismissPopupBubble();
    const overlay = document.createElement('div');
    overlay.id = 'mobile-popup-overlay';
    overlay.className = 'mobile-popup-backdrop';
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) dismissPopupBubble();
    });
    document.body.appendChild(overlay);
    return overlay;
}

// Show popup bubble with items from the /popup API
function showPopupBubble(items, clickX, clickY) {
    const overlay = document.getElementById('mobile-popup-overlay');
    if (!overlay) return;

    if (!items || items.length === 0) {
        dismissPopupBubble();
        return;
    }

    const bubble = document.createElement('div');
    bubble.className = 'mobile-popup-bubble';
    overlay.appendChild(bubble);

    // Render optional header (e.g. "Conversation mode")
    if (items[0] && items[0].header) {
        const headerEl = document.createElement('div');
        headerEl.className = 'mobile-popup-header';
        headerEl.textContent = items[0].header;
        bubble.appendChild(headerEl);
    }

    items.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.className = 'mobile-popup-item';
        if (item.checked) itemEl.classList.add('mobile-popup-item-checked');

        let html = `<div class="mobile-popup-title"><span>${escapeHtml(item.title)}</span>`;
        if (item.badges && item.badges.length > 0) {
            html += `<span class="mobile-popup-badge">${escapeHtml(item.badges.join(' '))}</span>`;
        }
        html += `</div>`;

        if (item.description) {
            html += `<div class="mobile-popup-desc">${escapeHtml(item.description)}</div>`;
        }

        itemEl.innerHTML = html;

        itemEl.addEventListener('click', () => {
            // Only remove the overlay — do NOT send /dismiss here
            // The server-side /popup-click will handle the IDE popup
            const overlay = document.getElementById('mobile-popup-overlay');
            if (overlay) overlay.remove();
            if (item.title) {
                fetch(`/popup-click/${currentId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: item.title })
                }).catch(() => {});
            }
        });

        bubble.appendChild(itemEl);
    });

    positionBubble(bubble, clickX, clickY);
}

// Dismiss any visible popup bubble
function dismissPopupBubble() {
    const overlay = document.getElementById('mobile-popup-overlay');
    if (overlay) {
        overlay.remove();
        // Close the IDE popup that was left open during extraction
        if (currentId) fetch(`/dismiss/${currentId}`, { method: 'POST' }).catch(() => {});
    }
}

// Position a bubble element at the given click coordinates
function positionBubble(bubble, clickX, clickY) {
    requestAnimationFrame(() => {
        const bRect = bubble.getBoundingClientRect();
        let left = clickX - (bRect.width / 2);
        left = Math.max(16, Math.min(window.innerWidth - bRect.width - 16, left));
        bubble.style.left = left + 'px';

        const spaceBelow = window.innerHeight - clickY;
        if (spaceBelow >= (bRect.height + 20)) {
            bubble.style.top = (clickY + 12) + 'px';
            bubble.classList.add('arrow-up');
        } else {
            bubble.style.top = (clickY - bRect.height - 12) + 'px';
            bubble.classList.add('arrow-down');
        }
    });
}

// Check if a CDP element is likely a popup trigger (dropdown, select, mode button)
function isPopupTrigger(el) {
    const tag = el.tagName.toUpperCase();
    const role = el.getAttribute('role') || '';
    const cls = (el.className || '').toLowerCase();
    const text = (el.textContent || '').trim();

    // Explicit dropdown/select elements
    if (tag === 'SELECT' || tag === 'VSCODE-DROPDOWN') return true;
    if (/combobox|listbox/.test(role)) return true;

    // Class-based detection
    if (/dropdown|select|picker|combobox|trigger/i.test(cls)) return true;

    // IDE bottom-bar: buttons with `select-none` class are typically model/mode selectors
    if (/select-none/i.test(cls) && text.length < 50) return true;

    // Known model/mode text patterns (short text that matches known items)
    const knownTriggerTexts = /^(planning|fast|normal|gemini|claude|gpt|o1|o3|o4|always run|ask first|never)/i;
    if (text.length < 40 && knownTriggerTexts.test(text)) return true;

    // Check for headlessui listbox buttons or aria-haspopup
    if (el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-haspopup') === 'true') return true;
    if (el.id && /headlessui-listbox-button/.test(el.id)) return true;

    // Walk up to parent button to check headlessui or aria attributes
    const parent = el.parentElement;
    if (parent) {
        if (parent.getAttribute('aria-haspopup') === 'listbox' || parent.getAttribute('aria-haspopup') === 'true') return true;
        if (parent.id && /headlessui-listbox-button/.test(parent.id)) return true;
        if (/combobox|listbox/.test(parent.getAttribute('role') || '')) return true;
    }

    return false;
}

// ------------------------------------------------------------------
// Update content with morphdom diff
// ------------------------------------------------------------------
let lastContentHash = '';
let preventAutoBottomScroll = false;
let _preventAutoBottomTimer = null;

let currentAbortController = null;

export async function updateContent(id, signal) {
  if (!shadowRoot) return;
  try {
    const res = await fetch(`/snapshot/${id}`, { signal });
    if (!res.ok) return;
    const data = await res.json();

    // Skip if content unchanged
    const hash = data.html?.length?.toString() || '';
    if (hash === lastContentHash && hash !== '') return;
    lastContentHash = hash;

    const isInitialLoad = lastContentHash === '';
    const container = document.getElementById('chatContainer');
    const isAtBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight < 50
      : true;

    const viewport = shadowRoot.getElementById('chat-viewport');
    if (!viewport) return;

    const morphdom = await morphdomReady;

    // --- Undo Sync: Extract text from IDE's native input/textarea ---
    // Make sure we parse the temporary tree that just arrived from the snapshot
    const temp = document.createElement('div');
    temp.id = 'chat-viewport';
    temp.innerHTML = data.html;

    const ideInputNode = temp.querySelector('textarea, input[type="text"], [contenteditable="true"]');
    if (ideInputNode) {
      const undoneText = (ideInputNode.value || ideInputNode.textContent || ideInputNode.innerText || '').trim();
      if (undoneText) {
        document.dispatchEvent(new CustomEvent('ide-input-sync', { detail: { text: undoneText } }));
      }
    }


    if (morphdom) {
      // ===== DOM NOISE REDUCTION =====
      // Strip popup containers from snapshot before morphdom to avoid rendering stale popups
      const nativePopups = Array.from(temp.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], .monaco-menu-container, .context-view'));
      nativePopups.forEach(popup => {
          popup.innerHTML = '';
          popup.style.display = 'none';
      });

      morphdom(viewport, temp, {
        onBeforeElUpdated: (fromEl, toEl) => {
          if (fromEl.isEqualNode(toEl)) return false;
          if (fromEl.tagName === 'TEXTAREA' || fromEl.tagName === 'INPUT') {
            if (fromEl.value !== toEl.value) {
              fromEl.value = toEl.value;
            }
          }
          return true;
        }
      });

    } else {
      viewport.innerHTML = data.html;
    }

    // Post-process: detect file names
    const fileExtPattern = /\b([\w.-]+\.(?:md|txt|js|ts|jsx|tsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|xml|sh|bash|sql|rb|php|swift|kt|vue|svelte))\b/i;
    shadowRoot.querySelectorAll('[data-cdp-click]').forEach(el => {
      if (el.hasAttribute('data-file-name')) return;
      const text = (el.textContent || '').trim();
      const match = text.match(fileExtPattern);
      if (match) el.setAttribute('data-file-name', match[1]);
    });

    // Post-process: hide broken images (IDE-internal icon paths)
    viewport.querySelectorAll('img').forEach(img => {
      if (!img.complete || img.naturalWidth === 0) {
        img.style.display = 'none';
      }
      img.onerror = () => { img.style.display = 'none'; };
    });

    // Strip inline dark backgrounds from container elements when theme override is active
    // Only target layout containers, preserve styling on code/pre/button/badge/svg
    const theme = getSnapshotTheme();
    if (theme !== 'follow') {
      const skipTags = new Set(['CODE','PRE','BUTTON','A','SVG','PATH','IMG','INPUT','SELECT','TEXTAREA','CANVAS']);
      viewport.querySelectorAll('[style]').forEach(el => {
        if (skipTags.has(el.tagName)) return;
        // Only strip backgrounds that look dark (rgb values < 80)
        const bg = el.style.backgroundColor;
        if (bg) {
          const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
          if (match && parseInt(match[1]) < 80 && parseInt(match[2]) < 80 && parseInt(match[3]) < 80) {
            el.style.removeProperty('background-color');
          }
        }
        const bgProp = el.style.background;
        if (bgProp) {
          const match = bgProp.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
          if (match && parseInt(match[1]) < 80 && parseInt(match[2]) < 80 && parseInt(match[3]) < 80) {
            el.style.removeProperty('background');
          }
        }
      });
    }

    // ============================================================
    // Virtual list spacer compression: collapse blank top space
    // Virtuoso / Monaco's virtual list keeps a giant spacer for
    // scrolled-out history nodes. On mobile we don't render those
    // virtual items, so the first ~100k px are empty darkness.
    // Fix: shift all absolutely-positioned children upward by the
    // minimum `top` value found, then shrink the spacer accordingly.
    // ============================================================
    viewport.querySelectorAll('.monaco-list-rows').forEach(list => {
      const children = Array.from(list.children);
      let minTop = Infinity;
      for (const child of children) {
        const t = parseFloat(child.style.top);
        if (!isNaN(t) && t < minTop) minTop = t;
      }
      if (minTop > 100 && isFinite(minTop)) {
        for (const child of children) {
          const t = parseFloat(child.style.top);
          if (!isNaN(t)) child.style.top = (t - minTop) + 'px';
        }
        const listH = parseFloat(list.style.height);
        if (!isNaN(listH) && listH > minTop) {
          list.style.height = (listH - minTop) + 'px';
        }
        if (list.parentElement) {
          for (const sib of Array.from(list.parentElement.children)) {
            if (sib === list) continue;
            const sibH = parseFloat(sib.style.height);
            if (!isNaN(sibH) && sibH > minTop) {
              sib.style.height = (sibH - minTop) + 'px';
            }
          }
        }
      }
    });

    // 恢复 IDE 虚拟列表的超真实全量高度，不能强制缩小，否则会摧毁上下滑动的滚动对位比（ ratio 错位致盲）
    let maxContentBottom = 0;
    viewport.querySelectorAll('.monaco-list-rows').forEach(list => {
      Array.from(list.children).forEach(child => {
        const bottom = child.offsetTop + child.offsetHeight;
        if (bottom > maxContentBottom) maxContentBottom = bottom;
      });
    });

    // 触发滚动补丁：当容器本身就滚动到底部，或者这是第一次加载
    // 【拦截器】如果最近有过交互点击阻止向下强拉视野的行为（防止展开大量折叠项时视野乱飞）
    if ((isAtBottom || isInitialLoad) && container && !preventAutoBottomScroll) {
      // 在原先的暴力拖底方案中（scrollTop = scrollHeight），由于 IDE 喜欢在下方附带成千上万像素的虚拟占位符，
      // 会导致滑落无底深渊。现在我们既然测得了真实 DOM 排布到了哪里 (maxContentBottom)，
      // 那么理想的降落点，其实就是将这批最后内容的底缘，卡在视口（clientHeight）的底盘处（并附带上可能的一点 Padding）。
      let targetScrollTop = container.scrollHeight;
      if (maxContentBottom > container.clientHeight) {
        // 取真实节点底边与视区差，再做安全范围限定
        targetScrollTop = maxContentBottom - container.clientHeight + 60; 
      }
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(targetScrollTop, maxScroll);
    }
    
    // Re-apply theme class stripped by morphdom during HTML diffing
    setSnapshotTheme(getSnapshotTheme());
  } catch (_) { }
}

// ------------------------------------------------------------------
// Global Popup ClickAway & Dynamic Positioning Variables
// ------------------------------------------------------------------
let lastClickedCdpIndex = null;
let lastPopupIndex = 0;

document.addEventListener('click', async (e) => {
  // Ignore clicks inside popups or on potential trigger elements
  if (e.target.closest('[data-portal-popup="true"], [role="menu"], [role="listbox"], .monaco-menu-container, .context-view, [data-radix-popper-content-wrapper], [data-cdp-click]')) {
      return; 
  }
  
  if (!currentId) return;

  const visiblePopups = shadowRoot ? shadowRoot.querySelectorAll('#chat-viewport [data-portal-popup="true"], #chat-viewport [role="menu"], #chat-viewport [role="listbox"], #chat-viewport .context-view, #chat-viewport [data-radix-popper-content-wrapper], #chat-viewport .monaco-menu-container') : [];
  let foundVisible = false;
  visiblePopups.forEach(p => {
      // Intentionally close it
      if (p.style.display !== 'none' && p.style.opacity !== '0') {
          p.style.setProperty('display', 'none', 'important');
          p.style.setProperty('opacity', '0', 'important');
          p.style.setProperty('pointer-events', 'none', 'important');
          foundVisible = true;
      }
  });

  if (foundVisible) {
      try {
          // Send escape key sequence to IDE natively
          await fetch(`/api/dismiss-popups/${currentId}`, { method: 'POST' });
          // Force UI refresh quickly to visually match the logic state
          document.dispatchEvent(new CustomEvent('snapshot-update', { detail: { id: currentId } }));
      } catch(err) {}
  }
});

// ------------------------------------------------------------------
// Custom Dropdown Fallback for Native Select/VSCode-Dropdown
// ------------------------------------------------------------------
function renderCustomNativeDropdown(el, idx, options) {
    const old = document.body.querySelector('.native-dropdown-fallback');
    if (old) old.remove();

    const popup = document.createElement('div');
    popup.className = 'native-dropdown-fallback';
    popup.setAttribute('data-portal-popup', 'true');
    
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    
    popup.style.position = 'fixed';
    popup.style.width = Math.max(160, rect.width) + 'px';
    popup.style.maxHeight = '40vh';
    popup.style.overflowY = 'auto';
    popup.style.background = 'var(--vscode-dropdown-background, #252526)';
    popup.style.border = '1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.2))';
    popup.style.color = 'var(--vscode-dropdown-foreground, #f0f0f0)';
    popup.style.borderRadius = '6px';
    popup.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
    popup.style.zIndex = '10000';
    popup.style.padding = '4px';

    let leftPos = rect.left;
    leftPos = Math.max(10, Math.min(leftPos, window.innerWidth - Math.max(160, rect.width) - 10));
    popup.style.left = leftPos + 'px';
    
    if (rect.top > (vh - rect.bottom) && rect.top > 250) {
        popup.style.bottom = Math.max(10, vh - rect.top + 5) + 'px';
    } else {
        popup.style.top = Math.max(10, rect.bottom + 5) + 'px';
    }

    options.forEach(opt => {
        const item = document.createElement('div');
        item.textContent = opt.textContent.trim() || opt.value || 'Option';
        item.style.padding = '10px 14px';
        item.style.cursor = 'pointer';
        item.style.borderRadius = '4px';
        item.style.fontSize = '14px';
        item.style.minHeight = '24px';
        
        const isSelected = opt.selected || opt.hasAttribute('selected');
        if (isSelected) {
            item.style.background = 'var(--vscode-list-activeSelectionBackground, #094771)';
            item.style.color = 'var(--vscode-list-activeSelectionForeground, #ffffff)';
        }

        const hoverOn = () => { if (!isSelected) item.style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)'; };
        const hoverOff = () => { if (!isSelected) item.style.background = 'transparent'; };
        item.addEventListener('touchstart', hoverOn);
        item.addEventListener('mouseenter', hoverOn);
        item.addEventListener('mouseleave', hoverOff);

        item.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const val = opt.value || opt.getAttribute('value') || opt.textContent.trim();
            
            popup.remove();
            try {
                await fetch(`/api/set-value/${window.currentId || currentId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ elementIndex: idx, value: val })
                });
                document.dispatchEvent(new CustomEvent('snapshot-update', { detail: { id: currentId } }));
            } catch(err) { console.error(err); }
        });
        popup.appendChild(item);
    });

    const viewport = document.getElementById('chat-viewport');
    if (viewport) viewport.appendChild(popup);
}

// ------------------------------------------------------------------
// CDP click passthrough (using composedPath for Shadow DOM)
// ------------------------------------------------------------------
async function handleCDPClick(e) {
  const path = e.composedPath();

  let clickable = null;

  const topTarget = path[0];
  if (topTarget && topTarget.tagName) {
      fetch('/api/telemetry', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
              event: 'click_intercept',
              targetTag: topTarget.tagName,
              targetClass: topTarget.className,
              targetText: topTarget.textContent?.slice(0, 50),
              targetHTML: topTarget.outerHTML?.slice(0, 200),
              pathTrace: path.map(p => p.tagName).filter(Boolean).join(' > ')
          })
      }).catch(()=>{});
  }
  
  for (const el of path) {
    if (el.nodeType !== 1) continue;
    
    const tag = el.tagName.toUpperCase();
    const role = el.getAttribute?.('role') || '';

    // 1. Explicitly blocked elements where native behavior OR selection should dominate
    if (/^(CODE|PRE|TABLE|THEAD|TBODY|TR|TH|TD|SUMMARY|DETAILS|INPUT|TEXTAREA)$/.test(tag)) {
      fetch('/api/telemetry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'blocked_by_tag', tag})}).catch(()=>{});
      return; 
    }

    // 2. We hit an element mapped to CDP
    if (el.hasAttribute?.('data-cdp-click')) {
      const cls = el.className || '';
      
      // A valid button DIV shouldn't contain heavy block elements like paragraphs, code blocks, or tables
      const isContainerDiv = el.querySelector('p, pre, table, ul, ol, iframe, code');
      
      // Only honor it if it's an actionable UI tag OR it looks like a custom button container
      if (/^(A|BUTTON|SPAN|I|SVG|PATH|SELECT|VSCODE-DROPDOWN)$/.test(tag) || 
          /^(button|menuitem|option|combobox|listbox|tab)$/i.test(role) ||
          (tag === 'DIV' && typeof cls === 'string' && /pointer|btn|button|action|clickable|menu|toolbar|select|dropdown|backdrop|overlay|dialog|context-view/i.test(cls) && !isContainerDiv)) {
        clickable = el;
      } else {
        fetch('/api/telemetry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'ignored_cdp_element', tag, cls, role, isContainerDiv: !!isContainerDiv})}).catch(()=>{});
      }
      break; 
    }
  }

  if (!clickable || !currentId) return;

  const tag = clickable.tagName.toUpperCase();
  const idx = clickable.getAttribute('data-cdp-click');

  // If clicked element contains manual options, expose them as a native UI overlay
  const options = Array.from(clickable.querySelectorAll('vscode-option, option'));
  
  fetch('/api/telemetry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'checking_options', tag, optionsFound: options.length, outerHTML: clickable.outerHTML?.slice(0, 200)})}).catch(()=>{});

  if (options.length > 0 || tag === 'SELECT' || tag === 'VSCODE-DROPDOWN') {
      e.stopPropagation();
      e.preventDefault();
      fetch('/api/telemetry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'intercepted_as_native_dropdown', tag, optionsCount: options.length})}).catch(()=>{});
      if (options.length > 0) {
          renderCustomNativeDropdown(clickable, idx, options);
      } else {
          fetch('/api/telemetry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'empty_dropdown_intercepted'})}).catch(()=>{});
      }
      return;
  }

  // ===== POPUP TRIGGER PATH =====
  // If the element looks like a popup trigger (dropdown, model selector, mode button),
  // use the dedicated /popup API instead of morphdom-based extraction
  if (isPopupTrigger(clickable)) {
      e.preventDefault();
      e.stopPropagation();
      
      const clickX = lastClickEvent ? lastClickEvent.clientX : window.innerWidth / 2;
      const clickY = lastClickEvent ? lastClickEvent.clientY : window.innerHeight / 2;
      
      // Prepare invisible overlay (no loading state shown)
      const overlay = preparePopupOverlay();
      overlay.dataset.triggerIndex = idx;
      overlay.dataset.clickX = clickX;
      overlay.dataset.clickY = clickY;
      
      // Request popup content and show directly when ready
      try {
          const res = await fetch(`/popup/${currentId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index: parseInt(idx) })
          });
          const data = await res.json();
          showPopupBubble(data.items, clickX, clickY);
      } catch (err) {
          dismissPopupBubble();
      }
      return;
  }

  lastClickedCdpIndex = idx;
  fetch('/api/telemetry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'passing_cdp_click_to_backend', cdpId: idx})}).catch(()=>{});

  e.preventDefault();
  e.stopPropagation();
  const hasFileName = clickable.hasAttribute('data-file-name');
  clickable.style.opacity = '0.6';

  try {
    // 仅在明确点击带有文件名的元素（打算预览文件内容）时，才尝试关闭当前的旧标签页。
    // 严禁在此处无条件调用，否则会误杀“收起/展开”等普通 UI 控件。
    if (hasFileName) {
      try {
        const closeRes = await fetch(`/api/close-tab/${currentId}`, { method: 'POST' });
        const closeData = await closeRes.json();
        if (closeData.success) await new Promise(r => setTimeout(r, 300));
      } catch (_) { }
    }

    // Record current tab for non-file elements
    let beforeTab = null;
    if (!hasFileName) {
      try {
        const beforeRes = await fetch(`/api/active-tab-name/${currentId}`);
        beforeTab = await beforeRes.json();
      } catch (_) { /* 网络异常时跳过 tab 记录 */ }
      
      // 当非文件跳转类点击触发时（很大可能是面板折叠、按钮），
      // 为其锁定随后 1.5 秒内的追底行为，以防内容大幅变动引起阅读视口塌陷。
      preventAutoBottomScroll = true;
      clearTimeout(_preventAutoBottomTimer);
      _preventAutoBottomTimer = setTimeout(() => { preventAutoBottomScroll = false; }, 1500);
    }

    // Execute CDP click
    await fetch(`/click/${currentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: parseInt(idx) })
    });

    // 主动即刻隐藏当前所点击的具有弹窗背景性质的遮罩及浮层组合，配合后端刷新制造出无缝消失感
    if (clickable.tagName.toUpperCase() === 'DIV' && /backdrop|overlay/.test(clickable.className)) {
        document.querySelectorAll('#chat-viewport [role="menu"], #chat-viewport [role="listbox"], #chat-viewport .context-view, #chat-viewport [data-radix-popper-content-wrapper], #chat-viewport .monaco-menu-container').forEach(el => el.style.display = 'none');
    }

    // 瞬间广播：无需等待1000ms定时器，强制立即拉取最新 Snapshot，达到弹窗秒关的效果
    document.dispatchEvent(new CustomEvent('snapshot-update', { detail: { id: currentId } }));

    await new Promise(r => setTimeout(r, 400));

    // Decide whether to show file preview
    if (hasFileName) {
      document.dispatchEvent(new CustomEvent('open-file-preview'));
    } else {
      const afterRes = await fetch(`/api/active-tab-name/${currentId}`);
      const afterTab = await afterRes.json();
      if (afterTab.name && afterTab.name !== beforeTab?.name) {
        document.dispatchEvent(new CustomEvent('open-file-preview'));
      }
    }
  } catch (err) {
    console.error('Click passthrough error:', err);
  } finally {
    setTimeout(() => { clickable.style.opacity = ''; }, 300);
  }
}

// ------------------------------------------------------------------
// Scroll sync
// ------------------------------------------------------------------
function handleScrollSync() {
  if (!currentId) return;

  const container = document.getElementById('chatContainer');
  
  if (scrollSyncLock) {
    // Save scroll requests that happen during an ongoing fetch/render lock
    pendingScrollTop = container.scrollTop;
    return;
  }

  if (scrollTimer) clearTimeout(scrollTimer);

  scrollTimer = setTimeout(() => {
    pendingScrollTop = null;
    const max = container.scrollHeight - container.clientHeight;
    if (max <= 0) return;
    const ratio = container.scrollTop / max;

    // Lock immediately so rapid scroll events before fetch resolves are queued
    scrollSyncLock = true;

    // ----- [DEBUG PROBE] -----
    fetch('/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'handleScrollSync_Trigger',
        scrollTop: container.scrollTop,
        maxScroll: max,
        ratio: ratio,
        containerHeight: container.clientHeight
      })
    }).catch(()=>{});
    // -------------------------

    fetch(`/scroll/${currentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratio, scrollTop: container.scrollTop })
    }).then(() => {
      setTimeout(() => {
        updateContent(currentId).finally(() => {
          setTimeout(() => { 
            scrollSyncLock = false; 
            // Drain the pending scroll event if user kept scrolling!
            if (pendingScrollTop !== null) {
              handleScrollSync();
            }
          }, 200);
        });
      }, 400);
    }).catch(e => {
      console.error('Scroll sync error:', e);
      scrollSyncLock = false;
      if (pendingScrollTop !== null) handleScrollSync();
    }).finally(() => {
      // Ensure lock is released even on network failure
      setTimeout(() => { 
        if (scrollSyncLock) {
          scrollSyncLock = false; 
          if (pendingScrollTop !== null) handleScrollSync();
        }
      }, 2500);
    });
  }, 300);
}

// ------------------------------------------------------------------
// Theme override (three-mode) — idempotent, single source of truth
// ------------------------------------------------------------------
export function setSnapshotTheme(mode) {
  if (!shadowRoot) return;
  const viewport = shadowRoot.getElementById('chat-viewport');
  if (!viewport) return;

  // Idempotency: skip if theme class already matches target
  const currentClass = viewport.classList.contains('theme-light') ? 'light'
    : viewport.classList.contains('theme-dark') ? 'dark' : 'follow';
  if (currentClass === mode) return;

  const style = shadowRoot.getElementById('theme-override');
  // Safety net: if theme CSS failed to load during init, retry once
  if (style && style.textContent.length < 50) {
    loadChatThemeCSS();
  }

  viewport.classList.remove('theme-light', 'theme-dark');
  if (mode === 'light') {
    viewport.classList.add('theme-light');
  } else if (mode === 'dark') {
    viewport.classList.add('theme-dark');
  }

  localStorage.setItem('snapshot-theme', mode);
}

export function getSnapshotTheme() {
  return localStorage.getItem('snapshot-theme') || 'follow';
}

// ------------------------------------------------------------------
// Listen for app events
// ------------------------------------------------------------------
document.addEventListener('theme-toggle', (e) => {
  setSnapshotTheme(e.detail.mode);
});

document.addEventListener('cascade-selected', (e) => {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  currentId = e.detail.id;
  
  // 切换实例时，重置 hash，强制触发内容更新和滚动到底部（最新消息位置）行为
  lastContentHash = '';
  
  applyCascadeStyles(currentId, signal);
  updateContent(currentId, signal);

  // Restore saved theme
  setSnapshotTheme(getSnapshotTheme());
});

document.addEventListener('snapshot-update', (e) => {
  if (e.detail.id === currentId) updateContent(currentId);
});

document.addEventListener('css-update', (e) => {
  if (e.detail.id === currentId) applyCascadeStyles(currentId);
});

// Init on DOM ready
document.addEventListener('DOMContentLoaded', initChatView);
