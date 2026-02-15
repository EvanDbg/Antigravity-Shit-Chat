#!/usr/bin/env node
import net from 'net';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, exec } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load external config
let userConfig = {};
const configPath = join(__dirname, 'config.json');
if (existsSync(configPath)) {
    try {
        userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        console.log('馃搵 Loaded config from config.json');
    } catch (e) {
        console.warn('鈿狅笍 Failed to parse config.json, using defaults');
    }
}

const PORTS = userConfig.cdpPorts || [9000, 9001, 9002, 9003];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// Auth config (config.json > env vars > defaults)
const AUTH_PASSWORD = userConfig.password || process.env.PASSWORD || 'shitchat';
const AUTH_SECRET = process.env.AUTH_SECRET || randomBytes(32).toString('hex');
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
            ? `pgrep -f "${name}.app/Contents/MacOS/${name}"`
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

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
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
    const SCRIPT = `(() => {
        // Gather CSS and namespace it to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with container locator
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#chat-viewport');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#chat-viewport');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        return result.result?.value?.css || '';
    } catch (e) { return ''; }
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
        const clickSelector = 'button, a, [role="button"], [class*="cursor-pointer"]';
        const liveClickables = Array.from(target.querySelectorAll(clickSelector));
        const selectorMap = {};
        liveClickables.forEach((el, i) => {
            selectorMap[i] = buildSelector(el);
        });

        const clone = target.cloneNode(true);
        // Tag clone elements with matching indexes
        const cloneClickables = Array.from(clone.querySelectorAll(clickSelector));
        cloneClickables.forEach((el, i) => {
            if (i < liveClickables.length) el.setAttribute('data-cdp-click', i);
        });

        // Remove input box to keep snapshot clean
        const editor = clone.querySelector('[contenteditable="true"]');
        if (editor) {
            const editorContainer = editor.closest('div[class*="relative"]') || editor.parentElement;
            if (editorContainer && editorContainer !== clone) editorContainer.remove();
        }
        
        const bodyStyles = window.getComputedStyle(document.body);

        return {
            html: clone.outerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color,
            clickMap: selectorMap
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
            console.log(`馃攲 Connecting to ${target.title}`);
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
                    css: await captureCSS(cdp), //only on init bc its huge
                    snapshotHash: null,
                    quota: null,
                    quotaHash: null,
                    stableCount: 0,
                    notified: false
                };
                newCascades.set(id, cascade);
                console.log(`鉁?Added cascade: ${meta.chatTitle}`);
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
            console.log(`馃憢 Removing cascade: ${c.metadata.chatTitle}`);
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

                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    c.contentLength = newLen;
                    c.stableCount = 0;

                    // Only reset notified if content changed significantly (>50 chars)
                    // This filters out trivial changes like timestamps updating
                    if (lenDiff > 50) {
                        c.notified = false;
                    }

                    broadcast({ type: 'snapshot_update', cascadeId: c.id });
                } else {
                    c.stableCount = (c.stableCount || 0) + 1;
                }
            }
        } catch (e) { }

        // AI completion detection: stable for ~9s (3 polls * 3s) after significant changes
        // With 2-minute cooldown to prevent notification spam
        const NOTIFY_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
        const now = Date.now();
        const lastNotif = c.lastNotifiedAt || 0;
        if (c.stableCount === 3 && !c.notified && c.snapshot && (now - lastNotif > NOTIFY_COOLDOWN_MS)) {
            c.notified = true;
            c.lastNotifiedAt = now;
            sendPushNotification(c);
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

    // Auth middleware 鈥?protects everything else
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
            const [portOpen, processRunning] = await Promise.all([
                checkPort(port),
                checkProcessRunning('Antigravity')
            ]);

            console.log(`🔍 Status: process=${processRunning ? 'running' : 'stopped'}, port=${portOpen ? 'open' : 'closed'}`);

            // Case 1: Port already open → already connected, nothing to do
            if (portOpen) {
                return res.json({ success: true, port, message: 'Already connected' });
            }

            // Case 2: Process running but port closed → must restart with debug flags
            if (processRunning) {
                console.warn('⚠️ Antigravity is running but debug port is not open.');
                return res.json({ success: false, error: 'RESTART_REQUIRED' });
            }

            // Case 3: Not running, not listening → fresh launch
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
                ? 'pkill -f "Antigravity.app/Contents/MacOS/Antigravity" || true'
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
        res.json({ css: c.css || '' });
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

    // Click passthrough: forward a click to the IDE via CDP
    app.post('/click/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const idx = req.body.index;
        const selector = c.snapshot?.clickMap?.[idx];
        if (!selector) return res.status(400).json({ error: 'Invalid click index' });

        try {
            const result = await c.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
                    if (!el) return { ok: false, reason: 'element not found' };
                    el.click();
                    return { ok: true, text: el.textContent.substring(0, 50) };
                })()`,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            const val = result.result?.value;
            if (val?.ok) {
                console.log(`馃柋锔?Click forwarded: "${val.text}"`);
                res.json({ success: true, text: val.text });
            } else {
                res.status(500).json({ error: val?.reason || 'click failed' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // New conversation: click the new-conversation button in the cascade panel
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
                console.log('馃啎 New conversation created');
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
        console.log(`馃殌 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp, text) {
    const SCRIPT = `(async () => {
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, "${text.replace(/"/g, '\\"')}");
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${text.replace(/"/g, '\\"')}");
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter" }));
        }
        return { ok: true };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || { ok: false };
    } catch (e) { return { ok: false, reason: e.message }; }
}

// Push notification sender
async function sendPushNotification(cascade) {
    if (pushSubscriptions.length === 0) return;

    const payload = JSON.stringify({
        title: `💬 ${cascade.metadata.chatTitle}`,
        body: 'AI has finished responding',
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
