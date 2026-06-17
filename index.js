// ═══════════════════════════════════════════════════════════════
// CHRONICLER — the "direct" verb of the suite
// v0.1.0 — PHASE 0: manual ladder + pointer, no AI.
//
// Owns the story's SPINE: an ordered ladder of rungs (world phases /
// plot beats) and a pointer at the current one. In Phase 0 you advance
// the pointer BY HAND (FAB or slash). On each generation it injects the
// active rung's world-phase directive, and it exposes window.ChroniclerAPI
// so the Codex↔Lexicon bridge can flip the active ERA from the pointer —
// Chronicler writes nobody's state but its own.
//
// Later phases bolt on: the walker (evaluator), the monotonic ratchet,
// emergent rungs, and proposeThread. None of that lives here yet — the
// whole point of Phase 0 is a coherent, shippable runtime with zero
// evaluator risk.
// ═══════════════════════════════════════════════════════════════

import { getContext, extension_settings } from '../../../extensions.js';

// ── Paranoid plumbing: zero script.js imports; resolve everything through
// getContext() at call time (matches Fortuna/Codex house style). Enum values
// hardcoded — stable across ST versions.
const PROMPT_IN_CHAT = 1;   // extension_prompt_types.IN_CHAT
const ROLE_SYSTEM = 0;      // extension_prompt_roles.SYSTEM

const ctx = () => getContext();
const ET = () => { const c = ctx(); return c.eventTypes || c.event_types || {}; };
const ES = () => ctx().eventSource;
function chatMeta() {
    const c = ctx();
    return c.chatMetadata || c.chat_metadata || {};
}
function saveSettingsDebounced() { try { ctx().saveSettingsDebounced(); } catch (e) { /* */ } }
function doSaveChat() {
    const c = ctx();
    try { (c.saveChatDebounced || c.saveChat || (() => {}))(); } catch (e) { /* */ }
}
function stSetExtensionPrompt(...args) {
    const c = ctx();
    if (typeof c.setExtensionPrompt === 'function') c.setExtensionPrompt(...args);
}

const EXT_ID = 'chronicler';
const TAG = '[Chronicler]';
const INJECT_KEY = 'CHRONICLER';
const Z = 31000; // house z-index
const VERSION = '0.1.0';

// ─────────────────────────────────────────────────────────────────
// Default ladder — a demo zombie escalation so the extension does
// something the moment it loads. Replace per-chat via "Load ladder JSON".
// Each rung is the World-Forge ARC_STATE shape: a descriptive situation
// plus an imperative tonal mandate. `era` is the name the bridge matches
// against an `ERA ▸ <era>` Lexicon entry / Codex state.
// ─────────────────────────────────────────────────────────────────

const DEMO_LADDER = [
    {
        title: 'Calm', genre: 'mundane slice-of-life', era: 'Calm',
        situation: 'An ordinary day. Nothing is wrong yet.',
        mandate: [
            'Keep the texture domestic and unhurried.',
            'Let small normalcy accumulate — errands, weather, idle talk.',
            'No threat, and no foreshadowing the audience could name.',
        ],
    },
    {
        title: 'Unease', genre: 'creeping dread', era: 'Unease',
        situation: 'Something is subtly off — a rumor, a missed call, a wrong silence.',
        mandate: [
            'Introduce one wrong detail per scene, left unexplained.',
            'Let characters rationalize it away.',
            'Tension rises; the source stays unnamed.',
        ],
    },
    {
        title: 'First Sighting', genre: 'survival horror', era: 'First Sighting',
        situation: 'The first confirmed sighting in town. It can no longer be denied.',
        mandate: [
            'Render violence efficient and grounded — no spectacle.',
            'Characters move from disbelief to adrenaline.',
            'The ordinary world is now visibly breaking.',
        ],
    },
    {
        title: 'Outbreak', genre: 'survival horror, escalating', era: 'Outbreak',
        situation: 'Sightings are common. Streets empty. Infrastructure strains.',
        mandate: [
            'The environment is hostile and depopulating.',
            'Every plan carries risk; safety is temporary.',
            'Show the world contracting around the characters.',
        ],
    },
    {
        title: 'Collapse', genre: 'post-collapse bleak', era: 'Collapse',
        situation: 'Society has fallen. Only the dead are common now.',
        mandate: [
            'Silence and scarcity define every scene.',
            'Other living humans are rare and suspect.',
            'Hope is a resource, not a given.',
        ],
    },
];

