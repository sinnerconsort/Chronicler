// ═══════════════════════════════════════════════════════════════
// CHRONICLER — the "direct" verb of the suite
// v0.2.0 — PHASE 1: + the walker.
//
// Phase 0 gave us the spine: an ordered ladder of world-phase rungs and a
// pointer you advance BY HAND. Phase 1 adds the WALKER — a background
// evaluator that reads recent chat and advances the pointer on its own when
// the active rung's EXIT TRIGGER has actually been met.
//
// Scripted only: the walker advances +1 along the authored ladder. It never
// skips, never creates rungs, never regresses. No ratchet deltas, no emergent
// rungs (those are later phases). Manual advance still works exactly as before
// — the walker just automates the tap, behind three gates: cooldown +
// confidence threshold + a clean JSON parse. A bad/uncertain judge moves
// nothing.
//
// Chronicler still writes nobody's state but its own; the walker's only effect
// is moving Chronicler's own pointer. The background call uses a utility
// connection profile (prefer a NON-reasoning model — see the token-budget hint).
// ═══════════════════════════════════════════════════════════════

import { getContext, extension_settings } from '../../../extensions.js';

// ── Paranoid plumbing: resolve everything through getContext() at call time.
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
const Z = 31000;
const VERSION = '0.2.0';

// ─────────────────────────────────────────────────────────────────
// Default ladder — demo zombie escalation. Each rung is the World-Forge
// ARC_STATE shape (situation + imperative mandate), PLUS an `exit` trigger:
// the condition the walker judges to decide whether to advance to the next
// rung. The terminal rung has no exit (the walker won't evaluate there).
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
        exit: 'Something first reads as wrong or out of place — a rumor, an odd absence, an unexplained detail that unsettles someone.',
    },
    {
        title: 'Unease', genre: 'creeping dread', era: 'Unease',
        situation: 'Something is subtly off — a rumor, a missed call, a wrong silence.',
        mandate: [
            'Introduce one wrong detail per scene, left unexplained.',
            'Let characters rationalize it away.',
            'Tension rises; the source stays unnamed.',
        ],
        exit: 'A zombie, or undeniable first-hand evidence of one, is directly witnessed for the first time.',
    },
    {
        title: 'First Sighting', genre: 'survival horror', era: 'First Sighting',
        situation: 'The first confirmed sighting in town. It can no longer be denied.',
        mandate: [
            'Render violence efficient and grounded — no spectacle.',
            'Characters move from disbelief to adrenaline.',
            'The ordinary world is now visibly breaking.',
        ],
        exit: 'Zombies appear in numbers or public order visibly breaks — the threat is no longer a single isolated incident.',
    },
    {
        title: 'Outbreak', genre: 'survival horror, escalating', era: 'Outbreak',
        situation: 'Sightings are common. Streets empty. Infrastructure strains.',
        mandate: [
            'The environment is hostile and depopulating.',
            'Every plan carries risk; safety is temporary.',
            'Show the world contracting around the characters.',
        ],
        exit: 'Organized society has effectively ended for the characters — rescue, infrastructure, or any safe refuge is gone.',
    },
    {
        title: 'Collapse', genre: 'post-collapse bleak', era: 'Collapse',
        situation: 'Society has fallen. Only the dead are common now.',
        mandate: [
            'Silence and scarcity define every scene.',
            'Other living humans are rare and suspect.',
            'Hope is a resource, not a given.',
        ],
        exit: '', // terminal — the walker never evaluates the last rung
    },
];

// ─────────────────────────────────────────────────────────────────
// Settings (global) + per-chat state
// ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    enabled: true,
    injectionDepth: 2,

    // ── Walker (Phase 1) ──
    walkerEnabled: true,         // background auto-advance on/off
    walkerProfile: 'current',    // connection profile NAME ('current' = active). Prefer a utility/non-reasoning profile.
    tokenBudget: 2000,           // never hardcode — reasoning models spend this on hidden CoT first
    minConfidence: 0.6,          // advance only when the judge is at least this sure
    cooldownMessages: 3,         // min messages between evaluations
    evidenceWindow: 6,           // how many recent messages the judge reads
    delayMs: 1200,               // wait after the message settles before judging

    fabPos: null,
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

