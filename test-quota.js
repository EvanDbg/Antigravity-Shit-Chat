#!/usr/bin/env node
/**
 * Feasibility test v2: Deep dive into profile-badge and account info.
 */
import http from 'http';
import WebSocket from 'ws';

const PORTS = [9000, 9001, 9002, 9003];

function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(2000, () => { req.destroy(); resolve([]); });
    });
}

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 5000);
    });
    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error('CDP timeout')); }, 8000);
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) { clearTimeout(timeout); ws.off('message', handler); if (data.error) reject(data.error); else resolve(data.result); }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
    const contexts = [];
    ws.on('message', (msg) => {
        try { const d = JSON.parse(msg); if (d.method === 'Runtime.executionContextCreated') contexts.push(d.params.context); } catch (e) { }
    });
    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 800));
    return { ws, call, contexts };
}

// Deep dive into profile-badge and activity bar
const DEEP_SEARCH_SCRIPT = `(() => {
    const result = {};

    // 1. Profile badge - full dump
    const badges = document.querySelectorAll('.profile-badge, .profile-badge-content, [class*="profile"]');
    result.profileBadges = [];
    for (const b of badges) {
        const attrs = {};
        for (const attr of b.attributes) attrs[attr.name] = attr.value?.substring(0, 500);
        result.profileBadges.push({
            tag: b.tagName,
            innerHTML: b.innerHTML?.substring(0, 1000),
            attrs,
            parentId: b.parentElement?.id,
            parentClass: b.parentElement?.className?.toString()?.substring(0, 200),
        });
    }

    // 2. Activity bar account section
    const activityBar = document.querySelector('.activitybar, .activity-bar-items');
    result.activityBar = activityBar ? {
        innerHTML: activityBar.innerHTML?.substring(0, 2000),
    } : null;
    
    // 3. Account action items (gear/settings in bottom of activity bar)
    const globalActions = document.querySelectorAll('.global-activity-actionbar .action-item, .composite-bar .action-item');
    result.globalActions = [];
    for (const a of globalActions) {
        const label = a.querySelector('.codicon, .action-label');
        result.globalActions.push({
            className: a.className?.toString()?.substring(0, 100),
            ariaLabel: a.getAttribute('aria-label') || '',
            title: a.getAttribute('title') || '',
            text: a.textContent?.trim()?.substring(0, 100),
            innerHTML: a.innerHTML?.substring(0, 500),
        });
    }

    // 4. Settings / Accounts sidebar item
    const accountItems = document.querySelectorAll('[id*="account"], [aria-label*="Account"], [aria-label*="account"], [class*="accounts"]');
    result.accountItems = [];
    for (const a of accountItems) {
        result.accountItems.push({
            tag: a.tagName,
            id: a.id,
            ariaLabel: a.getAttribute('aria-label')?.substring(0, 200),
            text: a.textContent?.trim()?.substring(0, 200),
            innerHTML: a.innerHTML?.substring(0, 500),
        });
    }

    // 5. Check for Google auth state in title bar area
    const titlebar = document.querySelector('.titlebar, .titlebar-container');
    result.titlebar = titlebar ? {
        text: titlebar.textContent?.trim()?.substring(0, 500),
    } : null;

    // 6. Look for img elements with user avatars
    const imgs = document.querySelectorAll('img[src*="avatar"], img[src*="profile"], img[src*="googleusercontent"], img[src*="github"]');
    result.avatarImages = [];
    for (const img of imgs) {
        result.avatarImages.push({
            src: img.src?.substring(0, 300),
            alt: img.alt,
            title: img.title,
        });
    }

    // 7. Check localStorage/sessionStorage for account info (may fail due to security)
    result.storage = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (/account|user|email|auth|token|profile|google/i.test(key)) {
                const val = localStorage.getItem(key);
                result.storage[key] = val?.substring(0, 300);
            }
        }
    } catch(e) { result.storage._error = e.message; }

    return result;
})()`;

async function main() {
    console.log('🔍 Deep search for account info...\n');

    for (const port of PORTS) {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        if (!list || list.length === 0) continue;

        const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
        for (const target of pages) {
            if (target.title === 'Launchpad') continue; // Skip launchpad
            try {
                const cdp = await connectCDP(target.webSocketDebuggerUrl);
                for (const ctx of cdp.contexts) {
                    try {
                        const res = await cdp.call("Runtime.evaluate", {
                            expression: DEEP_SEARCH_SCRIPT,
                            returnByValue: true,
                            contextId: ctx.id
                        });
                        const val = res.result?.value;
                        if (!val) continue;

                        // Only report contexts with interesting data
                        const hasData = val.profileBadges?.length > 0 ||
                            val.accountItems?.length > 0 ||
                            val.globalActions?.length > 0 ||
                            Object.keys(val.storage || {}).length > 0;
                        if (!hasData) continue;

                        console.log(`\n========== Context ${ctx.id} ==========`);

                        if (val.profileBadges?.length > 0) {
                            console.log(`\n👤 Profile Badges (${val.profileBadges.length}):`);
                            for (const b of val.profileBadges) {
                                console.log(`  <${b.tag}> attrs=${JSON.stringify(b.attrs)}`);
                                console.log(`    parent: id="${b.parentId}" class="${b.parentClass}"`);
                                console.log(`    innerHTML: ${b.innerHTML}`);
                            }
                        }

                        if (val.globalActions?.length > 0) {
                            console.log(`\n🎯 Global Actions (${val.globalActions.length}):`);
                            for (const a of val.globalActions) {
                                console.log(`  aria="${a.ariaLabel}" title="${a.title}" text="${a.text}"`);
                                console.log(`    html: ${a.innerHTML}`);
                            }
                        }

                        if (val.accountItems?.length > 0) {
                            console.log(`\n🔑 Account Items (${val.accountItems.length}):`);
                            for (const a of val.accountItems) {
                                console.log(`  <${a.tag}> id="${a.id}" aria="${a.ariaLabel}" text="${a.text}"`);
                                console.log(`    html: ${a.innerHTML}`);
                            }
                        }

                        if (val.avatarImages?.length > 0) {
                            console.log(`\n🖼️ Avatar Images:`);
                            for (const img of val.avatarImages) {
                                console.log(`  src="${img.src}" alt="${img.alt}"`);
                            }
                        }

                        if (val.titlebar) {
                            console.log(`\n📋 Titlebar: "${val.titlebar.text?.substring(0, 200)}"`);
                        }

                        if (Object.keys(val.storage || {}).length > 0) {
                            console.log(`\n💾 Storage matches:`);
                            for (const [k, v] of Object.entries(val.storage)) {
                                console.log(`  ${k}: ${v}`);
                            }
                        }

                    } catch (e) { }
                }
                cdp.ws.close();
            } catch (e) { }
        }
    }
    console.log('\n✅ Done');
    process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
