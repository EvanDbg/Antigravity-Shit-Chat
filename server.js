#!/usr/bin/env node
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';

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
const ANTIGRAVITY_PATH = userConfig.antigravityPath || process.env.ANTIGRAVITY_PATH ||
    join(process.env.LOCALAPPDATA || 'C:\\Users\\EVAN\\AppData\\Local', 'Programs', 'Antigravity', 'Antigravity.exe');

// Application State
let cascades = new Map();
let wss = null;

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
                    snapshotHash: null
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
                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    // console.log(`馃摳 Updated ${c.metadata.chatTitle}`);
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
        active: c.metadata.isActive
    }));
    broadcast({ type: 'cascade_list', cascades: list });
}

// --- Server Setup ---

async function main() {
    const app = express();
    const server = http.createServer(app);
    wss = new WebSocketServer({ server });

    app.use(express.json());

    // --- Auth routes (no auth required) ---
    app.post('/api/login', (req, res) => {
        if (req.body.password === AUTH_PASSWORD) {
            const token = makeToken();
            res.cookie('auth', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
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
    app.post('/api/launch', (req, res) => {
        try {
            const port = req.body.port || 9000;
            const child = spawn(ANTIGRAVITY_PATH, [`--remote-debugging-port=${port}`], {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
            child.unref();
            console.log(`馃殌 Launched Antigravity (PID: ${child.pid}, CDP port: ${port})`);
            res.json({ success: true, pid: child.pid, port });
        } catch (e) {
            console.error('Launch failed:', e.message);
            res.status(500).json({ error: e.message });
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

main();
