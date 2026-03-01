#!/usr/bin/env node
import net from 'net';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import { dirname, join } from 'path';
import { spawn, exec, execSync } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import os from 'os';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load external config
let userConfig = {};
const configPath = join(__dirname, 'config.json');
if (existsSync(configPath)) {
    try {
        userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        console.log('📋 Loaded config from config.json');
    } catch (e) {
        console.warn('⚠️ Failed to parse config.json, using defaults');
    }
}

const PORTS = userConfig.cdpPorts || [9000, 9001, 9002, 9003];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// Auth config (config.json > env vars > defaults)
const AUTH_PASSWORD = userConfig.password || process.env.PASSWORD || 'shitchat';
// Persist AUTH_SECRET so cookies survive server restarts
let AUTH_SECRET = userConfig.authSecret || process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
    AUTH_SECRET = randomBytes(32).toString('hex');
    userConfig.authSecret = AUTH_SECRET;
    try {
        writeFileSync(configPath, JSON.stringify(userConfig, null, 2));
        console.log('🔑 Generated and saved AUTH_SECRET to config.json');
    } catch (e) {
        console.warn('⚠️ Could not persist AUTH_SECRET to config.json');
    }
}
function getDefaultAntigravityPath() {
    if (process.platform === 'darwin') {
        // macOS: standard .app bundle locations
        const candidates = [
            '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
            join(process.env.HOME || '', 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity')
        ];
        return candidates.find(p => existsSync(p)) || candidates[0];
    }
    // Windows
    return join(process.env.LOCALAPPDATA || 'C:\\Users\\EVAN\\AppData\\Local',
        'Programs', 'Antigravity', 'Antigravity.exe');
}

const ANTIGRAVITY_PATH = userConfig.antigravityPath || process.env.ANTIGRAVITY_PATH || getDefaultAntigravityPath();

// Antigravity-Manager config
const MANAGER_URL = userConfig.managerUrl || process.env.MANAGER_URL || 'http://127.0.0.1:8045';
const MANAGER_PASSWORD = userConfig.managerPassword || process.env.MANAGER_PASSWORD || '';

// Application State
let cascades = new Map();
let wss = null;

// --- Web Push Setup ---
let vapidKeys = userConfig.vapidKeys;
if (!vapidKeys) {
    vapidKeys = webpush.generateVAPIDKeys();
    userConfig.vapidKeys = vapidKeys;
    try {
        writeFileSync(configPath, JSON.stringify(userConfig, null, 4));
        console.log('🔑 Generated new VAPID keys and saved to config.json');
    } catch (e) {
        console.warn('⚠️ Could not save VAPID keys to config.json');
    }
}
// VAPID subject: Apple requires a valid mailto: or https: URL (not .local)
const vapidSubject = userConfig.vapidSubject || process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';
webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);
console.log(`🔐 VAPID subject: ${vapidSubject}`);

// Push subscriptions (persisted to file)
const SUBS_PATH = join(__dirname, '.push-subscriptions.json');
let pushSubscriptions = [];
if (existsSync(SUBS_PATH)) {
    try { pushSubscriptions = JSON.parse(readFileSync(SUBS_PATH, 'utf-8')); } catch (e) { }
}
function saveSubs() {
    try { writeFileSync(SUBS_PATH, JSON.stringify(pushSubscriptions)); } catch (e) { }
}

// --- Auth Helpers ---
function makeToken() {
    const payload = Date.now().toString();
    const sig = createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    return payload + '.' + sig;
}

function verifyToken(token) {
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    return sig === expected;
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) cookies[k] = v.join('=');
    });
    return cookies;
}

// --- Helpers ---

function checkPort(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(400);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, '127.0.0.1');
    });
}

function checkProcessRunning(name) {
    return new Promise((resolve) => {
        const cmd = process.platform === 'darwin'
            ? `pgrep -f "${name}.app/" || pgrep -x "${name}"`
            : `tasklist /FI "IMAGENAME eq ${name}.exe" /NH`;
        exec(cmd, (err, stdout) => {
            if (err) return resolve(false);
            if (process.platform === 'win32') {
                resolve(stdout.toLowerCase().includes(name.toLowerCase()));
            } else {
                resolve(stdout.trim().length > 0);
            }
        });
    });
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } // return empty on parse error
            });
        });
        req.on('error', () => resolve([])); // return empty on network error
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

// --- CDP Logic ---

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    // 统一管理所有 pending 的 CDP 呼叫
    const pendingCalls = new Map();
    let idCounter = 1;

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        pendingCalls.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            // 处理 CDP 指令响应
            if (data.id && pendingCalls.has(data.id)) {
                const { resolve, reject } = pendingCalls.get(data.id);
                pendingCalls.delete(data.id);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
            // 处理上下文挂载/销毁广播
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 500)); // give time for contexts to load

    return { ws, call, contexts, rootContextId: null };
}

async function extractMetadata(cdp) {
    const SCRIPT = `(() => {
        // Support both legacy #cascade and new iframe-based #chat/#conversation
        const cascade = document.getElementById('cascade');
        const chat = document.getElementById('chat');
        const conversation = document.getElementById('conversation');
        if (!cascade && !chat && !conversation) return { found: false };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]', '[class*="Title"]'];
        for (const sel of possibleTitleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 2 && el.textContent.length < 80) {
                chatTitle = el.textContent.trim();
                break;
            }
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus(),
            mode: cascade ? 'cascade' : 'iframe'
        };
    })()`;

    // Try finding context first if not known
    if (cdp.rootContextId) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
        } catch (e) { cdp.rootContextId = null; } // reset if stale
    }

    // Search all contexts (including iframe contexts)
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: ctx.id });
            if (result.result?.value?.found) {
                return { ...result.result.value, contextId: ctx.id };
            }
        } catch (e) { }
    }
    return null;
}

async function captureCSS(cdp) {
    const SCRIPT = `(async () => {
        // Gather CSS and namespace it to prevent leaks
        let css = '';
        function namespaceRule(text) {
            // Replace body/html/:root/:host selectors with #chat-viewport
            text = text.replace(/(^|[\\s,}])body(?=[\\s,{:.])/gi, '$1#chat-viewport');
            text = text.replace(/(^|[\\s,}])html(?=[\\s,{:.])/gi, '$1#chat-viewport');
            text = text.replace(/(^|[\\s,}]):root(?=[\\s,{])/gi, '$1#chat-viewport');
            text = text.replace(/(^|[\\s,}]):host(?=[\\s,{(])/gi, '$1#chat-viewport');
            return text;
        }
        for (const sheet of document.styleSheets) {
            try {
                // Try direct access first (same-origin)
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Skip @font-face rules to reduce CSS size
                    if (text.startsWith('@font-face')) continue;
                    css += namespaceRule(text) + '\\n';
                }
            } catch (e) {
                // Cross-origin sheet — fetch it manually
                if (sheet.href) {
                    try {
                        const resp = await fetch(sheet.href);
                        if (resp.ok) {
                            let text = await resp.text();
                            css += namespaceRule(text) + '\\n';
                        }
                    } catch (fetchErr) { /* skip if fetch fails too */ }
                }
            }
        }
        return { css };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId,
            awaitPromise: true
        });
        return result.result?.value?.css || '';
    } catch (e) { return ''; }
}

// --- Capture Computed CSS Variables ---
async function captureComputedVars(cdp) {
    const SCRIPT = `(() => {
        const cs = getComputedStyle(document.documentElement);
        const vars = {};
        // Extract key vscode CSS variables that control theming
        const keys = [
            '--vscode-editor-background', '--vscode-editor-foreground',
            '--vscode-sideBar-background', '--vscode-panel-background',
            '--vscode-input-background', '--vscode-input-foreground',
            '--vscode-input-border', '--vscode-focusBorder',
            '--vscode-button-background', '--vscode-button-foreground',
            '--vscode-list-activeSelectionBackground', '--vscode-list-activeSelectionForeground',
            '--vscode-list-hoverBackground', '--vscode-list-hoverForeground',
            '--vscode-errorForeground', '--vscode-foreground',
            '--vscode-descriptionForeground', '--vscode-textLink-foreground',
            '--vscode-badge-background', '--vscode-badge-foreground',
            '--vscode-checkbox-background', '--vscode-checkbox-border',
            '--vscode-notifications-border', '--vscode-banner-background',
            '--vscode-font-family', '--vscode-font-size', '--vscode-font-weight',
            '--vscode-editor-font-family', '--vscode-editor-font-size',
            // --- UI Separators & Borders ---
            '--vscode-panel-border', '--vscode-editorGroup-border', 
            '--vscode-widget-border', '--vscode-sash-hoverBorder',
            '--vscode-sideBarSectionHeader-border', '--vscode-chat-requestBorder',
            '--vscode-settings-focusedRowBorder', '--vscode-activityBar-border',
            '--vscode-menu-border', '--vscode-titleBar-border',
            // IDE-specific button & UI variables (set programmatically by Antigravity)
            '--ide-button-background', '--ide-button-foreground', '--ide-button-color',
            '--ide-button-hover-background', '--ide-button-secondary-background',
            '--ide-button-secondary-hover-background', '--ide-button-secondary-color',
            '--ide-chat-background', '--ide-editor-background',
            '--ide-text-color', '--ide-link-color', '--ide-message-block-bot-color',
            '--ide-task-section-background',
        ];
        for (const key of keys) {
            const val = cs.getPropertyValue(key).trim();
            if (val) vars[key] = val;
        }
        // Broad scan: capture ALL custom properties from stylesheets and inline styles
        const allProps = new Set();
        // From stylesheets (:root / :host rules)
        Array.from(document.styleSheets).forEach(sheet => {
            try {
                Array.from(sheet.cssRules).forEach(r => {
                    if (r.selectorText === ':root' || r.selectorText === ':host') {
                        Array.from(r.style || []).filter(p => p.startsWith('--')).forEach(p => allProps.add(p));
                    }
                });
            } catch(e) {}
        });
        // From document.documentElement inline style (programmatically set vars)
        const rootStyle = document.documentElement.style;
        for (let i = 0; i < rootStyle.length; i++) {
            const prop = rootStyle[i];
            if (prop.startsWith('--')) allProps.add(prop);
        }
        for (const prop of allProps) {
            if (!vars[prop]) {
                const val = cs.getPropertyValue(prop).trim();
                if (val) vars[prop] = val;
            }
        }
        // Capture body computed background & color as fallback
        const bodyCom = getComputedStyle(document.body);
        vars['__bodyBg'] = bodyCom.backgroundColor;
        vars['__bodyColor'] = bodyCom.color;
        vars['__bodyFontFamily'] = bodyCom.fontFamily;
        return vars;
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return {};

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId
        });
        return result.result?.value || {};
    } catch (e) { return {}; }
}