function chatState() {
    const m = chatMeta();
    if (!m[EXT_ID] || typeof m[EXT_ID] !== 'object') {
        m[EXT_ID] = { pointer: 0, ladder: deepCopy(DEMO_LADDER) };
    }
    const cs = m[EXT_ID];
    if (!Array.isArray(cs.ladder) || !cs.ladder.length) cs.ladder = deepCopy(DEMO_LADDER);
    if (typeof cs.pointer !== 'number') cs.pointer = 0;
    cs.pointer = clampPointer(cs.pointer, cs.ladder.length);
    if (!cs._walker || typeof cs._walker !== 'object') cs._walker = { lastEvalAt: -999, last: null };
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

// Move the pointer. dir = +1 advance, -1 retreat. opts.silent skips the toast
// (the walker shows its own richer one). Returns the new rung or null at an end.
function step(dir, opts = {}) {
    const cs = chatState();
    const next = clampPointer(cs.pointer + dir, cs.ladder.length);
    if (next === cs.pointer) return null;
    cs.pointer = next;
    saveChatState();
    const r = cs.ladder[cs.pointer];
    refreshPanel();
    if (!opts.silent) {
        try { toastr.info(`World phase → ${r.title}  (${rungLine(cs)})`, '📖 Chronicler', { timeOut: 3500 }); } catch (_) { /* */ }
    }
    applyInjection();
    return r;
}

function goTo(index) {
    const cs = chatState();
    cs.pointer = clampPointer(index, cs.ladder.length);
    saveChatState();
    refreshPanel();
    applyInjection();
    return cs.ladder[cs.pointer];
}

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
            exit: String(r.exit || r.exit_trigger || '').trim(),
        });
    }
    if (!norm.length) return { ok: false, error: 'No usable rungs found.' };
    const cs = chatState();
    cs.ladder = norm;
    cs.pointer = 0;
    cs._walker = { lastEvalAt: -999, last: null };
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
// THE WALKER (Phase 1)
// A background evaluator: judges whether the active rung's exit trigger has
// been met, and advances if so. Builds on the evaluator-pattern (strict JSON,
// anti-false-positive, three gates) and the independent-connection transport.
// ─────────────────────────────────────────────────────────────────

let walkerInFlight = false;

function resolveProfileId(name) {
    const c = ctx();
    const cm = c.extensionSettings?.connectionManager || extension_settings?.connectionManager;
    if (!cm) return null;
    if (!name || name === 'current') return cm.selectedProfile || null;
    const p = (cm.profiles || []).find(x => x.name === name);
    return p ? p.id : (cm.selectedProfile || null);
}

function buildEvidence(n) {
    const chat = ctx().chat || [];
    const msgs = chat.filter(m => m && !m.is_system).slice(-Math.max(2, n | 0));
    const name1 = ctx().name1 || 'User';
    const name2 = ctx().name2 || 'Character';
    return msgs.map(m => {
        const who = m.is_user ? name1 : (m.name || name2);
        const text = String(m.mes || '').replace(/\s+/g, ' ').trim();
        return `${who}: ${text}`;
    }).join('\n');
}

function buildWalkerPrompt(rung, evidence) {
    return [
        "You are the progression walker for a story's world-phase ladder. You are a judge, not a narrator — do not address the reader or continue the story.",
        '',
        'The story is currently at this phase:',
        `  Phase: ${rung.title}`,
        rung.situation ? `  Situation: ${rung.situation}` : '',
        '',
        'This phase advances to the next ONLY when its exit condition is met:',
        `  Exit condition: ${rung.exit}`,
        '',
        'Read the recent chat and decide whether the exit condition has ACTUALLY been met on-screen.',
        'Mark "advance" ONLY when the recent messages give direct evidentiary support that the exit condition is fulfilled. If the evidence is ambiguous, partial, anticipated-but-not-yet-happened, or merely thematically near, decide "hold". Do NOT infer from foreshadowing, mood, relevance, or what will probably happen next.',
        'Return ONLY valid JSON, no preamble and no markdown fences, with exactly these keys:',
        '{ "decision": "hold" | "advance", "confidence": 0.0, "reason": "one short sentence; quote the moment if advancing" }',
        '',
        'Recent chat:',
        evidence,
    ].filter(Boolean).join('\n');
}

