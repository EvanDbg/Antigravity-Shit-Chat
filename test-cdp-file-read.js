#!/usr/bin/env node
/**
 * Test script: Verify reading file content via CDP in Antigravity IDE
 * 
 * Tests multiple approaches to read files through CDP:
 *   1. Node.js require('fs') in the main context
 *   2. globalThis / self in worker contexts  
 *   3. VS Code workspace API
 */

import WebSocket from 'ws';

const CDP_PORT = 9000;
const TEST_FILE = process.argv[2] || '/Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/README.md';

async function getTargets() {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return resp.json();
}

function connectCDP(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();

        ws.on('open', () => {
            const cdp = {
                ws,
                call(method, params = {}) {
                    return new Promise((res, rej) => {
                        const myId = ++id;
                        pending.set(myId, { resolve: res, reject: rej });
                        ws.send(JSON.stringify({ id: myId, method, params }));
                    });
                }
            };
            resolve(cdp);
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id && pending.has(msg.id)) {
                const p = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message));
                else p.resolve(msg.result);
            }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
}

async function testFileRead(cdp, contextId, label) {
    const filePath = TEST_FILE.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    // ========== Approach 1: Node.js require('fs') ==========
    console.log(`\n--- [${label}] Approach 1: require('fs').readFileSync ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                try {
                    const fs = require('fs');
                    const content = fs.readFileSync('${filePath}', 'utf-8');
                    return { ok: true, length: content.length, preview: content.substring(0, 200) };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.ok) {
            console.log(`  ✅ SUCCESS! File length: ${val.length}`);
            console.log(`  Preview: ${val.preview}`);
        } else {
            console.log(`  ❌ Failed: ${val?.error || 'no result'}`);
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== Approach 2: Dynamic import('fs') ==========
    console.log(`\n--- [${label}] Approach 2: import('fs') ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(async () => {
                try {
                    const fs = await import('fs');
                    const content = fs.readFileSync('${filePath}', 'utf-8');
                    return { ok: true, length: content.length, preview: content.substring(0, 200) };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            })()`,
            returnByValue: true,
            awaitPromise: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.ok) {
            console.log(`  ✅ SUCCESS! File length: ${val.length}`);
            console.log(`  Preview: ${val.preview}`);
        } else {
            console.log(`  ❌ Failed: ${val?.error || 'no result'}`);
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== Approach 3: globalThis.__require ==========
    console.log(`\n--- [${label}] Approach 3: globalThis.__require / global.require ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                try {
                    const req = globalThis.__require || globalThis.require || self.require;
                    if (!req) return { ok: false, error: 'no require available' };
                    const fs = req('fs');
                    const content = fs.readFileSync('${filePath}', 'utf-8');
                    return { ok: true, length: content.length, preview: content.substring(0, 200) };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.ok) {
            console.log(`  ✅ SUCCESS! File length: ${val.length}`);
            console.log(`  Preview: ${val.preview}`);
        } else {
            console.log(`  ❌ Failed: ${val?.error || 'no result'}`);
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== Approach 4: fetch with file:// ==========
    console.log(`\n--- [${label}] Approach 4: fetch('file://...') ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(async () => {
                try {
                    const resp = await fetch('file://${filePath}');
                    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
                    const content = await resp.text();
                    return { ok: true, length: content.length, preview: content.substring(0, 200) };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            })()`,
            returnByValue: true,
            awaitPromise: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.ok) {
            console.log(`  ✅ SUCCESS! File length: ${val.length}`);
            console.log(`  Preview: ${val.preview}`);
        } else {
            console.log(`  ❌ Failed: ${val?.error || 'no result'}`);
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== Approach 5: fetch with vscode-file:// ==========  
    console.log(`\n--- [${label}] Approach 5: fetch('vscode-file://vscode-app/...') ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(async () => {
                try {
                    const resp = await fetch('vscode-file://vscode-app${filePath}');
                    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
                    const content = await resp.text();
                    return { ok: true, length: content.length, preview: content.substring(0, 200) };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            })()`,
            returnByValue: true,
            awaitPromise: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.ok) {
            console.log(`  ✅ SUCCESS! File length: ${val.length}`);
            console.log(`  Preview: ${val.preview}`);
        } else {
            console.log(`  ❌ Failed: ${val?.error || 'no result'}`);
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }
}

async function main() {
    console.log('🔍 CDP File Read Test');
    console.log(`📁 Test file: ${TEST_FILE}`);
    console.log(`🔌 CDP port: ${CDP_PORT}`);

    const targets = await getTargets();
    console.log(`\n📋 Found ${targets.length} targets:`);

    const workbenches = targets.filter(t =>
        t.type === 'page' && (t.url?.includes('workbench') || t.title?.includes('workbench'))
    );

    const workers = targets.filter(t => t.type === 'worker');

    for (const target of targets) {
        console.log(`  [${target.type}] ${target.title || '(no title)'} → ${target.url?.substring(0, 80)}`);
    }

    // Test on workbench pages (where the chat UI lives)
    for (const wb of workbenches) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Testing on: ${wb.title}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const cdp = await connectCDP(wb.webSocketDebuggerUrl);

            // Enable Runtime to get execution contexts
            await cdp.call('Runtime.enable');

            // Test in default context (no contextId)
            await testFileRead(cdp, null, 'default');

            cdp.ws.close();
        } catch (e) {
            console.log(`  ❌ Connection failed: ${e.message}`);
        }
    }

    // Also test on worker contexts
    for (const worker of workers.slice(0, 1)) { // Just test first worker
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Testing on worker: ${worker.title || '(unnamed)'}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const cdp = await connectCDP(worker.webSocketDebuggerUrl);
            await cdp.call('Runtime.enable');
            await testFileRead(cdp, null, 'worker');
            cdp.ws.close();
        } catch (e) {
            console.log(`  ❌ Connection failed: ${e.message}`);
        }
    }

    console.log('\n✅ Test complete');
    process.exit(0);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