// --- Quota Extraction ---
const EXTRACT_QUOTA_SCRIPT = `(() => {
    const el = document.getElementById('wusimpl.antigravity-quota-watcher');
    if (!el) return null;
    const anchor = el.querySelector('a');
    if (!anchor) return null;
    const statusText = anchor.textContent?.trim() || '';
    const ariaLabel = el.getAttribute('aria-label') || anchor.getAttribute('aria-label') || '';
    if (!ariaLabel) return { statusText, models: [], planName: null };
    const lines = ariaLabel.split('\\n');
    const models = [];
    let planName = null;
    for (const line of lines) {
        const planMatch = line.match(/\\(([^)]+)\\)\\s*$/);
        if (planMatch && !planName) planName = planMatch[1];
        if (line.startsWith('|') && !line.includes(':---') && !line.includes('模型') && !line.includes('Model')) {
            const cells = line.split('|').map(c => c.trim()).filter(c => c);
            if (cells.length >= 2) {
                const label = cells[0].replace(/^[🟢🟡🔴⚫\\s]+/, '').trim();
                const remainingStr = cells[1].trim();
                const resetTime = (cells[2] || '').trim();
                const pctMatch = remainingStr.match(/([\\d.]+)%/);
                const percentage = pctMatch ? parseFloat(pctMatch[1]) : null;
                if (label) models.push({ label, percentage, resetTime });
            }
        }
    }
    return { statusText, planName, models };
})()`;

async function extractQuotaInfo(cdp) {
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: EXTRACT_QUOTA_SCRIPT,
            returnByValue: true
        });
        return result.result?.value || null;
    } catch (e) { return null; }
}

async function captureHTML(cdp) {
    const SCRIPT = `(() => {
        // Build a unique CSS selector path for a given element
        function buildSelector(el) {
            const parts = [];
            let current = el;
            while (current && current !== document.body && current !== document.documentElement) {
                let selector = current.tagName.toLowerCase();
                if (current.id) {
                    selector = '#' + CSS.escape(current.id);
                    parts.unshift(selector);
                    break; // ID is unique enough
                }
                const parent = current.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                    if (siblings.length > 1) {
                        const idx = siblings.indexOf(current) + 1;
                        selector += ':nth-of-type(' + idx + ')';
                    }
                }
                parts.unshift(selector);
                current = parent;
            }
            return parts.join(' > ');
        }

        // Support both legacy #cascade and new iframe-based #conversation/#chat
        const target = document.getElementById('cascade') 
            || document.getElementById('conversation') 
            || document.getElementById('chat');
        if (!target) return { error: 'chat container not found' };
        
        // Annotate clickable elements for click passthrough
        const clickSelector = 'button, a, [role="button"], [class*="cursor-pointer"], [role="menuitem"], [role="option"], [role="tab"], [role="combobox"], [class*="backdrop"], [class*="overlay"]';
        const liveClickables = Array.from(target.querySelectorAll(clickSelector));
        const selectorMap = {};
        liveClickables.forEach((el, i) => {
            selectorMap[i] = buildSelector(el);
        });

        const clone = target.cloneNode(true);

        // Fix overflow clipping: remove classes that clip content in web context
        clone.querySelectorAll('[class]').forEach(el => {
            const cls = el.className;
            if (typeof cls === 'string' && (cls.includes('overflow-y-hidden') || cls.includes('overflow-x-clip') || cls.includes('overflow-hidden'))) {
                el.className = cls
                    .replace(/\boverflow-y-hidden\b/g, 'overflow-y-visible')
                    .replace(/\boverflow-x-clip\b/g, '')
                    .replace(/\boverflow-hidden\b/g, 'overflow-visible');
            }
        });

        // Tag clone elements with matching indexes
        const cloneClickables = Array.from(clone.querySelectorAll(clickSelector));
        // File extension pattern for detection
        const fileExtPattern = /\b([\w.-]+\.(?:md|txt|js|ts|jsx|tsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|xml|sh|bash|sql|rb|php|swift|kt|scala|r|lua|pl|ex|exs|hs|ml|vue|svelte))\b/i;
        cloneClickables.forEach((el, i) => {
            if (i < liveClickables.length) el.setAttribute('data-cdp-click', i);
            // Detect file links by text content matching file patterns
            const text = (el.textContent || '').trim();
            const match = text.match(fileExtPattern);
            if (match) {
                el.setAttribute('data-file-name', match[1]);
            }
        });

        // Remove input box to keep snapshot clean
        const editor = clone.querySelector('[contenteditable="true"]');
        if (editor) {
            const editorContainer = editor.closest('div[class*="relative"]') || editor.parentElement;
            if (editorContainer && editorContainer !== clone) editorContainer.remove();
        }
        
        const bodyStyles = window.getComputedStyle(document.body);

        // Detect AI completion feedback buttons by their unique data-tooltip-id attributes
        const feedbackUp = target.querySelector('[data-tooltip-id^="up-"]');
        const feedbackDown = target.querySelector('[data-tooltip-id^="down-"]');
        const hasFeedbackButtons = !!(feedbackUp && feedbackDown);

        // Extract fingerprint: use feedback button's data-tooltip-id (contains React unique ID per message)
        let feedbackFingerprint = null;
        if (hasFeedbackButtons) {
            feedbackFingerprint = feedbackUp.getAttribute('data-tooltip-id') || null;
        }

        return {
            html: clone.outerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color,
            clickMap: selectorMap,
            hasFeedbackButtons,
            feedbackFingerprint
        };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) { }

    // Retry once: refresh context and try again
    try {
        const meta = await extractMetadata(cdp);
        if (meta?.contextId && meta.contextId !== contextId) {
            cdp.rootContextId = meta.contextId;
            const result = await cdp.call("Runtime.evaluate", {
                expression: SCRIPT,
                returnByValue: true,
                contextId: meta.contextId
            });
            if (result.result?.value && typeof result.result.value === 'string') {
                return { html: result.result.value };
            }
        }
    } catch (e) { }
    return null;
}

// --- Main App Logic ---

async function discover() {
    // 1. Find all targets
    const allTargets = [];
    await Promise.all(PORTS.map(async (port) => {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        const workbenches = list.filter(t => t.url?.includes('workbench.html') || t.title?.includes('workbench'));
        workbenches.forEach(t => allTargets.push({ ...t, port }));
    }));

    const newCascades = new Map();

    // 2. Connect/Refresh
    for (const target of allTargets) {
        const id = hashString(target.webSocketDebuggerUrl);

        // Reuse existing
        if (cascades.has(id)) {
            const existing = cascades.get(id);
            if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                // Refresh metadata
                const meta = await extractMetadata(existing.cdp);
                if (meta) {
                    existing.metadata = { ...existing.metadata, ...meta };
                    if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
                    newCascades.set(id, existing);
                    continue;
                }
            }
        }

        // New connection
        try {
            console.log(`🔌 Connecting to ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const meta = await extractMetadata(cdp);

            if (meta) {
                if (meta.contextId) cdp.rootContextId = meta.contextId;
                const cascade = {
                    id,
                    cdp,
                    metadata: {
                        windowTitle: target.title,
                        chatTitle: meta.chatTitle,
                        isActive: meta.isActive
                    },
                    snapshot: null,
                    css: await captureCSS(cdp),
                    computedVars: await captureComputedVars(cdp),
                    cssHash: null,
                    cssRefreshCounter: 0,
                    snapshotHash: null,
                    quota: null,
                    quotaHash: null,
                    stableCount: 0,
                    lastFeedbackFingerprint: null
                };
                newCascades.set(id, cascade);
                console.log(`✅ Added cascade: ${meta.chatTitle}`);
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            // console.error(`Failed to connect to ${target.title}: ${e.message}`);
        }
    }

    // 3. Cleanup old
    for (const [id, c] of cascades.entries()) {
        if (!newCascades.has(id)) {
            console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
            try { c.cdp.ws.close(); } catch (e) { }
        }
    }

    const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
    cascades = newCascades;

    if (changed) broadcastCascadeList();
}

