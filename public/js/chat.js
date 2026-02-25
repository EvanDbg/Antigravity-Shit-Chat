/**
 * Chat View — Shadow DOM, morphdom, CDP click passthrough, scroll sync
 */
import { escapeHtml } from './utils.js';

let shadowRoot = null;
let currentId = null;
let scrollSyncLock = false;
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

  // Load snapshot adaptation CSS
  loadSnapshotCSS();

  // Event delegation for CDP click passthrough (inside Shadow DOM)
  shadowRoot.addEventListener('click', handleCDPClick);

  // Scroll sync
  const container = document.getElementById('chatContainer');
  if (container) {
    container.addEventListener('scroll', handleScrollSync);
  }
}

// ------------------------------------------------------------------
// Load snapshot.css into Shadow DOM
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

// ------------------------------------------------------------------
// Apply IDE styles (fetched from server)
// ------------------------------------------------------------------
export async function applyCascadeStyles(id) {
  if (!shadowRoot) return;
  try {
    const res = await fetch(`/styles/${id}`);
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
          color: ${editorFg};
          background: ${editorBg};
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
          color: ${editorFg} !important;
        }

        /* Prose typography */
        #chat-viewport .prose, #chat-viewport [class*="prose"] {
          --tw-prose-body: ${editorFg} !important;
          --tw-prose-headings: #f3f4f6 !important;
          --tw-prose-links: ${vars['--vscode-textLink-foreground'] || '#60a5fa'} !important;
          --tw-prose-bold: #f3f4f6 !important;
          --tw-prose-code: #f3f4f6 !important;
          --tw-prose-pre-bg: #1f2937 !important;
          color: ${editorFg} !important;
        }

        /* Code blocks */
        #chat-viewport pre, #chat-viewport code {
          background: #111 !important;
          color: #ddd !important;
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
  } catch (e) {
    console.error('CSS refresh failed:', e);
  }
}

// ------------------------------------------------------------------
// Update content with morphdom diff
// ------------------------------------------------------------------
let lastContentHash = '';