function parseDecision(raw) {
    try {
        let clean = String(raw == null ? '' : raw).replace(/```json|```/g, '').trim();
        const m = clean.match(/\{[\s\S]*\}/);
        const d = JSON.parse(m ? m[0] : clean);
        if (typeof d.decision !== 'string') return null;
        d.decision = d.decision.trim().toLowerCase();
        d.confidence = Number.isFinite(d.confidence) ? d.confidence : 0;
        d.reason = typeof d.reason === 'string' ? d.reason : '';
        return d;
    } catch {
        return null; // fail safe: act on nothing
    }
}

async function callUtility(prompt) {
    const c = ctx();
    if (!c.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService unavailable');
    const profileId = resolveProfileId(settings().walkerProfile);
    if (!profileId) throw new Error('no connection profile resolved');
    const res = await c.ConnectionManagerRequestService.sendRequest(
        profileId,
        [{ role: 'user', content: prompt }],
        settings().tokenBudget || 2000,
        { extractData: true, includePreset: true, includeInstruct: false },
        {},
    );
    return (res && typeof res === 'object' && 'content' in res) ? res.content : res;
}

// force=true bypasses the cooldown (used by the "Check now" button / slash).
async function runWalker(mesId, force = false) {
    const s = settings();
    if (!s.enabled || !s.walkerEnabled) return;
    if (walkerInFlight) return;

    const cs = chatState();
    const rung = cs.ladder[cs.pointer];
    // terminal rung or no exit trigger → nothing to judge
    if (!rung || !rung.exit || cs.pointer >= cs.ladder.length - 1) return;

    const chat = ctx().chat || [];
    const idx = (typeof mesId === 'number' && mesId >= 0) ? mesId : chat.length - 1;
    const msg = chat[idx];
    // only judge a committed, non-user, non-system message
    if (!msg || msg.is_user || msg.is_system) return;

    if (!force && (idx - cs._walker.lastEvalAt) < (s.cooldownMessages | 0)) return;

    walkerInFlight = true;
    try {
        if (!force && s.delayMs > 0) await new Promise(r => setTimeout(r, s.delayMs));

        const evidence = buildEvidence(s.evidenceWindow);
        if (!evidence.trim()) return;

        const raw = await callUtility(buildWalkerPrompt(rung, evidence));
        cs._walker.lastEvalAt = idx;

        const d = parseDecision(raw);
        cs._walker.last = d ? `${d.decision} @${(d.confidence || 0).toFixed(2)}` : 'parse-fail';
        saveChatState();
        refreshPanel();

        if (!d) return;                                        // gate 1: clean parse
        if (d.decision !== 'advance') return;
        if ((d.confidence || 0) < s.minConfidence) return;     // gate 2: confidence
        // gate 3: cooldown was already applied above

        const before = rung.title;
        const moved = step(+1, { silent: true });
        if (moved) {
            try {
                toastr.success(`Walker advanced: ${before} → ${moved.title}\n${d.reason || ''}`,
                    '📖 Chronicler', { timeOut: 7000 });
            } catch (_) { /* */ }
        }
    } catch (e) {
        cs._walker.last = 'error';
        console.warn(TAG, 'walker failed:', e);
        if (force) { try { toastr.warning('Walker check failed: ' + (e?.message || e), '📖 Chronicler'); } catch (_) { /* */ } }
    } finally {
        walkerInFlight = false;
    }
}

// ─────────────────────────────────────────────────────────────────
// FAB — top/left ONLY; touchend tap detection with preventDefault.
// ─────────────────────────────────────────────────────────────────

const FAB_STYLE = `position:fixed;left:0;top:0;width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#3a4a6a,#1c2230);color:#e6ecf5;border:2px solid rgba(190,150,90,0.75);box-shadow:0 2px 8px rgba(0,0,0,0.45);z-index:${Z};display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;touch-action:none;`;
const PANEL_STYLE = `position:fixed;left:0;top:0;width:min(300px, calc(100vw - 20px));max-height:82vh;overflow-y:auto;background:rgba(18,22,32,0.97);border:1px solid rgba(150,170,210,0.35);border-radius:12px;padding:12px;z-index:${Z};color:#e6ecf5;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.55);display:none;`;
const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;';
const BTN = 'background:#222c40;color:#e6ecf5;border:1px solid rgba(150,170,210,0.35);border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;';
const TA = 'width:100%;box-sizing:border-box;background:#141926;color:#cfd8e8;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:6px;font-size:11px;font-family:monospace;min-height:90px;';
const NUM = 'background:#141926;color:#e6ecf5;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:3px 6px;font-size:12px;width:70px;';
const TXT = 'background:#141926;color:#e6ecf5;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:3px 6px;font-size:12px;width:120px;';

const FAB_W = 40, FAB_H = 40, PAD = 5;

function clampFabPos(left, top) {
    return {
        left: Math.max(PAD, Math.min(window.innerWidth - FAB_W - PAD, left)),
        top: Math.max(PAD, Math.min(window.innerHeight - FAB_H - PAD, top)),
    };
}
function defaultFabPos() { return clampFabPos(15, Math.round(window.innerHeight * 0.22)); }
function applyFabPos($fab, pos) { $fab.css({ left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' }); }
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
        togglePanel();
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
        e.preventDefault();
        fabEnd();
    }, { passive: false });
    el.addEventListener('touchcancel', () => { fabDrag.active = false; fabDrag.moved = false; });
    el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (Date.now() - fabDrag.touchedAt < 700) return;
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
    const last = cs._walker?.last ? esc(cs._walker.last) : '—';
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
            ${r.exit ? `<div style="margin-top:6px;font-size:11px;opacity:0.7;"><b>Exit →</b> ${esc(r.exit)}</div>`
                     : `<div style="margin-top:6px;font-size:11px;opacity:0.5;">terminal rung — walker idle here</div>`}
        </div>

        <div style="display:flex;gap:8px;margin:8px 0;">
            <button id="chron-back" style="${BTN}flex:1;${atStart ? 'opacity:0.4;' : ''}">◀ Back</button>
            <button id="chron-adv" style="${BTN}flex:1;${atEnd ? 'opacity:0.4;' : ''}">Advance ▶</button>
        </div>

        <div style="border-top:1px solid rgba(150,170,210,0.2);margin-top:6px;padding-top:6px;">
            <div id="chron-walk-toggle" style="cursor:pointer;opacity:0.8;font-size:12px;">▾ Walker (auto-advance)</div>
            <div id="chron-walk-box" style="margin-top:6px;">
                <div style="${ROW}">
                    <span>Auto-advance</span>
                    <input type="checkbox" id="chron-walk-en" ${s.walkerEnabled ? 'checked' : ''}>
                </div>
                <div style="${ROW}">
                    <span>Profile</span>
                    <input type="text" id="chron-walk-profile" value="${esc(s.walkerProfile)}" style="${TXT}">
                </div>
                <div style="${ROW}">
                    <span>Token budget</span>
                    <input type="number" id="chron-walk-budget" value="${s.tokenBudget}" min="256" step="256" style="${NUM}">
                </div>
                <div style="${ROW}">
                    <span>Min confidence</span>
                    <input type="number" id="chron-walk-conf" value="${s.minConfidence}" min="0" max="1" step="0.05" style="${NUM}">
                </div>
                <div style="${ROW}">
                    <span>Cooldown (msgs)</span>
                    <input type="number" id="chron-walk-cd" value="${s.cooldownMessages}" min="0" step="1" style="${NUM}">
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                    <button id="chron-walk-check" style="${BTN}flex:1;">Check now</button>
                    <span style="font-size:11px;opacity:0.6;">last: ${last}</span>
                </div>
                <div style="opacity:0.5;font-size:10px;margin-top:5px;">
                    Prefer a non-reasoning utility profile (e.g. GLM-4.7). Reasoning models spend the budget on hidden thinking first — raise it to 4000+ if checks get cut off.
                </div>
            </div>
        </div>

        <div style="border-top:1px solid rgba(150,170,210,0.2);margin-top:6px;padding-top:6px;">
            <div id="chron-load-toggle" style="cursor:pointer;opacity:0.7;font-size:11px;">▸ Load ladder JSON</div>
            <div id="chron-load-box" style="display:none;margin-top:6px;">
                <textarea id="chron-ladder-json" style="${TA}" placeholder='[ { "title": "Calm", "situation": "…", "mandate": ["…"], "exit": "what must happen to advance" }, … ]'></textarea>
                <div style="display:flex;gap:8px;margin-top:6px;">
                    <button id="chron-load-apply" style="${BTN}flex:1;">Apply</button>
                    <button id="chron-load-export" style="${BTN}">Copy current</button>
                </div>
                <div id="chron-load-msg" style="font-size:11px;opacity:0.75;margin-top:5px;"></div>
            </div>
        </div>

        <div style="opacity:0.5;font-size:10px;margin-top:8px;">
            Phase 1 — the walker judges the <b>Exit →</b> trigger each AI turn and advances when met (confidence ≥ ${s.minConfidence}). You can still advance by hand anytime.
        </div>
    </div>`;
}

let chronOutsideHandler = null;

function bindPanelEvents() {
    $('#chron-close').on('click', closePanel);
    $('#chron-enabled').on('change', function () {
        settings().enabled = $(this).prop('checked'); saveSettings(); applyInjection();
    });
    $('#chron-adv').on('click', () => step(+1));
    $('#chron-back').on('click', () => step(-1));

    // Walker controls
    $('#chron-walk-toggle').on('click', function () {
        const box = document.getElementById('chron-walk-box');
        if (!box) return;
        const open = box.style.display !== 'none';
        box.style.display = open ? 'none' : 'block';
        this.textContent = (open ? '▸' : '▾') + ' Walker (auto-advance)';
    });
    $('#chron-walk-en').on('change', function () { settings().walkerEnabled = $(this).prop('checked'); saveSettings(); });
    $('#chron-walk-profile').on('change', function () { settings().walkerProfile = String($(this).val() || 'current').trim() || 'current'; saveSettings(); });
    $('#chron-walk-budget').on('change', function () { const v = parseInt($(this).val(), 10); settings().tokenBudget = isNaN(v) ? 2000 : Math.max(256, v); saveSettings(); });
    $('#chron-walk-conf').on('change', function () { let v = parseFloat($(this).val()); if (isNaN(v)) v = 0.6; settings().minConfidence = Math.max(0, Math.min(1, v)); saveSettings(); });
    $('#chron-walk-cd').on('change', function () { const v = parseInt($(this).val(), 10); settings().cooldownMessages = isNaN(v) ? 3 : Math.max(0, v); saveSettings(); });
    $('#chron-walk-check').on('click', function () {
        try { toastr.info('Checking the exit trigger…', '📖 Chronicler', { timeOut: 2500 }); } catch (_) { /* */ }
        runWalker(-1, true);
    });

    // Load JSON
    $('#chron-load-toggle').on('click', function () {
        const box = document.getElementById('chron-load-box');
        if (!box) return;
        const open = box.style.display !== 'none';
        box.style.display = open ? 'none' : 'block';
        this.textContent = (open ? '▸' : '▾') + ' Load ladder JSON';
    });
    $('#chron-load-apply').on('click', function () {
        const res = loadLadder(String($('#chron-ladder-json').val() || ''));
        const msg = document.getElementById('chron-load-msg');
        if (msg) {
            msg.textContent = res.ok ? '✓ Ladder loaded; pointer reset to rung 1.' : '✗ ' + res.error;
            msg.style.color = res.ok ? '#9fd6a0' : '#e6a0a0';
        }
    });
    $('#chron-load-export').on('click', function () {
        const json = JSON.stringify(chatState().ladder, null, 2);
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
    let left = r.right + 8;
    if (left + pw > window.innerWidth - 10) left = Math.max(10, window.innerWidth - pw - 10);
    panel.style.left = left + 'px';
    panel.style.top = r.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
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
    } else {
        $(panel).replaceWith(panelHtml());
    }
    bindPanelEvents();
    panel = document.getElementById('chronicler-panel');
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
    if (panel && panel.style.display === 'block') openPanel();
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
// Public API — read-only pointer + the manual/auto control surface.
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
        advance: () => step(+1),
        retreat: () => step(-1),
        goTo: (i) => goTo(i),
        checkNow: () => runWalker(-1, true),   // force a walker evaluation
        version: VERSION,
    };
    console.log(`${TAG} Public API registered → window.ChroniclerAPI`);
}

// ─────────────────────────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────────────────────────

function cmdPanel() { if (!fabEl()) initUI(); togglePanel(); return ''; }
function cmdAdvance() { const r = step(+1); return r ? r.title : 'already at the final rung'; }
function cmdBack() { const r = step(-1); return r ? r.title : 'already at the first rung'; }
function cmdGoto(_a, v) {
    const cs = chatState();
    const n = parseInt(String(v).trim(), 10);
    if (isNaN(n)) return 'usage: /chronicler-goto <1-' + cs.ladder.length + '>';
    const r = goTo(n - 1);
    try { toastr.info(`World phase → ${r.title} (${rungLine(chatState())})`, '📖 Chronicler'); } catch (_) { /* */ }
    return r.title;
}
function cmdCheck() { runWalker(-1, true); return 'checking exit trigger…'; }
function cmdDebug() {
    const s = settings(), cs = chatState(), r = activeRung();
    const profId = resolveProfileId(s.walkerProfile);
    const fabLine = (() => {
        const el = fabEl();
        if (!el) return 'fab: ❌ MISSING from DOM';
        const rc = el.getBoundingClientRect();
        const vis = rc.width > 0 && rc.right > 0 && rc.bottom > 0 && rc.left < window.innerWidth && rc.top < window.innerHeight;
        return `fab: in DOM at ${Math.round(rc.left)},${Math.round(rc.top)} ${vis ? '(on-screen)' : '⚠️ OFF-SCREEN'}`;
    })();
    const lines = [
        `enabled: ${s.enabled} | walker: ${s.walkerEnabled}`,
        `pointer: ${cs.pointer} (${rungLine(cs)}) — ${r ? (r.era || r.title) : 'none'}`,
        `exit watched: ${r && r.exit ? '“' + r.exit.slice(0, 60) + (r.exit.length > 60 ? '…' : '') + '”' : '(terminal — idle)'}`,
        `walker last: ${cs._walker?.last || '—'} | in-flight: ${walkerInFlight}`,
        `profile: ${s.walkerProfile} → ${profId ? 'resolved ✓' : '❌ unresolved'}`,
        `transport: ${ctx().ConnectionManagerRequestService ? 'ConnectionManagerRequestService ✓' : '❌ unavailable'}`,
        `budget: ${s.tokenBudget} | minConf: ${s.minConfidence} | cooldown: ${s.cooldownMessages}`,
        fabLine,
    ].join('<br>');
    try { toastr.info(lines, '📖 Chronicler state', { timeOut: 11000, escapeHtml: false }); } catch (_) { /* */ }
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
            P.addCommandObject(C.fromProps({ name: 'chronicler-check', callback: cmdCheck, helpString: 'Force the walker to judge the exit trigger now.' }));
            P.addCommandObject(C.fromProps({ name: 'chronicler-debug', callback: cmdDebug, helpString: 'Show Chronicler + walker state as a toast.' }));
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
            legacy('chronicler-check', () => cmdCheck(), [], '– force a walker check', true, true);
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
function onMessageReceived(mesId) {
    // fire-and-forget; the walker self-gates (cooldown, in-flight, message type)
    try { runWalker(Number(mesId)); } catch (e) { console.warn(TAG, 'onMessageReceived', e); }
}

function registerEvents() {
    const t = ET();
    on(t.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands, 'GENERATION_AFTER_COMMANDS');
    on(t.MESSAGE_RECEIVED, onMessageReceived, 'MESSAGE_RECEIVED');
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
        try { applyInjection(); } catch (e) { /* */ }
        console.log(`${TAG} ✅ loaded`);
    } catch (e) {
        console.error(`${TAG} ❌ critical failure`, e);
        try { toastr.error('Chronicler failed to initialize. Check console.', 'Chronicler Error', { timeOut: 10000 }); } catch (_) { /* */ }
    }
});