// ─────────────────────────────────────────────────────────────────
// Settings (global) + per-chat state
// ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    enabled: true,
    injectionDepth: 2,     // depth in chat (0 = very end)
    fabPos: null,          // {left, top} persisted drag position
};

function settings() {
    if (!extension_settings[EXT_ID]) extension_settings[EXT_ID] = {};
    const s = extension_settings[EXT_ID];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
    }
    return s;
}
function saveSettings() { saveSettingsDebounced(); }

// Per-chat: the ladder + pointer live with the chat, like Codex threads.
function chatState() {
    const m = chatMeta();
    if (!m[EXT_ID] || typeof m[EXT_ID] !== 'object') {
        m[EXT_ID] = { pointer: 0, ladder: deepCopy(DEMO_LADDER) };
    }
    const cs = m[EXT_ID];
    if (!Array.isArray(cs.ladder) || !cs.ladder.length) cs.ladder = deepCopy(DEMO_LADDER);
    if (typeof cs.pointer !== 'number') cs.pointer = 0;
    cs.pointer = clampPointer(cs.pointer, cs.ladder.length);
    return cs;
}
function saveChatState() { doSaveChat(); }

function deepCopy(o) { try { return JSON.parse(JSON.stringify(o)); } catch { return o; } }
function clampPointer(i, len) { return Math.max(0, Math.min((len || 1) - 1, i | 0)); }

// ─────────────────────────────────────────────────────────────────
// Ladder helpers
// ─────────────────────────────────────────────────────────────────

function activeRung() {
    const cs = chatState();
    return cs.ladder[cs.pointer] || null;
}

function rungLine(cs) { return `${cs.pointer + 1} / ${cs.ladder.length}`; }

// Move the pointer. dir = +1 advance, -1 retreat. Returns the new rung.
function step(dir) {
    const cs = chatState();
    const next = clampPointer(cs.pointer + dir, cs.ladder.length);
    if (next === cs.pointer) return null; // already at an end
    cs.pointer = next;
    saveChatState();
    const r = cs.ladder[cs.pointer];
    refreshPanel();
    try { toastr.info(`World phase → ${r.title}  (${rungLine(cs)})`, '📖 Chronicler', { timeOut: 3500 }); } catch (_) { /* */ }
    applyInjection(); // reflect the new phase immediately for the next gen
    return r;
}

function goTo(index) {
    const cs = chatState();
    const next = clampPointer(index, cs.ladder.length);
    cs.pointer = next;
    saveChatState();
    refreshPanel();
    applyInjection();
    return cs.ladder[cs.pointer];
}

// Replace the ladder from pasted JSON (an array of rungs, or {ladder:[...]}).
// Returns {ok, error}.
function loadLadder(jsonText) {
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (e) { return { ok: false, error: 'Not valid JSON.' }; }
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.ladder) ? parsed.ladder : null);
    if (!arr || !arr.length) return { ok: false, error: 'Expected a non-empty array of rungs (or { "ladder": [...] }).' };
    const norm = [];
    for (const r of arr) {
        if (!r || typeof r !== 'object') continue;
        const title = String(r.title || '').trim();
        if (!title) return { ok: false, error: 'Every rung needs a "title".' };
        norm.push({
            title,
            genre: String(r.genre || '').trim(),
            era: String(r.era || r.eraEntry || title).trim(),
            situation: String(r.situation || r.dramatic_situation || '').trim(),
            mandate: Array.isArray(r.mandate) ? r.mandate.map(x => String(x).trim()).filter(Boolean)
                   : (r.mandate ? [String(r.mandate)] : []),
        });
    }
    if (!norm.length) return { ok: false, error: 'No usable rungs found.' };
    const cs = chatState();
    cs.ladder = norm;
    cs.pointer = 0;
    saveChatState();
    refreshPanel();
    applyInjection();
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Injection — the active rung's world-phase directive
// ─────────────────────────────────────────────────────────────────