export async function updateContent(id) {
  if (!shadowRoot) return;
  try {
    const res = await fetch(`/snapshot/${id}`);
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
      morphdom(viewport, temp, {
        onBeforeElUpdated: (fromEl, toEl) => {
          if (fromEl.isEqualNode(toEl)) return false;
          // Sync textareas so local state isn't wrongly preserved when IDE state resets
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

    // 恢复 IDE 虚拟列表的超真实全量高度，不能强制缩小，否则会摧毁上下滑动的滚动对位比（ ratio 错位致盲）
    let maxContentBottom = 0;
    viewport.querySelectorAll('.monaco-list-rows').forEach(list => {
      Array.from(list.children).forEach(child => {
        const bottom = child.offsetTop + child.offsetHeight;
        if (bottom > maxContentBottom) maxContentBottom = bottom;
      });
    });

    // 触发滚动补丁：当容器本身就滚动到底部，或者这是第一次加载（此时scrollTop常常为0，但内容定位可能极高导致满屏留白）
    if ((isAtBottom || isInitialLoad) && container) {
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
  } catch (_) { }
}

// ------------------------------------------------------------------
// CDP click passthrough (using composedPath for Shadow DOM)
// ------------------------------------------------------------------
async function handleCDPClick(e) {
  const path = e.composedPath();

  let clickable = null;
  
  for (const el of path) {
    if (el.nodeType !== 1) continue;
    
    const tag = el.tagName.toUpperCase();
    const role = el.getAttribute?.('role') || '';

    // 1. Explicitly blocked elements where native behavior OR selection should dominate
    if (/^(CODE|PRE|TABLE|THEAD|TBODY|TR|TH|TD|SUMMARY|DETAILS|INPUT|SELECT|TEXTAREA)$/.test(tag)) {
      return; 
    }

    // 2. We hit an element mapped to CDP
    if (el.hasAttribute?.('data-cdp-click')) {
      const cls = el.className || '';
      
      // A valid button DIV shouldn't contain heavy block elements like paragraphs, code blocks, or tables
      const isContainerDiv = el.querySelector('p, pre, table, ul, ol, iframe, code');
      
      // Only honor it if it's an actionable UI tag OR it looks like a custom button container
      if (/^(A|BUTTON|SPAN|I|SVG|PATH)$/.test(tag) || 
          /^(button|menuitem|option|combobox|listbox|tab)$/i.test(role) ||
          (tag === 'DIV' && typeof cls === 'string' && /pointer|btn|button|action|clickable|menu|toolbar|select|dropdown|backdrop|overlay|dialog|context-view/i.test(cls) && !isContainerDiv)) {
        clickable = el;
      }
      break; 
    }
  }

  if (!clickable || !currentId) return;

  e.preventDefault();
  e.stopPropagation();

  const idx = clickable.getAttribute('data-cdp-click');
  const hasFileName = clickable.hasAttribute('data-file-name');
  clickable.style.opacity = '0.6';

  try {
    // Close current editor tab
    try {
      const closeRes = await fetch(`/api/close-tab/${currentId}`, { method: 'POST' });
      const closeData = await closeRes.json();
      if (closeData.success) await new Promise(r => setTimeout(r, 300));
    } catch (_) { }

    // Record current tab for non-file elements
    let beforeTab = null;
    if (!hasFileName) {
      const beforeRes = await fetch(`/api/active-tab-name/${currentId}`);
      beforeTab = await beforeRes.json();
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
// Theme override (three-mode)
// ------------------------------------------------------------------
export function setSnapshotTheme(mode) {
  if (!shadowRoot) return;
  const style = shadowRoot.getElementById('theme-override');
  if (!style) return;

  const baseCSS = `
    /* === Base Mobile Resets === */
    #chat-viewport, #chat-viewport * {
      box-sizing: border-box !important;
    }
    #chat-viewport {
      max-width: 100vw;
      overflow-x: hidden;
    }
    #chat-viewport p, #chat-viewport span, #chat-viewport div {
      word-break: break-word;
    }
    #chat-viewport .border, #chat-viewport input, #chat-viewport textarea, #chat-viewport .card, #chat-viewport .message {
      max-width: 100% !important;
    }

    /* Elevate modals/dialogs/menus and their backdrops to the ultimate top */
    #chat-viewport .fixed,
    #chat-viewport [class*="fixed"],
    #chat-viewport [style*="fixed"],
    #chat-viewport .absolute,
    #chat-viewport [class*="absolute"],
    #chat-viewport [style*="position: absolute"] {
      z-index: 100 !important;
    }

    /* Target specific root-level popups for forced centering safely */
    #chat-viewport [role="menu"][style*="absolute"],
    #chat-viewport [role="listbox"][style*="absolute"],
    #chat-viewport [role="dialog"][style*="absolute"],
    #chat-viewport .popover[style*="absolute"],
    #chat-viewport .context-view,
    #chat-viewport [data-radix-popper-content-wrapper],
    #chat-viewport .monaco-menu-container {
      z-index: 9999 !important;
      position: fixed !important;
      top: 50% !important;
      left: 50% !important;
      transform: translate(-50%, -50%) !important;
      max-width: 90vw !important;
      max-height: 90vh !important;
      overflow: auto !important;
      background: var(--vscode-editorWidget-background, #fff) !important;
      border-radius: 8px !important;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2) !important;
    }

    /* Hide IDE internal text input parts to prevent duplicate input bars */
    #chat-viewport .interactive-input-part,
    #chat-viewport .chat-input-part,
    #chat-viewport .monaco-editor.chat-input {
      display: none !important;
    }

    /* Fix headless custom color classes from IDE Tailwind rendering */
    #chat-viewport .bg-ide-chat-background,
    #chat-viewport [class*="bg-ide-chat-background"] {
      background-color: var(--vscode-editorWidget-background, var(--vscode-editor-background, #ffffff)) !important;
    }
  `;

  if (mode === 'light') {
    style.textContent = baseCSS + `
      /* === Light Theme Override === */

      /* 1. Container backgrounds */
      #chat-viewport {
        background: #ffffff !important;
        color: #1f2328 !important;
        --vscode-editorWidget-background: #ffffff;
      }
      #chat-viewport #cascade,
      #chat-viewport #conversation,
      #chat-viewport #chat {
        background: transparent !important;
        color: #1f2328 !important;
      }

      /* 2. Global text-decoration reset — kill IDE underlines */
      #chat-viewport, #chat-viewport * {
        text-decoration: none !important;
      }

      /* 2b. Text color — inherit from parent */
      #chat-viewport p, #chat-viewport span, #chat-viewport div,
      #chat-viewport li, #chat-viewport td, #chat-viewport th,
      #chat-viewport label { color: inherit !important; }
      
      /* Restore background for sticky/fixed headers */
      #chat-viewport .sticky,
      #chat-viewport [class*="sticky"],
      #chat-viewport [style*="sticky"] {
        background-color: var(--bg-primary, #ffffff) !important;
        z-index: 10 !important;
      }

      /* 3. Links — remove underlines, set visible link color */
      #chat-viewport a {
        color: #0969da !important;
        text-decoration: none !important;
      }
      #chat-viewport a:hover {
        text-decoration: underline !important;
      }

      /* 4. Headings — bold, slightly darker, larger */
      #chat-viewport h1, #chat-viewport h2, #chat-viewport h3,
      #chat-viewport h4, #chat-viewport h5, #chat-viewport h6 {
        color: #000000 !important;
        font-weight: 600 !important;
      }

      /* 5. Prose typography */
      #chat-viewport .prose, #chat-viewport [class*="prose"] {
        --tw-prose-body: #1f2328 !important;
        --tw-prose-headings: #000000 !important;
        --tw-prose-bold: #000000 !important;
        --tw-prose-code: #1f2328 !important;
        --tw-prose-pre-bg: #f0f2f5 !important;
        --tw-prose-links: #0969da !important;
        color: #1f2328 !important;
      }

      /* 6. Code blocks — visible background, border, proper contrast */
      #chat-viewport pre {
        background: #f0f2f5 !important;
        color: #1f2328 !important;
        border: 1px solid #d0d4da !important;
        border-radius: 6px !important;
        padding: 12px !important;
      }
      #chat-viewport pre code {
        background: transparent !important;
        color: inherit !important;
        border: none !important;
        padding: 0 !important;
      }
      #chat-viewport code {
        background: #e3e6ea !important;
        color: #1f2328 !important;
        border: 1px solid #d0d4da !important;
        border-radius: 4px !important;
        padding: 1px 5px !important;
        font-size: 0.9em !important;
      }

      /* 7. Tables — visible borders */
      #chat-viewport table {
        border-collapse: collapse !important;
        border: 1px solid #d0d4da !important;
      }
      #chat-viewport th, #chat-viewport td {
        border: 1px solid #d0d4da !important;
        padding: 6px 12px !important;
      }
      #chat-viewport th {
        background: #f0f2f5 !important;
        font-weight: 600 !important;
      }

      /* 8. Borders, dividers, separators — match IDE visual structure */
      #chat-viewport hr {
        border-color: #d0d4da !important;
      }
      /* Override IDE border CSS variables for light visibility */
      #chat-viewport {
        --vscode-panel-border: #e0e3e8;
        --vscode-widget-border: #e0e3e8;
        --vscode-editorGroup-border: #e0e3e8;
        --vscode-sideBar-border: #e0e3e8;
        --vscode-contrastBorder: #e0e3e8;
        --vscode-editorWidget-border: #e0e3e8;
        --vscode-input-border: #e0e3e8;
        --vscode-focusBorder: #0969da;
      }
      /* Override dark-theme border colors to be visible on light background and ensure structural borders are drawn */
      #chat-viewport .border:not(button):not([role="button"]):not(a):not(code):not(pre) {
        border-width: 1px !important;
        border-style: solid !important;
        border-color: #e0e3e8 !important;
      }

      /* 9. Badges, special tags — keep slightly tinted bg */
      #chat-viewport [class*="badge"],
      #chat-viewport [class*="tag"],
      #chat-viewport [class*="chip"] {
        background: #e8ebef !important;
        color: #1f2328 !important;
        border: 1px solid #d0d4da !important;
      }

      /* 10. SVG icons — ensure visibility */
      #chat-viewport svg {
        color: inherit !important;
      }

      /* 11. Wide content — allow horizontal scrolling */
      #chat-viewport pre,
      #chat-viewport table {
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch !important;
      }
    `;
  } else if (mode === 'dark') {
    style.textContent = baseCSS + `
      #chat-viewport { 
        background: #0f0f0f !important; 
        color: #e5e5e5 !important; 
        --vscode-editorWidget-background: #0f0f0f;
      }
      #chat-viewport p, #chat-viewport span, #chat-viewport div,
      #chat-viewport li, #chat-viewport h1, #chat-viewport h2,
      #chat-viewport h3, #chat-viewport a { color: inherit !important; }
    `;
  } else {
    // 'follow' — let IDE theme drive colors BUT apply mobile resets
    style.textContent = baseCSS;
  }

  localStorage.setItem('snapshot-theme', mode);
}

export function getSnapshotTheme() {
  return localStorage.getItem('snapshot-theme') || 'follow';
}

// ------------------------------------------------------------------
// Listen for app events
// ------------------------------------------------------------------
document.addEventListener('cascade-selected', (e) => {
  currentId = e.detail.id;
  applyCascadeStyles(currentId);
  updateContent(currentId);

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