async function updateSnapshots() {
    // Parallel updates
    await Promise.all(Array.from(cascades.values()).map(async (c) => {
        try {
            const snap = await captureHTML(c.cdp); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    const oldLen = c.contentLength || 0;
                    const newLen = snap.html.length;
                    const lenDiff = Math.abs(newLen - oldLen);

                    // Protect against empty/short snapshots overwriting good content
                    if (newLen < 200 && oldLen > 500) {
                        console.warn(`⚠️ Skipping short snapshot (${newLen} chars) for "${c.metadata.chatTitle}" (keeping ${oldLen} chars)`);
                        c.stableCount = (c.stableCount || 0) + 1;
                    } else {
                        c.snapshot = snap;
                        c.snapshotHash = hash;
                        c.contentLength = newLen;
                        c.stableCount = 0;

                        broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    }
                } else {
                    c.stableCount = (c.stableCount || 0) + 1;
                }
            }
        } catch (e) { }

        // AI completion detection: fingerprint-based dedup
        // Only notify when feedback buttons appear AND the fingerprint changed
        if (c.snapshot?.hasFeedbackButtons && c.snapshot.feedbackFingerprint) {
            const fp = c.snapshot.feedbackFingerprint;
            if (fp !== c.lastFeedbackFingerprint) {
                c.lastFeedbackFingerprint = fp;
                console.log(`🔔 New AI completion for "${c.metadata.chatTitle}" (fp: ${fp}) — sending notification`);
                broadcast({ type: 'ai_complete', cascadeId: c.id, title: c.metadata.chatTitle });
                sendPushNotification(c);
            }
        }

        // Quota polling
        try {
            const quota = await extractQuotaInfo(c.cdp);
            if (quota) {
                const qHash = hashString(JSON.stringify(quota));
                if (qHash !== c.quotaHash) {
                    c.quota = quota;
                    c.quotaHash = qHash;
                    broadcast({ type: 'quota_update', cascadeId: c.id, quota });
                }
            }
        } catch (e) { }

        // Periodic CSS refresh: every 10 polls (~30s)
        c.cssRefreshCounter = (c.cssRefreshCounter || 0) + 1;
        if (c.cssRefreshCounter >= 10) {
            c.cssRefreshCounter = 0;
            try {
                const newCss = await captureCSS(c.cdp);
                const newVars = await captureComputedVars(c.cdp);
                let changed = false;
                if (newCss && newCss !== c.css) {
                    c.css = newCss;
                    changed = true;
                }
                if (newVars && JSON.stringify(newVars) !== JSON.stringify(c.computedVars)) {
                    c.computedVars = newVars;
                    changed = true;
                }
                if (changed) broadcast({ type: 'css_update', cascadeId: c.id });
            } catch (e) { }
        }
    }));
}

function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    });
}

function broadcastCascadeList() {
    const list = Array.from(cascades.values()).map(c => ({
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        active: c.metadata.isActive,
        quota: c.quota || null
    }));
    broadcast({ type: 'cascade_list', cascades: list });
}

// --- Server Setup ---