function buildPhaseBlock() {
    const r = activeRung();
    if (!r) return '';
    const lines = [`[World Phase — ${r.title}${r.genre ? ` (${r.genre})` : ''}]`];
    if (r.situation) lines.push(`Dramatic Situation: ${r.situation}`);
    if (r.mandate && r.mandate.length) {
        lines.push('Tonal Mandate (applies to every response in this scene):');
        for (const m of r.mandate) lines.push(`- ${m}`);
    }
    return lines.join('\n');
}

function applyInjection() {
    if (!settings().enabled) { clearInjection(); return; }
    const block = buildPhaseBlock();
    if (!block) { clearInjection(); return; }
    stSetExtensionPrompt(INJECT_KEY, block, PROMPT_IN_CHAT, settings().injectionDepth, false, ROLE_SYSTEM);
}
function clearInjection() {
    stSetExtensionPrompt(INJECT_KEY, '', PROMPT_IN_CHAT, settings().injectionDepth, false, ROLE_SYSTEM);
}

// ─────────────────────────────────────────────────────────────────
// FAB — top/left ONLY (themes put transform/filter on a zero-height
// <body>, so bottom/right anchoring resolves off-screen). Touchend-based
// tap detection with preventDefault to kill synthetic mouse events.
// ─────────────────────────────────────────────────────────────────

const FAB_STYLE = `position:fixed;left:0;top:0;width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#3a4a6a,#1c2230);color:#e6ecf5;border:2px solid rgba(190,150,90,0.75);box-shadow:0 2px 8px rgba(0,0,0,0.45);z-index:${Z};display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;touch-action:none;`;
const PANEL_STYLE = `position:fixed;left:0;top:0;width:min(300px, calc(100vw - 20px));max-height:80vh;overflow-y:auto;background:rgba(18,22,32,0.97);border:1px solid rgba(150,170,210,0.35);border-radius:12px;padding:12px;z-index:${Z};color:#e6ecf5;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.55);display:none;`;
const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;';
const BTN = 'background:#222c40;color:#e6ecf5;border:1px solid rgba(150,170,210,0.35);border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;';
const TA = 'width:100%;box-sizing:border-box;background:#141926;color:#cfd8e8;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:6px;font-size:11px;font-family:monospace;min-height:90px;';

const FAB_W = 40, FAB_H = 40, PAD = 5;

