#!/usr/bin/env node
/**
 * Test script: Inspect active tab's DOM to find file path sources
 * Explores all attributes, tooltip, custom properties, and VS Code APIs
 */

import WebSocket from 'ws';

const CDP_PORT = 9000;

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

async function inspectTab(cdp, contextId, label) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Context: ${label} (id: ${contextId || 'default'})`);
    console.log(`${'='.repeat(60)}`);

    // ========== 1. Full DOM attribute dump of active tab ==========
    console.log(`\n--- [1] All attributes on active tab element ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                if (!tab) return { found: false };
                
                // Collect ALL attributes
                const attrs = {};
                for (const attr of tab.attributes) {
                    attrs[attr.name] = attr.value;
                }
                
                // Collect all child elements with their attributes
                const children = [];
                tab.querySelectorAll('*').forEach(el => {
                    const childAttrs = {};
                    for (const attr of el.attributes) {
                        childAttrs[attr.name] = attr.value.substring(0, 200);
                    }
                    children.push({
                        tag: el.tagName.toLowerCase(),
                        className: (el.className || '').substring(0, 100),
                        textContent: (el.textContent || '').substring(0, 100),
                        attrs: childAttrs
                    });
                });
                
                return { found: true, attrs, children, outerHTML: tab.outerHTML.substring(0, 2000) };
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.found) {
            console.log('  Tab attributes:', JSON.stringify(val.attrs, null, 2));
            console.log(`  Children (${val.children.length}):`);
            for (const child of val.children) {
                const attrsStr = Object.keys(child.attrs).length > 0
                    ? JSON.stringify(child.attrs) : '';
                console.log(`    <${child.tag}> class="${child.className}" ${attrsStr}`);
            }
            console.log('\n  outerHTML:', val.outerHTML);
        } else {
            console.log('  ❌ No active tab found');
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== 2. Check tooltip widget ==========
    console.log(`\n--- [2] Tooltip / hover information ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                // Check for any visible tooltip
                const tooltips = document.querySelectorAll('.monaco-tooltip, .tooltip, [class*="tooltip"], .hover-contents, .hover-widget');
                const results = [];
                tooltips.forEach(t => {
                    results.push({
                        className: t.className?.substring(0, 100),
                        text: t.textContent?.substring(0, 300),
                        display: getComputedStyle(t).display
                    });
                });
                return results;
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.length > 0) {
            for (const t of val) {
                console.log(`  tooltip: "${t.text}" (display: ${t.display})`);
            }
        } else {
            console.log('  No tooltip elements found');
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== 3. Monaco editor model URI ==========
    console.log(`\n--- [3] Monaco editor models / active editor URI ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                try {
                    // Try multiple ways to access Monaco editor
                    if (typeof monaco !== 'undefined' && monaco.editor) {
                        const models = monaco.editor.getModels();
                        return {
                            source: 'monaco.editor.getModels()',
                            models: models.map(m => ({
                                uri: m.uri?.toString(),
                                fsPath: m.uri?.fsPath,
                                path: m.uri?.path,
                                scheme: m.uri?.scheme
                            }))
                        };
                    }
                    return { source: 'monaco not available' };
                } catch(e) {
                    return { source: 'error', error: e.message };
                }
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        console.log(`  Source: ${val?.source}`);
        if (val?.models) {
            for (const m of val.models) {
                console.log(`  📄 URI: ${m.uri}`);
                console.log(`     fsPath: ${m.fsPath}`);
                console.log(`     path: ${m.path}`);
            }
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== 4. document.title (often has file path) ==========
    console.log(`\n--- [4] document.title ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `document.title`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        console.log(`  Title: "${result.result?.value}"`);
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== 5. Breadcrumbs (often show full path) ==========
    console.log(`\n--- [5] Breadcrumbs ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                const breadcrumb = document.querySelector('.breadcrumbs-control, .monaco-breadcrumbs');
                if (!breadcrumb) return { found: false };
                const items = [];
                breadcrumb.querySelectorAll('.monaco-breadcrumb-item, .breadcrumb-item').forEach(item => {
                    items.push(item.textContent?.trim());
                });
                return { found: true, items, text: breadcrumb.textContent?.substring(0, 300) };
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.found) {
            console.log(`  Items: ${JSON.stringify(val.items)}`);
            console.log(`  Full text: "${val.text}"`);
        } else {
            console.log('  No breadcrumbs found');
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== 6. Tab label's custom tooltip handler / data-uri ==========
    console.log(`\n--- [6] Tab internal properties (data-uri, __vnode, etc.) ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(() => {
                const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                if (!tab) return { found: false };
                
                // Check for data-uri or similar
                const dataKeys = Object.keys(tab.dataset || {});
                const dataset = { ...tab.dataset };
                
                // Check for __vnode or other framework internals
                const internalKeys = Object.getOwnPropertyNames(tab)
                    .filter(k => k.startsWith('__') || k.startsWith('_'));
                
                // Check for expando properties
                const expandoKeys = [];
                for (const key of Object.keys(tab)) {
                    if (!['style', 'className'].includes(key)) {
                        expandoKeys.push(key);
                    }
                }
                
                return { 
                    found: true, 
                    dataset,
                    dataKeys,
                    internalKeys,
                    expandoKeys
                };
            })()`,
            returnByValue: true,
            ...(contextId ? { contextId } : {})
        });
        const val = result.result?.value;
        if (val?.found) {
            console.log(`  dataset:`, JSON.stringify(val.dataset));
            console.log(`  Internal keys:`, val.internalKeys);
            console.log(`  Expando keys:`, val.expandoKeys);
        } else {
            console.log('  No active tab found');
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }

    // ========== 7. Trigger hover on tab and check tooltip ==========
    console.log(`\n--- [7] Simulate hover on tab → check tooltip ---`);
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: `(async () => {
                const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                if (!tab) return { found: false };
                
                // Get tab position
                const rect = tab.getBoundingClientRect();
                return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            })()`,
            returnByValue: true,
            awaitPromise: true,
            ...(contextId ? { contextId } : {})
        });
        const pos = result.result?.value;
        if (pos?.found) {
            // Simulate mouse move to trigger tooltip
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: pos.x,
                y: pos.y
            });

            // Wait for tooltip to appear
            await new Promise(r => setTimeout(r, 1500));

            // Check for tooltip
            const tooltipResult = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const tooltips = document.querySelectorAll(
                        '.monaco-tooltip, .tooltip, [class*="tooltip"], .hover-contents, .hover-widget, ' +
                        '.tab-tooltip, [class*="tab-label"], .monaco-hover, [class*="hover"]'
                    );
                    const visible = [];
                    tooltips.forEach(t => {
                        const style = getComputedStyle(t);
                        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                            visible.push({
                                className: t.className?.substring(0, 100),
                                text: t.textContent?.substring(0, 500),
                                innerHTML: t.innerHTML?.substring(0, 500)
                            });
                        }
                    });
                    
                    // Also check for any element that might have appeared
                    const allNew = document.querySelectorAll('[style*="position: absolute"], [style*="position:absolute"]');
                    const floating = [];
                    allNew.forEach(el => {
                        const style = getComputedStyle(el);
                        if (style.display !== 'none' && el.textContent?.trim() && 
                            (el.className?.includes('tooltip') || el.className?.includes('hover') || 
                             el.className?.includes('widget') || el.className?.includes('label'))) {
                            floating.push({
                                className: el.className?.substring(0, 100),
                                text: el.textContent?.substring(0, 500)
                            });
                        }
                    });
                    
                    return { visible, floating };
                })()`,
                returnByValue: true,
                ...(contextId ? { contextId } : {})
            });
            const tv = tooltipResult.result?.value;
            if (tv?.visible?.length > 0) {
                console.log('  Visible tooltips:');
                for (const t of tv.visible) {
                    console.log(`    class="${t.className}"`);
                    console.log(`    text="${t.text}"`);
                }
            } else {
                console.log('  No visible tooltip elements found');
            }
            if (tv?.floating?.length > 0) {
                console.log('  Floating elements:');
                for (const f of tv.floating) {
                    console.log(`    class="${f.className}"`);
                    console.log(`    text="${f.text}"`);
                }
            }

            // Move mouse away
            await cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: 0, y: 0
            });
        } else {
            console.log('  No active tab to hover');
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }
}

async function main() {
    console.log('🔍 CDP Tab Tooltip Inspector');
    console.log(`🔌 CDP port: ${CDP_PORT}`);

    const targets = await getTargets();
    const workbenches = targets.filter(t =>
        t.type === 'page' && (t.url?.includes('workbench') || t.title?.includes('workbench'))
    );

    console.log(`\n📋 Found ${targets.length} targets, ${workbenches.length} workbench pages`);

    for (const wb of workbenches) {
        try {
            const cdp = await connectCDP(wb.webSocketDebuggerUrl);
            await cdp.call('Runtime.enable');

            // Get execution contexts
            const contexts = [];
            cdp.ws.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.method === 'Runtime.executionContextCreated') {
                    contexts.push(msg.params.context);
                }
            });
            await new Promise(r => setTimeout(r, 500));

            // Test default context first
            await inspectTab(cdp, null, 'default');

            // Test each execution context
            for (const ctx of contexts) {
                await inspectTab(cdp, ctx.id, `ctx-${ctx.id} (${ctx.origin || 'unknown'})`);
            }

            cdp.ws.close();
        } catch (e) {
            console.log(`  ❌ Connection failed: ${e.message}`);
        }
    }

    console.log('\n✅ Inspection complete');
    process.exit(0);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