async function main() {
    const app = express();
    app.set('trust proxy', true);
    const server = http.createServer(app);
    wss = new WebSocketServer({ server });

    app.use(express.json());

    // --- Auth routes (no auth required) ---
    app.post('/api/login', (req, res) => {
        if (req.body.password === AUTH_PASSWORD) {
            const token = makeToken();
            const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
            res.cookie('auth', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: isSecure });
            res.json({ success: true });
        } else {
            res.status(401).json({ error: 'Wrong password' });
        }
    });

    // Serve login page without auth
    app.get('/login.html', (req, res) => {
        res.sendFile(join(__dirname, 'public', 'login.html'));
    });

    // Auth middleware —protects everything else
    app.use((req, res, next) => {
        const cookies = parseCookies(req.headers.cookie);
        if (verifyToken(cookies.auth)) return next();
        // API requests get 401
        if (req.path.startsWith('/api/') || req.path.startsWith('/cascades') ||
            req.path.startsWith('/snapshot') || req.path.startsWith('/styles') ||
            req.path.startsWith('/send') || req.path.startsWith('/click') ||
            req.path.startsWith('/new-conversation')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        // Page requests get redirected
        res.redirect('/login.html');
    });

    app.use(express.static(join(__dirname, 'public')));

    // --- Launch Antigravity ---
    app.post('/api/launch', async (req, res) => {
        try {
            const port = req.body.port || 9000;
            const portOpen = await checkPort(port);

            console.log(`🔍 Status: port=${portOpen ? 'open' : 'closed'}`);

            // Port already open → already connected, nothing to do
            if (portOpen) {
                return res.json({ success: true, port, message: 'Already connected' });
            }

            // Port not open → kill any existing Antigravity, then launch fresh with debug port
            const processRunning = await checkProcessRunning('Antigravity');
            if (processRunning) {
                console.log('🛑 Killing existing Antigravity (no debug port)...');
                const killCmd = process.platform === 'darwin'
                    ? 'osascript -e \'quit app "Antigravity"\' 2>/dev/null; sleep 1; pkill -f "Antigravity.app/" 2>/dev/null || true'
                    : 'taskkill /IM Antigravity.exe /F 2>nul || echo done';
                await new Promise((resolve) => {
                    exec(killCmd, () => resolve());
                });
                await new Promise(r => setTimeout(r, 1500)); // Wait for process to fully exit
            }

            console.log(`🚀 Launching Antigravity on port ${port}...`);

            let child;
            if (process.platform === 'darwin') {
                child = spawn('open', ['-a', 'Antigravity', '--args', `--remote-debugging-port=${port}`], {
                    detached: true,
                    stdio: 'ignore'
                });
            } else {
                child = spawn(ANTIGRAVITY_PATH, [`--remote-debugging-port=${port}`], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false
                });
            }
            if (child) child.unref();

            // Wait for port to open (app startup takes a few seconds)
            let attempts = 15;
            while (attempts-- > 0) {
                await new Promise(r => setTimeout(r, 1000));
                if (await checkPort(port)) {
                    console.log(`🔥 Antigravity port ${port} is now open! (PID: ${child?.pid})`);
                    return res.json({ success: true, pid: child?.pid, port });
                }
            }

            res.json({ success: false, error: 'TIMEOUT' });

        } catch (e) {
            console.error('Launch failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Kill All Antigravity ---
    app.post('/api/kill-all', async (req, res) => {
        try {
            console.log('🛑 Kill-all requested: closing all Antigravity instances...');

            // 1. Close all CDP WebSocket connections
            let closedCount = 0;
            for (const [id, c] of cascades.entries()) {
                try {
                    c.cdp.ws.close();
                    closedCount++;
                } catch (e) { }
            }
            cascades.clear();
            broadcastCascadeList(); // Notify frontend immediately

            // 2. Kill OS processes
            const killCmd = process.platform === 'darwin'
                ? 'osascript -e \'quit app "Antigravity"\' 2>/dev/null; sleep 1; pkill -f "Antigravity.app/" 2>/dev/null || true'
                : 'taskkill /IM Antigravity.exe /F 2>nul || echo done';

            await new Promise((resolve) => {
                exec(killCmd, (err, stdout, stderr) => {
                    if (err) console.warn('Kill command warning:', err.message);
                    resolve();
                });
            });

            // 3. Wait a moment and verify
            await new Promise(r => setTimeout(r, 1000));
            const stillRunning = await checkProcessRunning('Antigravity');

            console.log(`🛑 Kill-all complete: ${closedCount} CDP connections closed, process ${stillRunning ? 'still running' : 'stopped'}`);
            res.json({
                success: !stillRunning,
                closedConnections: closedCount,
                processKilled: !stillRunning
            });
        } catch (e) {
            console.error('Kill-all failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Close Single Cascade ---
    app.post('/api/close-cascade/:id', async (req, res) => {
        const { id } = req.params;
        const cascade = cascades.get(id);
        if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

        try {
            console.log(`🔴 Closing cascade: "${cascade.metadata.chatTitle}" (${id})`);

            // Send window.close() via CDP to close the Electron window
            try {
                await cascade.cdp.call('Runtime.evaluate', {
                    expression: 'window.close()',
                    contextId: cascade.cdp.rootContextId
                });
            } catch (e) { /* window may already be closing */ }

            // Close CDP WebSocket connection
            try { cascade.cdp.ws.close(); } catch (e) { }

            // Remove from cascades map
            cascades.delete(id);
            broadcastCascadeList();

            console.log(`🔴 Cascade closed: ${id}`);
            res.json({ success: true, closedId: id });
        } catch (e) {
            console.error('Close cascade failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Project Browser APIs ---

    // Get starting directory (parent of current workspace)
    app.get('/api/workspace-root', (req, res) => {
        try {
            // Try to extract workspace path from connected cascades' windowTitle
            for (const c of cascades.values()) {
                const title = c.metadata.windowTitle || '';
                // windowTitle format varies: "file.ext — ProjectName" or contains path info
                // Try to find a path-like segment
                const parts = title.split(' — ');
                if (parts.length >= 2) {
                    const projectName = parts[parts.length - 1].replace(/\s*\[.*\]\s*$/, '').trim();
                    // Check common workspace locations
                    const candidates = [
                        join(os.homedir(), 'Documents', projectName),
                        join(os.homedir(), 'Projects', projectName),
                        join(os.homedir(), 'Desktop', projectName),
                        join(os.homedir(), projectName),
                    ];
                    for (const candidate of candidates) {
                        if (existsSync(candidate)) {
                            const parent = path.dirname(candidate);
                            return res.json({ root: parent, source: 'cascade', projectName });
                        }
                    }
                }
            }
            // Fallback: home directory
            res.json({ root: os.homedir(), source: 'fallback' });
        } catch (e) {
            res.json({ root: os.homedir(), source: 'error' });
        }
    });

    // Browse directories
    app.get('/api/browse', (req, res) => {
        try {
            const targetPath = path.resolve(req.query.path || os.homedir());

            // Security: block sensitive system directories
            const blocked = process.platform === 'darwin'
                ? ['/System', '/private', '/sbin', '/usr/sbin']
                : ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
            if (blocked.some(b => targetPath.startsWith(b))) {
                return res.status(403).json({ error: 'Access to system directories is restricted' });
            }

            if (!existsSync(targetPath)) {
                return res.status(404).json({ error: 'Directory not found' });
            }

            const entries = readdirSync(targetPath, { withFileTypes: true });
            const folders = entries
                .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => ({
                    name: e.name,
                    path: join(targetPath, e.name)
                }));

            const parentPath = path.dirname(targetPath);
            res.json({
                currentPath: targetPath,
                parentPath: parentPath !== targetPath ? parentPath : null,
                items: folders
            });
        } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM') {
                return res.status(403).json({ error: 'Permission denied' });
            }
            res.status(500).json({ error: e.message });
        }
    });

    // Open a project folder in a new Antigravity window
    app.post('/api/open-project', async (req, res) => {
        const { folder } = req.body;
        if (!folder) return res.status(400).json({ error: 'folder is required' });

        if (!existsSync(folder)) {
            return res.status(404).json({ error: 'Folder not found' });
        }

        try {
            const alreadyRunning = await checkProcessRunning('Antigravity');
            console.log(`📂 Open project: "${folder}" (Antigravity ${alreadyRunning ? 'running' : 'cold start'})`);

            let child;
            if (alreadyRunning) {
                // Already running → open folder in a new window
                // Strategy: try CLI tool first, then CDP, then `open -n -a` fallback
                let opened = false;
                let method = 'none';

                // 1. Try the `antigravity` CLI tool (most reliable, like `code` for VS Code)
                try {
                    child = spawn('antigravity', [folder, '--new-window'], {
                        detached: true, stdio: 'ignore',
                        env: { ...process.env }
                    });
                    child.on('error', () => { }); // suppress
                    child.unref();
                    opened = true;
                    method = 'cli';
                    console.log(`✅ Opened via 'antigravity' CLI`);
                } catch (e) {
                    console.warn('⚠️ antigravity CLI failed:', e.message);
                }

                // 2. Fallback: CDP spawn from within Electron renderer
                if (!opened && cascades.size > 0) {
                    const anyCascade = cascades.values().next().value;
                    const escapedFolder = JSON.stringify(folder);
                    try {
                        for (const ctx of (anyCascade.cdp.contexts || [])) {
                            try {
                                const r = await anyCascade.cdp.call('Runtime.evaluate', {
                                    expression: `(() => {
                                        try {
                                            const cp = require('child_process');
                                            cp.spawn('antigravity', [${escapedFolder}, '--new-window'], {
                                                detached: true, stdio: 'ignore'
                                            }).unref();
                                            return { ok: true };
                                        } catch(e) { return { ok: false, error: e.message }; }
                                    })()`,
                                    returnByValue: true,
                                    contextId: ctx.id
                                });
                                if (r.result?.value?.ok) {
                                    opened = true;
                                    method = 'cdp';
                                    console.log(`✅ CDP open-project succeeded via context ${ctx.id}`);
                                    break;
                                }
                            } catch (e) { continue; }
                        }
                    } catch (e) {
                        console.warn('⚠️ CDP open-project failed:', e.message);
                    }
                }

                // 3. Last resort: macOS `open` with -n (force new instance)
                if (!opened && process.platform === 'darwin') {
                    try {
                        child = spawn('open', ['-n', '-a', 'Antigravity', '--args', folder], {
                            detached: true, stdio: 'ignore'
                        });
                        child.on('error', () => { });
                        child.unref();
                        opened = true;
                        method = 'open-n';
                        console.log(`✅ Opened via 'open -n -a Antigravity'`);
                    } catch (e) {
                        console.error('❌ All open methods failed:', e.message);
                    }
                }

                return res.json({ success: opened, alreadyRunning: true, method });
            } else {
                // Cold start → use port 9000
                const port = 9000;
                if (process.platform === 'darwin') {
                    child = spawn('open', ['-a', 'Antigravity', '--args', folder, `--remote-debugging-port=${port}`], {
                        detached: true, stdio: 'ignore'
                    });
                } else {
                    child = spawn(ANTIGRAVITY_PATH, [folder, `--remote-debugging-port=${port}`], {
                        detached: true, stdio: 'ignore', windowsHide: false
                    });
                }
                if (child) child.unref();

                // Wait for port to open
                let attempts = 15;
                while (attempts-- > 0) {
                    await new Promise(r => setTimeout(r, 1000));
                    if (await checkPort(port)) {
                        console.log(`🔥 Antigravity port ${port} is now open!`);
                        return res.json({ success: true, alreadyRunning: false, port });
                    }
                }
                res.json({ success: false, error: 'TIMEOUT' });
            }
        } catch (e) {
            console.error('Open project failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Antigravity-Manager Proxy ---
    const managerHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MANAGER_PASSWORD}`,
        'x-api-key': MANAGER_PASSWORD
    });

    app.get('/api/manager/accounts', async (req, res) => {
        if (!MANAGER_PASSWORD) return res.status(501).json({ error: 'Manager not configured' });
        try {
            const resp = await fetch(`${MANAGER_URL}/api/accounts`, { headers: managerHeaders() });
            if (!resp.ok) return res.status(resp.status).json({ error: `Manager returned ${resp.status}` });
            res.json(await resp.json());
        } catch (e) {
            console.error('Manager accounts error:', e.message);
            res.status(502).json({ error: 'Cannot reach Antigravity-Manager' });
        }
    });

    app.get('/api/manager/current', async (req, res) => {
        if (!MANAGER_PASSWORD) return res.status(501).json({ error: 'Manager not configured' });
        try {
            const resp = await fetch(`${MANAGER_URL}/api/accounts/current`, { headers: managerHeaders() });
            if (!resp.ok) return res.status(resp.status).json({ error: `Manager returned ${resp.status}` });
            res.json(await resp.json());
        } catch (e) {
            res.status(502).json({ error: 'Cannot reach Antigravity-Manager' });
        }
    });

    app.post('/api/manager/switch', async (req, res) => {
        if (!MANAGER_PASSWORD) return res.status(501).json({ error: 'Manager not configured' });
        const { accountId } = req.body;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        try {
            const resp = await fetch(`${MANAGER_URL}/api/accounts/switch`, {
                method: 'POST',
                headers: managerHeaders(),
                body: JSON.stringify({ accountId })
            });
            if (!resp.ok) return res.status(resp.status).json({ error: `Manager returned ${resp.status}` });
            // Verify switch
            const currentResp = await fetch(`${MANAGER_URL}/api/accounts/current`, { headers: managerHeaders() });
            const current = await currentResp.json();
            console.log(`🔄 Account switched to: ${current.email}`);
            res.json({ success: true, current });
        } catch (e) {
            console.error('Manager switch error:', e.message);
            res.status(502).json({ error: 'Cannot reach Antigravity-Manager' });
        }
    });

    // API Routes
    app.get('/cascades', (req, res) => {
        res.json(Array.from(cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            active: c.metadata.isActive
        })));
    });

    app.get('/snapshot/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c || !c.snapshot) return res.status(404).json({ error: 'Not found' });
        res.json(c.snapshot);
    });

    app.get('/api/quota/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json(c.quota || { statusText: '', planName: null, models: [] });
    });

    // --- Active Tab Name API (lightweight, for before/after click detection) ---
    app.get('/api/active-tab-name/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        try {
            const allContexts = c.cdp.contexts || [];
            for (const ctx of allContexts) {
                try {
                    const r = await c.cdp.call('Runtime.evaluate', {
                        expression: `(() => {
                            const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                            return tab ? tab.getAttribute('data-resource-name') : null;
                        })()`,
                        returnByValue: true,
                        contextId: ctx.id
                    });
                    if (r.result?.value) {
                        return res.json({ name: r.result.value });
                    }
                } catch (e) { continue; }
            }
            res.json({ name: null });
        } catch (e) {
            res.json({ name: null });
        }
    });

    // --- Active File API (reads from Editor's active tab via CDP) ---
    app.get('/api/active-file/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        try {
            // Step 1: Find the main window context (not the chat iframe)
            // rootContextId is the chat iframe context — tabs live in the main window
            const allContexts = c.cdp.contexts || [];
            let tabInfo = null;
            let mainContextId = null;

            for (const ctx of allContexts) {
                try {
                    const r = await c.cdp.call('Runtime.evaluate', {
                        expression: `(() => {
                            const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                            if (!tab) return null;
                            const name = tab.getAttribute('data-resource-name') || '';
                            const iconLabel = tab.querySelector('.monaco-icon-label');
                            const ariaLabel = iconLabel?.getAttribute('aria-label') || '';
                            const labelDesc = tab.querySelector('.label-description')?.textContent?.trim() || '';
                            // title attribute often contains the full absolute path
                            const tabTitle = tab.getAttribute('title') || '';
                            const iconTitle = iconLabel?.getAttribute('title') || '';
                            // Also check the label-name element
                            const labelName = tab.querySelector('.label-name')?.getAttribute('title') || '';
                            return { name, ariaLabel, labelDesc, tabTitle, iconTitle, labelName };
                        })()`,
                        returnByValue: true,
                        contextId: ctx.id
                    });
                    if (r.result?.value) {
                        tabInfo = r.result.value;
                        mainContextId = ctx.id;
                        break;
                    }
                } catch (e) { continue; }
            }

            if (!tabInfo) {
                return res.status(404).json({ error: 'No active editor tab found' });
            }

            // Step 2: Check if it's a system artifact (.resolved file)
            if (tabInfo.name.endsWith('.resolved')) {
                // Extract rendered HTML from artifact-view (also in the main context)
                const htmlResult = await c.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                        const content = document.querySelector('.artifact-view .leading-relaxed.select-text');
                        if (!content) return null;
                        return content.innerHTML;
                    })()`,
                    returnByValue: true,
                    contextId: mainContextId
                });
                const html = htmlResult.result?.value;
                if (!html) {
                    return res.status(404).json({ error: 'Could not extract artifact content' });
                }
                const artifactType = tabInfo.name.replace('.md.resolved', '').replace(/_/g, ' ');
                const capitalizedType = artifactType.charAt(0).toUpperCase() + artifactType.slice(1);
                return res.json({
                    type: 'artifact',
                    name: `${capitalizedType}: ${tabInfo.labelDesc}`,
                    html
                });
            }

            // Step 3: Normal file — resolve full path and read content
            console.log(`🔍 [file-preview] Raw tabInfo:`, JSON.stringify(tabInfo));

            // Clean up ariaLabel
            let filePath = (tabInfo.ariaLabel || '')
                .replace(/\s•\s.*$/, '')           // strip " • Modified/Untracked" etc.
                .replace(/\s*\(preview[^)]*\)/, '') // strip "(preview ◎)"
                .trim();

            console.log(`🔍 [file-preview] ariaLabel path: "${filePath}"`);

            // If ariaLabel only has filename (no path separator), try hover tooltip
            if (filePath && !filePath.includes('/') && !filePath.includes('~')) {
                console.log(`🔍 [file-preview] ariaLabel has no path, trying hover tooltip...`);
                try {
                    // Step A: Dismiss all existing hover widgets first
                    await c.cdp.call('Runtime.evaluate', {
                        expression: `(() => {
                            document.querySelectorAll('.monaco-hover, .workbench-hover').forEach(h => {
                                h.style.display = 'none';
                            });
                        })()`,
                        contextId: mainContextId
                    });
                    // Move mouse to neutral position to clear hovers
                    await c.cdp.call('Input.dispatchMouseEvent', {
                        type: 'mouseMoved', x: 0, y: 0
                    });
                    await new Promise(r => setTimeout(r, 300));

                    // Step B: Get tab position and hover on it
                    const posResult = await c.cdp.call('Runtime.evaluate', {
                        expression: `(() => {
                            const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                            if (!tab) return null;
                            const rect = tab.getBoundingClientRect();
                            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                        })()`,
                        returnByValue: true,
                        contextId: mainContextId
                    });
                    const pos = posResult.result?.value;
                    if (pos) {
                        await c.cdp.call('Input.dispatchMouseEvent', {
                            type: 'mouseMoved', x: pos.x, y: pos.y
                        });
                        // Wait for tab tooltip to appear
                        await new Promise(r => setTimeout(r, 1000));

                        // Step C: Find the VISIBLE tooltip that contains a path
                        const tooltipResult = await c.cdp.call('Runtime.evaluate', {
                            expression: `(() => {
                                // Look for all hover containers, find one with a path-like string
                                const hovers = document.querySelectorAll(
                                    '.workbench-hover-container, .monaco-hover'
                                );
                                for (const h of hovers) {
                                    const style = getComputedStyle(h);
                                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                                    const text = h.textContent?.trim() || '';
                                    // Tab tooltip contains ~ or / path, filter out code hovers
                                    if (text.includes('/') || text.startsWith('~')) {
                                        return text;
                                    }
                                }
                                return null;
                            })()`,
                            returnByValue: true,
                            contextId: mainContextId
                        });
                        const tooltipText = tooltipResult.result?.value;
                        if (tooltipText) {
                            const cleanedTooltip = tooltipText
                                .replace(/\s•\s.*$/, '')
                                .replace(/\s*\(preview[^)]*\)/, '')
                                .trim();
                            console.log(`🔍 [file-preview] Tooltip path: "${cleanedTooltip}"`);
                            if (cleanedTooltip.includes('/') || cleanedTooltip.startsWith('~')) {
                                filePath = cleanedTooltip;
                            }
                        } else {
                            console.log(`🔍 [file-preview] No path-like tooltip found`);
                        }

                        // Step D: Dismiss tooltip
                        await c.cdp.call('Input.dispatchMouseEvent', {
                            type: 'mouseMoved', x: 0, y: 0
                        });
                    }
                } catch (e) {
                    console.log(`🔍 [file-preview] Hover tooltip failed:`, e.message);
                }
            }

            if (!filePath) {
                return res.status(404).json({ error: 'No file path in active tab' });
            }
            // Expand ~ to home directory
            if (filePath.startsWith('~')) {
                filePath = filePath.replace('~', os.homedir());
            }

            console.log(`📂 [file-preview] Resolved path: "${filePath}"`);

            try {
                const stat = statSync(filePath);
                if (stat.size > 1024 * 1024) {
                    return res.status(413).json({ error: 'File too large (>1MB)' });
                }
                const content = readFileSync(filePath, 'utf-8');
                const ext = path.extname(filePath).toLowerCase().slice(1);
                const filename = path.basename(filePath);
                res.json({ type: 'file', content, filename, ext, path: filePath });
            } catch (e) {
                console.error(`❌ [file-preview] Read failed: ${e.code} — "${filePath}"`);
                if (e.code === 'ENOENT') return res.status(404).json({ error: `File not found: ${filePath}` });
                res.status(500).json({ error: e.message });
            }
        } catch (e) {
            console.error('Active file error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Close Active Tab API (sync file close from web UI to IDE) ---
    app.post('/api/close-tab/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        try {
            // Safety: check how many editor tabs are open before closing
            // If 0 tabs, skip (nothing to close). Otherwise send Cmd+W.
            const allContexts = c.cdp.contexts || [];
            let tabCount = 0;
            for (const ctx of allContexts) {
                try {
                    const r = await c.cdp.call('Runtime.evaluate', {
                        expression: `document.querySelectorAll('.tab[data-resource-name]').length`,
                        returnByValue: true,
                        contextId: ctx.id
                    });
                    if (r.result?.value !== undefined && r.result.value > 0) {
                        tabCount = r.result.value;
                        break;
                    }
                } catch (e) { continue; }
            }

            if (tabCount === 0) {
                console.log(`📋 Skip close-tab: no editor tabs open`);
                return res.json({ success: false, skipped: true, reason: 'no tabs open' });
            }

            // Tabs exist — send Cmd+W / Ctrl+W to close the active one
            const modifier = process.platform === 'darwin' ? 4 : 2; // 4=Meta(Cmd), 2=Ctrl

            await c.cdp.call('Input.dispatchKeyEvent', {
                type: 'keyDown',
                modifiers: modifier,
                windowsVirtualKeyCode: 87, // W
                key: 'w',
                code: 'KeyW'
            });
            await c.cdp.call('Input.dispatchKeyEvent', {
                type: 'keyUp',
                modifiers: modifier,
                windowsVirtualKeyCode: 87,
                key: 'w',
                code: 'KeyW'
            });

            console.log(`📋 Close tab forwarded for "${c.metadata.chatTitle}" (${tabCount} tabs open)`);
            res.json({ success: true });
        } catch (e) {
            console.error('Close tab error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Push Notification Routes ---
    app.get('/api/push/vapid-key', (req, res) => {
        res.json({ publicKey: vapidKeys.publicKey });
    });

    app.post('/api/push/subscribe', (req, res) => {
        const sub = req.body;
        if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
        if (!pushSubscriptions.find(s => s.endpoint === sub.endpoint)) {
            pushSubscriptions.push(sub);
            saveSubs();
            console.log(`🔔 Push subscription added (total: ${pushSubscriptions.length})`);
        }
        res.json({ success: true });
    });

    app.post('/api/push/unsubscribe', (req, res) => {
        const { endpoint } = req.body;
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
        saveSubs();
        console.log(`🔕 Push subscription removed (total: ${pushSubscriptions.length})`);
        res.json({ success: true });
    });

    app.get('/styles/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json({ css: c.css || '', computedVars: c.computedVars || {} });
    });

    // Alias for simple single-view clients (returns first active or first available)
    app.get('/snapshot', (req, res) => {
        const active = Array.from(cascades.values()).find(c => c.metadata.isActive) || cascades.values().next().value;
        if (!active || !active.snapshot) return res.status(503).json({ error: 'No snapshot' });
        res.json(active.snapshot);
    });

    app.post('/send/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        // Re-using the injection logic logic would be long, 
        // but let's assume valid injection for brevity in this single-file request:
        // We'll trust the previous logic worked, just pointing it to c.cdp

        // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
        // For now, let's just log it to prove flow works
        console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
        // TODO: Port the full injection script back in if needed, 
        // but user asked for "update" which implies features, I'll assume I should include it.
        // See helper below.

        const result = await injectMessage(c.cdp, req.body.message);
        if (result.ok) res.json({ success: true });
        else res.status(500).json(result);
    });

    // Click passthrough: forward a click to the IDE via CDP (pure click, no snapshot)
    app.post('/click/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const idx = req.body.index;
        const selector = c.snapshot?.clickMap?.[idx];
        if (!selector) return res.status(400).json({ error: 'Invalid click index' });

        try {
            // Step 1: Scroll element into view
            const scrollResult = await c.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                  try {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return { ok: false, reason: 'element not found: ' + ${JSON.stringify(selector)} };
                    el.scrollIntoView({ block: 'center', behavior: 'instant' });
                    return { ok: true };
                  } catch (e) {
                    return { ok: false, reason: 'JS Eval Exception: ' + e.message };
                  }
                })()`,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            if (!scrollResult.result?.value?.ok) {
                return res.status(500).json({ error: scrollResult.result?.value?.reason || 'scroll failed' });
            }

            // Step 2: Wait for scroll to settle
            await new Promise(resolve => setTimeout(resolve, 50));

            // Step 3: Re-read coordinates after scroll
            const locateResult = await c.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                  try {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return { ok: false, reason: 'element not found after scroll' };
                    const rect = el.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    const text = (el.textContent || '').substring(0, 200).trim();
                    let filePath = null;
                    const href = el.getAttribute('href') || '';
                    if (href.startsWith('file://')) {
                        filePath = decodeURIComponent(href.replace('file://', ''));
                    }
                    const dataUri = el.getAttribute('data-href') || el.closest('[data-href]')?.getAttribute('data-href') || '';
                    if (!filePath && dataUri.startsWith('file://')) {
                        filePath = decodeURIComponent(dataUri.replace('file://', ''));
                    }
                    return { ok: true, text, filePath, cx, cy };
                  } catch (e) {
                    return { ok: false, reason: 'JS Eval Exception: ' + e.message };
                  }
                })()`,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            const val = locateResult.result?.value;
            if (!val?.ok) {
                return res.status(500).json({ error: val?.reason || 'locate failed' });
            }

            // Step 4: Use CDP Input.dispatchMouseEvent for real browser-level click
            const { cx, cy } = val;
            await c.cdp.call('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1
            });
            await c.cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1
            });

            console.log(`🖱️ Click forwarded: "${val.text}"${val.filePath ? ` (file: ${val.filePath})` : ''}`);
            res.json({ success: true, text: val.text, filePath: val.filePath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Popup extraction: click button → wait for popup → extract items → Escape close → return JSON
    app.post('/popup/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const idx = req.body.index;
        const selector = c.snapshot?.clickMap?.[idx];
        if (!selector) return res.status(400).json({ error: 'Invalid click index' });

        try {
            // Helper: snapshot signatures of currently visible dialogs and listboxes
            const snapshotVisibleDialogs = async () => {
                const r = await c.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                      const sigs = [];
                      document.querySelectorAll('[role="dialog"], [role="listbox"]').forEach(el => {
                        const style = window.getComputedStyle(el);
                        if (style.visibility === 'visible' && style.display !== 'none' && style.opacity !== '0') {
                          sigs.push((el.textContent || '').substring(0, 80).trim());
                        }
                      });
                      return sigs;
                    })()`,
                    returnByValue: true,
                    contextId: c.cdp.rootContextId
                });
                return r.result?.value || [];
            };

            // Helper: scroll element into view and get coordinates for CDP click
            const clickTrigger = async () => {
                // First: scroll into view and get coordinates
                const locateResult = await c.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                      const el = document.querySelector(${JSON.stringify(selector)});
                      if (!el) return { ok: false };
                      el.scrollIntoView({ block: 'center', behavior: 'instant' });
                      const rect = el.getBoundingClientRect();
                      return { ok: true, text: (el.textContent || '').substring(0, 100).trim(), cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                    })()`,
                    returnByValue: true,
                    contextId: c.cdp.rootContextId
                });
                const val = locateResult.result?.value;
                if (!val?.ok) return locateResult;
                
                // Small delay for scroll to settle
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Re-read position after scroll  
                const posResult = await c.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                      const el = document.querySelector(${JSON.stringify(selector)});
                      if (!el) return { ok: false };
                      const rect = el.getBoundingClientRect();
                      return { ok: true, text: (el.textContent || '').substring(0, 100).trim(), cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                    })()`,
                    returnByValue: true,
                    contextId: c.cdp.rootContextId
                });
                const pos = posResult.result?.value;
                if (!pos?.ok) return posResult;
                
                // CDP native mouse click
                await c.cdp.call('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: pos.cx, y: pos.cy, button: 'left', clickCount: 1
                });
                await c.cdp.call('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: pos.cx, y: pos.cy, button: 'left', clickCount: 1
                });
                
                return { result: { value: pos } };
            };

            // Helper: send Escape to close IDE popup (prevents snapshot corruption)
            const sendEscape = async () => {
                try {
                    await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
                    await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
                } catch (_) {}
            };

            const doExtract = async (beforeSigs) => {
                return c.cdp.call('Runtime.evaluate', {
                    expression: `((beforeSigs) => {
                      let items = [];
                      
                      // Search both dialog and listbox containers
                      const containers = document.querySelectorAll('[role="dialog"], [role="listbox"]');
                      let targetDialog = null;
                      let isListbox = false;
                      
                      for (const dialog of containers) {
                        const style = window.getComputedStyle(dialog);
                        if (style.visibility === 'hidden') continue;
                        if (style.display === 'none') continue;
                        if (style.pointerEvents === 'none') continue;
                        
                        const sig = (dialog.textContent || '').substring(0, 80).trim();
                        if (beforeSigs.some(bs => bs === sig)) continue;
                        
                        const role = dialog.getAttribute('role');
                        if (role === 'listbox') {
                          // HeadlessUI listbox — always has [role=option] children
                          if (dialog.querySelector('[role="option"]')) {
                            targetDialog = dialog;
                            isListbox = true;
                            break;
                          }
                        } else {
                          // Dialog — check for interactive children
                          const hasInteractive = dialog.querySelector(
                            'div[class*="cursor-pointer"], div[class*="hover:"], [role="option"], [role="menuitem"]'
                          );
                          if (!hasInteractive) continue;
                          targetDialog = dialog;
                          break;
                        }
                      }
                      
                      if (!targetDialog) return { items: [], found: false };
                      
                      // Shared helper: build a CSS selector path from a DOM node
                      const buildPath = (node) => {
                        const parts = [];
                        while (node && node !== document.body) {
                          const parent = node.parentElement;
                          if (!parent) break;
                          const siblings = Array.from(parent.children);
                          const index = siblings.indexOf(node) + 1;
                          const tag = node.tagName.toLowerCase();
                          parts.unshift(tag + ':nth-child(' + index + ')');
                          node = parent;
                        }
                        return 'body > ' + parts.join(' > ');
                      };
                      
                      // Fast path for HeadlessUI Listbox containers
                      if (isListbox) {
                        const options = targetDialog.querySelectorAll('[role="option"]');
                        for (const opt of options) {
                          const text = (opt.textContent || '').trim();
                          if (!text || text.length > 100) continue;
                          const isSelected = opt.getAttribute('aria-selected') === 'true' ||
                                             opt.getAttribute('data-headlessui-state')?.includes('selected');
                          items.push({
                            title: text,
                            description: '',
                            badges: [],
                            header: '',
                            selector: opt.id ? '#' + opt.id : buildPath(opt),
                            checked: isSelected
                          });
                        }
                        return { items, found: true };
                      }
                      
                      let header = '';
                      const headerEl = targetDialog.querySelector('.text-xs.opacity-80, .text-xs.pb-1');
                      if (headerEl) header = (headerEl.textContent || '').trim();
                      
                      const candidates = targetDialog.querySelectorAll(
                        'div[class*="cursor-pointer"], div[class*="hover:"], button, ' +
                        '[role="option"], [role="menuitem"], li'
                      );
                      
                      const allTexts = new Set();
                      
                      for (const el of candidates) {
                        const fullText = (el.textContent || '').trim();
                        if (!fullText || fullText.length > 200 || allTexts.has(fullText)) continue;
                        
                        const childCandidates = el.querySelectorAll(
                          'div[class*="cursor-pointer"], div[class*="hover:"], button'
                        );
                        if (childCandidates.length > 0) continue;
                        
                        allTexts.add(fullText);
                        
                        let title = '';
                        let description = '';
                        const badges = [];
                        
                        const titleEl = el.querySelector('.font-medium, .font-semibold, .font-bold');
                        const descEl = el.querySelector('.opacity-50, .opacity-60, .text-muted');
                        
                        if (titleEl) {
                          title = (titleEl.textContent || '').trim();
                          if (descEl) description = (descEl.textContent || '').trim();
                        } else {
                          title = fullText;
                        }
                        
                        if (!title) continue;
                        
                        el.querySelectorAll('.text-xs').forEach(badge => {
                          const bt = (badge.textContent || '').trim();
                          if (bt.toLowerCase() === 'new') badges.push(bt);
                        });
                        
                        const itemSelector = el.id ? '#' + el.id : buildPath(el);
                        
                        items.push({
                          title, description, badges, header: header || '',
                          selector: itemSelector,
                          checked: el.getAttribute('aria-checked') === 'true' || 
                                   el.classList.contains('checked') ||
                                   el.classList.contains('selected')
                        });
                      }
                      
                      return { items, found: true };
                    })(${JSON.stringify(beforeSigs)})`,
                    returnByValue: true,
                    contextId: c.cdp.rootContextId
                });
            };

            // Step 1: Snapshot visible dialogs BEFORE click
            const beforeSigs = await snapshotVisibleDialogs();

            // Step 2: Click trigger to toggle the popup
            const clickResult = await clickTrigger();
            if (!clickResult.result?.value?.ok) {
                return res.status(500).json({ error: 'Failed to click trigger element' });
            }
            console.log(`🎯 Popup trigger clicked: "${clickResult.result.value.text}"`);

            // Step 3: Wait for popup to render
            await new Promise(resolve => setTimeout(resolve, 350));

            // Step 4: Extract items from NEWLY visible dialog
            let extractResult = await doExtract(beforeSigs);
            let popupData = extractResult.result?.value || { items: [] };

            // Step 5: If 0 items, click likely CLOSED the popup (toggle off)
            // Take fresh snapshot → click again to reopen → extract
            if (popupData.items.length === 0) {
                console.log(`🔄 Popup toggle retry (0 items, clicking again to reopen)`);
                const freshSigs = await snapshotVisibleDialogs();
                await clickTrigger();
                await new Promise(resolve => setTimeout(resolve, 350));
                extractResult = await doExtract(freshSigs);
                popupData = extractResult.result?.value || { items: [] };
            }

            // Step 6: Leave the popup OPEN (popup-click will click the option directly)
            // The Escape will be sent by popup-click after selection, or by dismiss route

            console.log(`📋 Popup extracted: ${popupData.items.length} items`);
            res.json(popupData);

        } catch (e) {
            // Close popup on extraction error
            try {
                await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
                await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
            } catch (_) {}
            res.status(500).json({ error: e.message });
        }
    });

    // Popup item click: directly click a visible option in the already-open popup
    app.post('/popup-click/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'No title provided' });

        try {
            // Find the visible option by text and click it
            const locateResult = await c.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                  const targetText = ${JSON.stringify(title)};
                  
                  // Find the visible popup container (dialog or listbox)
                  // Iterate from LAST to FIRST — newly opened popups are appended at the end
                  const containers = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"]'));
                  let activeContainer = null;
                  let bestContainer = null; // container whose text contains the target
                  
                  for (let i = containers.length - 1; i >= 0; i--) {
                    const c = containers[i];
                    const style = window.getComputedStyle(c);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    if (c.getBoundingClientRect().height === 0) continue;
                    
                    // Prefer the container whose text includes the target
                    if (!bestContainer && (c.textContent || '').includes(targetText)) {
                      bestContainer = c;
                    }
                    if (!activeContainer) activeContainer = c; // last visible = most recently opened
                  }
                  
                  activeContainer = bestContainer || activeContainer;
                  
                  if (!activeContainer) {
                    return { ok: false, reason: 'no visible container', optCount: 0, optTexts: [] };
                  }
                  
                  const role = activeContainer.getAttribute('role');
                  
                  // Search within the container based on type
                  if (role === 'listbox') {
                    // HeadlessUI listbox — search [role=option] within
                    const options = activeContainer.querySelectorAll('[role="option"]');
                    for (const opt of options) {
                      const t = (opt.textContent || '').trim();
                      if (t === targetText) {
                        const rect = opt.getBoundingClientRect();
                        if (rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight) {
                          return { ok: true, text: t, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                        }
                      }
                    }
                    return { ok: false, optCount: options.length, optTexts: Array.from(options).slice(0, 5).map(o => (o.textContent||'').trim().substring(0,30)) };
                  }
                  
                  // Dialog — search interactive items within
                  const candidates = activeContainer.querySelectorAll(
                    'div[class*="cursor-pointer"], div[class*="hover:"], button, ' +
                    '[role="option"], [role="menuitem"], li'
                  );
                  for (const item of candidates) {
                    const t = (item.textContent || '').trim();
                    if (t === targetText) {
                      const rect = item.getBoundingClientRect();
                      if (rect.height > 0) {
                        return { ok: true, text: t, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
                      }
                    }
                  }
                  
                  // Fallback: partial text match within the dialog
                  for (const item of candidates) {
                    const t = (item.textContent || '').trim();
                    if (t.includes(targetText) || targetText.includes(t)) {
                      const rect = item.getBoundingClientRect();
                      if (rect.height > 0 && t.length < 200) {
                        return { ok: true, text: t, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, partial: true };
                      }
                    }
                  }
                  
                  return { ok: false, optCount: candidates.length, optTexts: Array.from(candidates).slice(0, 5).map(o => (o.textContent||'').trim().substring(0,30)) };
                })()`,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            const val = locateResult.result?.value;
            
            if (!val?.ok) {
                console.log(`❌ Popup option not found: "${title}" (${val?.optCount || 0} options: ${JSON.stringify(val?.optTexts || [])})`);
                // Send Escape to close the dangling popup
                try {
                    await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
                    await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
                } catch (_) {}
                return res.status(500).json({ error: 'option not found', debug: val });
            }

            // CDP native mouse click on the option
            const { cx, cy } = val;
            await c.cdp.call('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1
            });
            await c.cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1
            });

            console.log(`✅ Popup item clicked: "${val.text}"`);
            res.json({ success: true, text: val.text });
        } catch (e) {
            // Clean up on error
            try {
                await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
                await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
            } catch (_) {}
            res.status(500).json({ error: e.message });
        }
    });

    // Dismiss passthrough: forward an Escape keypress to dismiss IDE popups (no snapshot)
    app.post('/dismiss/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        try {
            await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
            await c.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Scroll passthrough: forward scroll events to IDE chat container
    app.post('/scroll/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const { deltaY, ratio, scrollTop } = req.body;
        if (deltaY === undefined && ratio === undefined && scrollTop === undefined) {
            return res.status(400).json({ error: 'deltaY, ratio or scrollTop required' });
        }

        try {
            // Use scrollTop for exact absolute positioning, ratio as fallback, deltaY for relative
            // Use limits to prevent mobile rubber-banding/clamping bugs from crashing Monaco's viewport calculations
            let scrollExpr = '';
            if (scrollTop !== undefined) {
                scrollExpr = `
                    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, ${scrollTop}));
                `;
            } else if (ratio !== undefined) {
                scrollExpr = `
                    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                    scrollEl.scrollTop = Math.max(0, Math.min(1, ${ratio})) * maxScroll;
                `;
            } else {
                scrollExpr = `
                    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
                    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, scrollEl.scrollTop + ${deltaY}));
                `;
            }

            const result = await c.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const target = document.getElementById('cascade') || document.getElementById('conversation') || document.getElementById('chat');
                    if (!target) return { error: 'no target' };
                    function findScrollable(el, depth) {
                        if (depth > 8) return null;
                        if (el.classList && (el.classList.contains('monaco-scrollable-element') || el.classList.contains('monaco-list'))) {
                            return el;
                        }
                        const s = getComputedStyle(el);
                        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
                        for (const ch of el.children) { const f = findScrollable(ch, depth + 1); if (f) return f; }
                        return null;
                    }
                    const scrollEl = findScrollable(target, 0);
                    if (!scrollEl) return { error: 'no scrollable element' };
                    
                    // 伪造真实的人为滑动方向滚轮事件，以强制打断 IDE 的自动追踪底部（auto-scroll）机制
                    // 原先的粗暴 scrollTop 赋值会被 React 或内置的虚拟列表当成系统调整而予以无视，继续顽强地跳回最底端
                    const beforeScroll = scrollEl.scrollTop;
                    ${scrollExpr};
                    const diffY = scrollEl.scrollTop - beforeScroll;
                    
                    // 只有真正在后端产生了滚动落差，才去唤醒底层的脱锁逻辑
                    if (diffY !== 0) {
                        // 【死锁修复】切忌直接派发巨额 diffY，否则内置的独立滚动侦听器（比如 React Virtuoso）
                        // 会将其作为连续滑动动能直接叠加在其自己的内部 State 里，导致在刚赋予了新 scrollTop 后
                        // 又爆冲出去并在之后的 Snapshot 里跳动回来产生抖屏！只给 1 像素的打断暗示即可。
                        // ⚠️ 已知限制: new WheelEvent 的 isTrusted 始终为 false，若未来 VSCode 版本严格校验此属性则需替代方案。
                        scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(diffY) * 1, bubbles: true }));
                    }

                    // Dispatch scroll event to wake up Monaco's virtual list rendering
                    scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
                    scrollEl.dispatchEvent(new CustomEvent('scroll', { bubbles: true }));
                    
                    // Short delay to let React/Monaco process the scroll event and patch the DOM
                    return new Promise(resolve => {
                        setTimeout(() => resolve({
                            scrollTop: scrollEl.scrollTop,
                            scrollHeight: scrollEl.scrollHeight,
                            clientHeight: scrollEl.clientHeight
                        }), 150);
                    });
                })()`,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            const val = result.result?.value;
            if (val?.error) return res.status(500).json({ error: val.error });

            // Wait for lazy loading to trigger, then refresh snapshot
            setTimeout(async () => {
                try {
                    const snap = await captureHTML(c.cdp);
                    if (snap && snap.html.length > 200) {
                        const hash = hashString(snap.html);
                        if (hash !== c.snapshotHash) {
                            c.snapshot = snap;
                            c.snapshotHash = hash;
                            c.contentLength = snap.html.length;
                            broadcast({ type: 'snapshot_update', cascadeId: c.id });
                        }
                    }
                } catch (e) { }
            }, 300);

            res.json({ success: true, ...val });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/new-conversation/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        try {
            const result = await c.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const btn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
                    if (btn) { btn.click(); return { ok: true }; }
                    return { ok: false, reason: 'new-conversation button not found' };
                })()`,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            const val = result.result?.value;
            if (val?.ok) {
                console.log('🎉 New conversation created');
                res.json({ success: true });
            } else {
                res.status(500).json({ error: val?.reason || 'failed' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    // WebSocket auth check
    wss.on('connection', (ws, req) => {
        const cookies = parseCookies(req.headers.cookie);
        if (!verifyToken(cookies.auth)) {
            ws.close(4001, 'Unauthorized');
            return;
        }
        broadcastCascadeList(); // Send list on connect
    });

    const PORT = userConfig.port || process.env.PORT || 3563;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp, text) {
    const SCRIPT = `(async () => {
        const text = ${JSON.stringify(text)};
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, text);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, text);
        }
        
        await new Promise(r => setTimeout(r, 200));
        
        // Try to find the send button — multiple strategies for different Antigravity versions
        // 1. Latest Antigravity: uses a div with data-tooltip-id containing "send"
        const sendDiv = document.querySelector('[data-tooltip-id*="send"]:not([data-tooltip-id*="cancel"])');
        // 2. Legacy Antigravity: button-based selectors
        const sendBtn = document.querySelector('button[class*="arrow"]') || 
                       document.querySelector('button[aria-label*="Send"]') ||
                       document.querySelector('button[type="submit"]');

        if (sendDiv) {
            sendDiv.click();
            return { ok: true, method: "tooltip-div" };
        } else if (sendBtn) {
            sendBtn.click();
            return { ok: true, method: "button" };
        } else {
            // Fallback: dispatch Enter key with full event properties
            const enterEvent = new KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                composed: true
            });
            editor.dispatchEvent(enterEvent);
            return { ok: true, method: "enter-key" };
        }
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            awaitPromise: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || { ok: false };
    } catch (e) { return { ok: false, reason: e.message }; }
}

// Push notification sender
async function sendPushNotification(cascade) {
    if (pushSubscriptions.length === 0) return;

    const payload = JSON.stringify({
        title: `⚡ SIGNAL :: ${cascade.metadata.chatTitle}`,
        body: '「Neural link complete」— AI transmission received',
        cascadeId: cascade.id
    });

    console.log(`📤 Sending push to ${pushSubscriptions.length} subscriber(s) for "${cascade.metadata.chatTitle}"`);

    const results = await Promise.allSettled(
        pushSubscriptions.map(sub => webpush.sendNotification(sub, payload))
    );

    // Log each result for debugging
    const failed = [];
    results.forEach((r, i) => {
        const endpoint = pushSubscriptions[i]?.endpoint || 'unknown';
        const shortEndpoint = endpoint.substring(0, 60) + '...';
        if (r.status === 'fulfilled') {
            console.log(`  ✅ [${i}] ${shortEndpoint} → HTTP ${r.value?.statusCode || 'OK'}`);
        } else {
            const code = r.reason?.statusCode || 'N/A';
            const body = r.reason?.body || r.reason?.message || 'unknown error';
            console.error(`  ❌ [${i}] ${shortEndpoint} → HTTP ${code}: ${body}`);
            if (code === 410 || code === 404) {
                failed.push(endpoint);
            }
        }
    });

    if (failed.length) {
        pushSubscriptions = pushSubscriptions.filter(s => !failed.includes(s.endpoint));
        saveSubs();
        console.log(`🧹 Cleaned up ${failed.length} expired push subscription(s)`);
    }
}

main();