function clampFabPos(left, top) {
    return {
        left: Math.max(PAD, Math.min(window.innerWidth - FAB_W - PAD, left)),
        top: Math.max(PAD, Math.min(window.innerHeight - FAB_H - PAD, top)),
    };
}
function defaultFabPos() {
    // upper-left band, clear of Fortuna's right-edge ~55% slot
    return clampFabPos(15, Math.round(window.innerHeight * 0.22));
}
function applyFabPos($fab, pos) {
    $fab.css({ left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' });
}
function mountFab($fab) {
    $(document.body).append($fab);
    let pos = settings().fabPos;
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') pos = defaultFabPos();
    else pos = clampFabPos(pos.left, pos.top);
    applyFabPos($fab, pos);
}

const fabDrag = { active: false, moved: false, startX: 0, startY: 0, startLeft: 0, startTop: 0, touchedAt: 0 };
let fabWindowListenersBound = false;
const FAB_DRAG_THRESHOLD = 6;

function fabEl() { return document.getElementById('chronicler-fab'); }

function fabBegin(x, y) {
    const el = fabEl(); if (!el) return;
    fabDrag.active = true; fabDrag.moved = false;
    fabDrag.startX = x; fabDrag.startY = y;
    const r = el.getBoundingClientRect();
    fabDrag.startLeft = r.left; fabDrag.startTop = r.top;
}
function fabMove(x, y) {
    if (!fabDrag.active) return;
    const el = fabEl(); if (!el) return;
    const dx = x - fabDrag.startX, dy = y - fabDrag.startY;
    if (Math.abs(dx) + Math.abs(dy) > FAB_DRAG_THRESHOLD) fabDrag.moved = true;
    const pos = clampFabPos(fabDrag.startLeft + dx, fabDrag.startTop + dy);
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
}
function fabEnd() {
    if (!fabDrag.active) return;
    fabDrag.active = false;
    const el = fabEl(); if (!el) return;
    if (fabDrag.moved) {
        const r = el.getBoundingClientRect();
        settings().fabPos = { left: r.left, top: r.top };
        saveSettings();
    } else {
        togglePanel(); // clean tap → toggle exactly once
    }
}
function bindFabWindowListeners() {
    if (fabWindowListenersBound) return;
    fabWindowListenersBound = true;
    window.addEventListener('mousemove', e => { if (fabDrag.active) fabMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { if (fabDrag.active) fabEnd(); });
    window.addEventListener('resize', () => {
        const el = fabEl(); if (!el) return;
        const r = el.getBoundingClientRect();
        const pos = clampFabPos(r.left, r.top);
        el.style.left = pos.left + 'px';
        el.style.top = pos.top + 'px';
    });
}
function makeFabInteractive($fab) {
    const el = $fab[0];
    el.addEventListener('touchstart', e => {
        fabDrag.touchedAt = Date.now();
        const t = e.touches[0]; fabBegin(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener('touchmove', e => {
        if (!fabDrag.active) return;
        e.preventDefault();
        const t = e.touches[0]; fabMove(t.clientX, t.clientY);
    }, { passive: false });
    el.addEventListener('touchend', e => {
        fabDrag.touchedAt = Date.now();
        e.preventDefault(); // suppress synthetic mouse events → no double-toggle
        fabEnd();
    }, { passive: false });
    el.addEventListener('touchcancel', () => { fabDrag.active = false; fabDrag.moved = false; });
    el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (Date.now() - fabDrag.touchedAt < 700) return; // touch-spawned synthetic event
        fabBegin(e.clientX, e.clientY);
    });
    bindFabWindowListeners();
}

// ─────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function panelHtml() {
    const s = settings();
    const cs = chatState();
    const r = cs.ladder[cs.pointer] || {};
    const atStart = cs.pointer <= 0;
    const atEnd = cs.pointer >= cs.ladder.length - 1;
    const mandate = (r.mandate || []).map(m => `<li style="margin:2px 0;">${esc(m)}</li>`).join('');
    return `
    <div id="chronicler-panel" style="${PANEL_STYLE}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <b style="font-size:14px;">📖 Chronicler</b>
            <span id="chron-close" style="cursor:pointer;opacity:0.7;padding:2px 6px;">✕</span>
        </div>

        <div style="${ROW}">
            <span>Enabled</span>
            <input type="checkbox" id="chron-enabled" ${s.enabled ? 'checked' : ''}>
        </div>

        <div style="border-top:1px solid rgba(150,170,210,0.2);margin:6px 0;padding-top:6px;">
            <div style="display:flex;align-items:baseline;justify-content:space-between;">
                <b style="font-size:13px;">${esc(r.title || '—')}</b>
                <span style="opacity:0.6;font-size:11px;">${esc(rungLine(cs))}</span>
            </div>
            ${r.genre ? `<div style="opacity:0.7;font-size:11px;margin-top:1px;">${esc(r.genre)}</div>` : ''}
            ${r.situation ? `<div style="margin-top:5px;font-size:12px;">${esc(r.situation)}</div>` : ''}
            ${mandate ? `<ul style="margin:5px 0 0 0;padding-left:18px;opacity:0.85;font-size:11px;">${mandate}</ul>` : ''}
        </div>

        <div style="display:flex;gap:8px;margin:8px 0;">
            <button id="chron-back" style="${BTN}flex:1;${atStart ? 'opacity:0.4;' : ''}">◀ Back</button>
            <button id="chron-adv" style="${BTN}flex:1;${atEnd ? 'opacity:0.4;' : ''}">Advance ▶</button>
        </div>

        <div style="border-top:1px solid rgba(150,170,210,0.2);margin-top:6px;padding-top:6px;">
            <div id="chron-load-toggle" style="cursor:pointer;opacity:0.7;font-size:11px;">▸ Load ladder JSON</div>
            <div id="chron-load-box" style="display:none;margin-top:6px;">
                <textarea id="chron-ladder-json" style="${TA}" placeholder='[ { "title": "Calm", "genre": "…", "situation": "…", "mandate": ["…"] }, … ]'></textarea>
                <div style="display:flex;gap:8px;margin-top:6px;">
                    <button id="chron-load-apply" style="${BTN}flex:1;">Apply</button>
                    <button id="chron-load-export" style="${BTN}">Copy current</button>
                </div>
                <div id="chron-load-msg" style="font-size:11px;opacity:0.75;margin-top:5px;"></div>
            </div>
        </div>

        <div style="opacity:0.5;font-size:10px;margin-top:8px;">
            Phase 0 — advance by hand. The active phase is injected each turn and exposed as <code>ChroniclerAPI.getActiveEra()</code>.
        </div>
    </div>`;
}

let chronOutsideHandler = null;

function bindPanelEvents() {
    $('#chron-close').on('click', closePanel);
    $('#chron-enabled').on('change', function () {
        settings().enabled = $(this).prop('checked');
        saveSettings();
        applyInjection();
    });
    $('#chron-adv').on('click', () => step(+1));
    $('#chron-back').on('click', () => step(-1));
    $('#chron-load-toggle').on('click', function () {
        const box = document.getElementById('chron-load-box');
        if (!box) return;
        const open = box.style.display !== 'none';
        box.style.display = open ? 'none' : 'block';
        this.textContent = (open ? '▸' : '▾') + ' Load ladder JSON';
    });
    $('#chron-load-apply').on('click', function () {
        const txt = String($('#chron-ladder-json').val() || '');
        const res = loadLadder(txt);
        const msg = document.getElementById('chron-load-msg');
        if (msg) {
            msg.textContent = res.ok ? '✓ Ladder loaded; pointer reset to rung 1.' : '✗ ' + res.error;
            msg.style.color = res.ok ? '#9fd6a0' : '#e6a0a0';
        }
    });
    $('#chron-load-export').on('click', function () {
        const cs = chatState();
        const json = JSON.stringify(cs.ladder, null, 2);
        const ta = document.getElementById('chron-ladder-json');
        if (ta) ta.value = json;
        try { navigator.clipboard?.writeText(json); } catch (_) { /* */ }
        const msg = document.getElementById('chron-load-msg');
        if (msg) { msg.textContent = '✓ Current ladder copied into the box.'; msg.style.color = '#9fd6a0'; }
    });
}

function positionPanel() {
    const panel = document.getElementById('chronicler-panel');
    const fab = fabEl();
    if (!panel || !fab) return;
    const r = fab.getBoundingClientRect();
    const pw = Math.min(300, window.innerWidth - 20);
    // open to the right of the FAB if it fits, else clamp into view (top/left only)
    let left = r.right + 8;
    if (left + pw > window.innerWidth - 10) left = Math.max(10, window.innerWidth - pw - 10);
    let top = r.top;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    // nudge up if it would overflow the bottom
    requestAnimationFrame(() => {
        const pr = panel.getBoundingClientRect();
        if (pr.bottom > window.innerHeight - 10) {
            panel.style.top = Math.max(10, window.innerHeight - pr.height - 10) + 'px';
        }
    });
}

function openPanel() {
    let panel = document.getElementById('chronicler-panel');
    if (!panel) {
        $(document.body).append(panelHtml());
        bindPanelEvents();
        panel = document.getElementById('chronicler-panel');
    } else {
        // rebuild contents to reflect current state
        $(panel).replaceWith(panelHtml());
        bindPanelEvents();
        panel = document.getElementById('chronicler-panel');
    }
    panel.style.display = 'block';
    positionPanel();
    bindOutsideDismiss();
}
function closePanel() {
    const panel = document.getElementById('chronicler-panel');
    if (panel) panel.style.display = 'none';
    unbindOutsideDismiss();
}
function togglePanel() {
    const panel = document.getElementById('chronicler-panel');
    if (panel && panel.style.display === 'block') closePanel();
    else openPanel();
}
function refreshPanel() {
    const panel = document.getElementById('chronicler-panel');
    if (panel && panel.style.display === 'block') openPanel(); // rebuild in place
}

function bindOutsideDismiss() {
    if (chronOutsideHandler) return;
    chronOutsideHandler = (e) => {
        const panel = document.getElementById('chronicler-panel');
        const fab = fabEl();
        if (!panel) return;
        if (panel.contains(e.target) || (fab && fab.contains(e.target))) return;
        closePanel();
    };
    setTimeout(() => {
        document.addEventListener('touchstart', chronOutsideHandler, { passive: true });
        document.addEventListener('mousedown', chronOutsideHandler, true);
    }, 0);
}
function unbindOutsideDismiss() {
    if (!chronOutsideHandler) return;
    document.removeEventListener('touchstart', chronOutsideHandler, { passive: true });
    document.removeEventListener('mousedown', chronOutsideHandler, true);
    chronOutsideHandler = null;
}

function initUI() {
    document.getElementById('chronicler-fab')?.remove();
    document.getElementById('chronicler-panel')?.remove();
    const $fab = $(`<div id="chronicler-fab" style="${FAB_STYLE}" title="Chronicler">📖</div>`);
    mountFab($fab);
    makeFabInteractive($fab);
}

// ─────────────────────────────────────────────────────────────────
// Public API — read-only pointer the Codex bridge consults.
// Chronicler is the single gatekeeper for the active world phase.
// ─────────────────────────────────────────────────────────────────

function registerAPI() {
    window.ChroniclerAPI = {
        isActive: () => settings().enabled === true,
        getActiveEra: () => (activeRung()?.era || activeRung()?.title || null),
        getActiveRung: () => { const r = activeRung(); return r ? { ...r } : null; },
        getPointer: () => chatState().pointer,
        getRungCount: () => chatState().ladder.length,
        getLadder: () => deepCopy(chatState().ladder),
        getWorldPhaseBlock: () => buildPhaseBlock(),
        // manual control surface (Phase 0); the walker will call advance() later
        advance: () => step(+1),
        retreat: () => step(-1),
        goTo: (i) => goTo(i),
        version: VERSION,
    };
    console.log(`${TAG} Public API registered → window.ChroniclerAPI`);
}

// ─────────────────────────────────────────────────────────────────
// Slash commands (two-layer registration, like Fortuna)
// ─────────────────────────────────────────────────────────────────

function cmdPanel() { if (!fabEl()) initUI(); togglePanel(); return ''; }
function cmdAdvance() { const r = step(+1); return r ? r.title : 'already at the final rung'; }
function cmdBack() { const r = step(-1); return r ? r.title : 'already at the first rung'; }
function cmdGoto(_a, v) {
    const cs = chatState();
    const n = parseInt(String(v).trim(), 10);
    if (isNaN(n)) return 'usage: /chronicler-goto <1-' + cs.ladder.length + '>';
    const r = goTo(n - 1); // 1-indexed for humans
    try { toastr.info(`World phase → ${r.title} (${rungLine(chatState())})`, '📖 Chronicler'); } catch (_) { /* */ }
    return r.title;
}
function cmdDebug() {
    const s = settings(), cs = chatState(), r = activeRung();
    const fabLine = (() => {
        const el = fabEl();
        if (!el) return 'fab: ❌ MISSING from DOM';
        const rc = el.getBoundingClientRect();
        const vis = rc.width > 0 && rc.right > 0 && rc.bottom > 0 && rc.left < window.innerWidth && rc.top < window.innerHeight;
        return `fab: in DOM at ${Math.round(rc.left)},${Math.round(rc.top)} ${vis ? '(on-screen)' : '⚠️ OFF-SCREEN'}`;
    })();
    const lines = [
        `enabled: ${s.enabled}`,
        `pointer: ${cs.pointer} (${rungLine(cs)})`,
        `active era: ${r ? (r.era || r.title) : 'none'}`,
        `inject depth: ${s.injectionDepth}`,
        `bridge sees ChroniclerAPI: ${window.ChroniclerAPI ? 'yes' : 'no'}`,
        fabLine,
    ].join('<br>');
    try { toastr.info(lines, '📖 Chronicler state', { timeOut: 9000, escapeHtml: false }); } catch (_) { /* */ }
    return '';
}

async function registerCommands() {
    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        const { SlashCommandArgument, ARGUMENT_TYPE } = await import('../../../slash-commands/SlashCommandArgument.js');
        const P = SlashCommandParser, C = SlashCommand, A = SlashCommandArgument, T = ARGUMENT_TYPE;
        if (P?.addCommandObject && C?.fromProps) {
            P.addCommandObject(C.fromProps({ name: 'chronicler', callback: cmdPanel, helpString: 'Open the Chronicler panel.' }));
            P.addCommandObject(C.fromProps({ name: 'chronicler-advance', callback: cmdAdvance, helpString: 'Advance the world phase one rung.' }));
            P.addCommandObject(C.fromProps({ name: 'chronicler-back', callback: cmdBack, helpString: 'Step the world phase back one rung.' }));
            P.addCommandObject(C.fromProps({
                name: 'chronicler-goto', callback: cmdGoto,
                unnamedArgumentList: A ? [A.fromProps({ description: 'rung number (1-indexed)', typeList: T ? [T.NUMBER] : undefined, isRequired: true })] : [],
                helpString: 'Jump to a rung by number.',
            }));
            P.addCommandObject(C.fromProps({ name: 'chronicler-debug', callback: cmdDebug, helpString: 'Show Chronicler state as a toast.' }));
            console.log(TAG, 'slash commands registered (modern parser)');
            return;
        }
    } catch (e) {
        console.warn(TAG, 'modern slash-command modules unavailable, trying legacy', e);
    }
    try {
        const c = ctx();
        let legacy = c?.registerSlashCommand || window.registerSlashCommand;
        if (!legacy) {
            try { const script = await import('../../../../script.js'); legacy = script.registerSlashCommand; } catch (_) { /* */ }
        }
        if (typeof legacy === 'function') {
            legacy('chronicler', () => cmdPanel(), [], '– open the Chronicler panel', true, true);
            legacy('chronicler-advance', () => cmdAdvance(), [], '– advance the world phase', true, true);
            legacy('chronicler-back', () => cmdBack(), [], '– step the world phase back', true, true);
            legacy('chronicler-goto', (_a, v) => cmdGoto(_a, v), [], '– jump to a rung by number', true, true);
            legacy('chronicler-debug', () => cmdDebug(), [], '– show Chronicler state', true, true);
            console.log(TAG, 'slash commands registered (legacy)');
            return;
        }
        throw new Error('no registration API found');
    } catch (e) {
        console.error(TAG, 'slash command registration failed entirely', e);
        try { toastr.warning('Slash commands unavailable on this ST version — FAB panel still works.', '📖 Chronicler'); } catch (_) { /* */ }
    }
}

// ─────────────────────────────────────────────────────────────────
// Events + init
// ─────────────────────────────────────────────────────────────────

function on(eventName, fn, label) {
    if (!eventName) { console.warn(TAG, 'missing event type:', label); return; }
    ES().on(eventName, fn);
}

function onGenerationAfterCommands() { applyInjection(); }

function registerEvents() {
    const t = ET();
    on(t.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands, 'GENERATION_AFTER_COMMANDS');
    on(t.CHAT_CHANGED, () => { clearInjection(); applyInjection(); refreshPanel(); }, 'CHAT_CHANGED');
}

jQuery(async () => {
    try {
        console.log(`${TAG} initializing v${VERSION}…`);
        settings();
        registerAPI();
        try { initUI(); } catch (e) { console.error(TAG, 'UI init failed', e); }
        try { registerEvents(); } catch (e) { console.error(TAG, 'event registration failed', e); }
        try { await registerCommands(); } catch (e) { console.error(TAG, 'command registration failed', e); }
        // prime the injection for the current chat
        try { applyInjection(); } catch (e) { /* */ }
        console.log(`${TAG} ✅ loaded`);
    } catch (e) {
        console.error(`${TAG} ❌ critical failure`, e);
        try { toastr.error('Chronicler failed to initialize. Check console.', 'Chronicler Error', { timeOut: 10000 }); } catch (_) { /* */ }
    }
});
