// ═══════════════════════════════════════════════════════════════
// CHRONICLER — the "direct" verb of the suite
// v0.5.0 — PHASE 2b: + AI ladder GENERATOR (premise -> ladder via the walker's
// connection) and two more templates (Story Circle, Kishotenketsu). Fills an idle
// chat for ANY story in seconds.
//
// v0.4.0 — PHASE 2a+2c: + genre TEMPLATES (Horror / Romance / Hero's Journey)
// and a save/load LIBRARY scoped per-character or global. Empty chats fill in
// seconds from a template instead of being authored from scratch.
//
// v0.3.0 — PHASE 1.5: + modes (off / world / character) and a SAFE IDLE
// default. A fresh chat has NO ladder and does nothing until you load one, so
// Chronicler can never fight a story it wasn't authored for. World mode injects
// the phase mandate; character mode drives the character's era via the Codex
// flip and injects nothing; off pauses without clearing the ladder.
//
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
const VERSION = '0.7.1';

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
// GENRE TEMPLATES — pre-authored ladders so a fresh chat is filled in
// seconds, not authored from scratch. Beats are ARCHETYPAL (generic but
// walker-judgeable) so they fit any story in the genre; story-specific
// tweaks are the customization layer on top (edit JSON, or regenerate).
// Each: { name, mode, ladder }. Plot beat sheets default to world mode.
// ─────────────────────────────────────────────────────────────────

const TEMPLATES = {
    zombie: { name: 'Zombie outbreak (demo)', mode: 'world', ladder: DEMO_LADDER },

    horror: {
        name: 'Horror beat sheet', mode: 'world', ladder: [
            { title: 'Ordinary Surface', genre: 'unsettling normalcy', situation: 'The world looks normal, but something is quietly wrong.', mandate: ['Keep it domestic and grounded, with one hairline crack.', 'Plant a hint of the threat that no one quite clocks.'], exit: 'An unsettling detail, absence, or rumor surfaces that cannot be fully explained away.' },
            { title: 'The Crack Widens', genre: 'creeping dread', situation: 'Characters and their inner fault lines are drawn; unease grows.', mandate: ['Deepen the people and their internal conflict.', 'Let the wrongness recur and resist tidy explanation.'], exit: 'The characters become isolated, or are drawn toward the source of the wrongness.' },
            { title: 'No Turning Back', genre: 'mounting dread', situation: 'A warning is ignored or a threshold crossed; retreat closes off.', mandate: ['Foreclose the easy exit.', 'Tighten dread; make the air feel wrong.'], exit: 'The threat is directly encountered or witnessed first-hand for the first time.' },
            { title: 'First Encounter', genre: 'survival horror', situation: 'The threat is real and seen. Denial ends.', mandate: ['Render it grounded and frightening, never spectacular.', 'Snap disbelief into adrenaline.'], exit: 'Someone dies or is seriously harmed, or the threat proves it means them.' },
            { title: 'Shit Gets Real', genre: 'survival horror, bloody', situation: 'First death or undeniable danger. The stakes are blood now.', mandate: ['Let consequences land hard.', 'Evaporate any sense of safety.'], exit: 'The characters are actively hunted, besieged, or trapped.' },
            { title: 'The Hunt', genre: 'relentless pursuit', situation: 'The threat pursues; they run, hide, scheme.', mandate: ['Keep the pressure relentless.', 'Make every refuge temporary.'], exit: 'They attempt to confront or stop the threat — and fail.' },
            { title: 'Failed Confrontation', genre: 'despair', situation: 'They try to beat it and cannot. The plan was wrong.', mandate: ['Make the failure cost something real.', 'Let hope curdle.'], exit: 'All seems lost — internal and external collapse arrive together.' },
            { title: 'The Darkest Hour', genre: 'rock bottom', situation: 'The threat and the inner wound are exposed together.', mandate: ['Strip away comfort.', 'Surface the true nature of both the monster and the flaw.'], exit: 'A new, costlier understanding or plan emerges from the despair.' },
            { title: 'The True Cost', genre: 'grim resolve', situation: 'A different plan forms; what it demands becomes clear.', mandate: ['Make the price explicit and painful.', 'Let sacrifice loom.'], exit: 'Sacrifices are made (or refused) in a final reckoning with the threat.' },
            { title: 'The Reckoning', genre: 'climactic horror', situation: 'Final stand. The cost is paid or refused.', mandate: ['Pay the cost on-screen.', 'Resolve the inner conflict through the outer one.'], exit: 'The immediate threat is ended or escaped, at a price.' },
            { title: 'Only Delayed', genre: 'bleak aftermath', situation: 'The fallout. It is over — but not really.', mandate: ['Show consequences and scars.', 'Leave one ember unextinguished.'], exit: '' },
        ],
    },

    romance: {
        name: 'Romance plot beats', mode: 'world', ladder: [
            { title: 'Opening', genre: 'grounded, wistful', situation: "Ordinary life before love; the lead's want and wound are shown.", mandate: ['Establish who they are and what is missing.', 'No love-interest pressure yet.'], exit: 'The two leads meet or collide for the first time.' },
            { title: 'Meet', genre: 'charged', situation: 'First contact. Spark or friction — never neutral.', mandate: ['Charge the first meeting.', 'Let attraction or antagonism crackle.'], exit: 'Circumstances force the two together despite resistance.' },
            { title: 'Forced Together', genre: 'tense attraction', situation: 'Thrown into proximity; both resist the pull.', mandate: ['Keep them circling.', 'Resistance on the surface, heat underneath.'], exit: 'Resistance wanes; genuine warmth slips through.' },
            { title: 'The Thaw', genre: 'tender', situation: 'Defenses lower; attraction becomes undeniable.', mandate: ['Let small intimacies land.', 'Let vulnerability peek out.'], exit: 'One or both privately admit, to themselves, that they want this.' },
            { title: 'Desire', genre: 'yearning, hopeful', situation: 'Want is named inwardly; they picture a future.', mandate: ['Let longing and tenderness rise.', 'Let them hope.'], exit: 'A first real setback or fear threatens the bond.' },
            { title: 'Happiness Within Reach', genre: 'warm, fragile', situation: 'The relationship blooms; it could actually work.', mandate: ['Make the joy real and earned.', 'Raise what there is to lose.'], exit: 'A deeper fear or external blow shatters the moment.' },
            { title: 'The Black Moment', genre: 'heartbreak', situation: 'Everything falls apart; the bond seems broken.', mandate: ['Make the rupture cut to the core wound.', 'No easy comfort.'], exit: 'In the aftermath, one lead is forced to confront their own flaw.' },
            { title: 'Epiphany', genre: 'raw clarity', situation: 'The wound is faced; what love requires becomes clear.', mandate: ['Let the internal change land.', 'Replace fear with understanding.'], exit: 'A decisive act is taken to win the other back.' },
            { title: 'Grand Gesture', genre: 'vulnerable, earnest', situation: 'A risk is taken to repair what broke.', mandate: ['Put cost and sincerity on display.', 'Expose vulnerability fully.'], exit: 'The two reconcile and commit.' },
            { title: 'Happily Ever After', genre: 'warm resolution', situation: 'Love affirmed; a glimpse of the life ahead.', mandate: ['Let it breathe.', "Pay off the opening's lack."], exit: '' },
        ],
    },

    hero: {
        name: "Hero's journey (archplot)", mode: 'world', ladder: [
            { title: 'Ordinary World', genre: 'grounded setup', situation: "The hero's normal life, before the call. Limited awareness.", mandate: ['Ground the status quo.', 'Show the lack the journey will answer.'], exit: 'An event or summons disrupts the ordinary world.' },
            { title: 'Call to Adventure', genre: 'inciting', situation: 'The inciting incident; a problem or invitation arrives.', mandate: ['Present the call clearly.', 'Let its weight register.'], exit: 'The hero hesitates, refuses, or fears the call.' },
            { title: 'Refusal & Mentor', genre: 'reluctant', situation: 'Reluctance; guidance or hard resolve is found.', mandate: ['Honor the fear.', 'Let mentorship or necessity tip the balance.'], exit: 'The hero commits and crosses into the unfamiliar.' },
            { title: 'Crossing the Threshold', genre: 'adventure begins', situation: 'Point of no return; the special world begins.', mandate: ['Mark the shift in rules and tone.', 'Commit the hero.'], exit: 'The hero faces early tests and meets allies and enemies.' },
            { title: 'Tests, Allies, Enemies', genre: 'rising action', situation: 'Trials of the new world; bonds and rivals form.', mandate: ['Build competence and relationships through obstacles.', 'Keep momentum rising.'], exit: 'A major midpoint shift jumps the stakes or understanding.' },
            { title: 'Midpoint', genre: 'turning point', situation: 'A pivotal turn; false victory or revelation raises the stakes.', mandate: ['Change the game.', 'Commit the hero fully to the journey.'], exit: 'The hero approaches the central ordeal; the antagonist closes in.' },
            { title: 'Approach the Cave', genre: 'tightening dread', situation: 'Preparing for the hardest trial; the bad guys close in.', mandate: ['Tighten dread and stakes.', 'Let complications mount.'], exit: 'The hero enters the ordeal — the crisis or darkest moment.' },
            { title: 'The Ordeal', genre: 'crisis', situation: 'The central crisis; death, loss, or the abyss.', mandate: ['Make the stakes mortal.', 'Let the old self die here.'], exit: 'The hero seizes the prize or a hard-won truth.' },
            { title: 'Seizing the Sword', genre: 'hard-won', situation: 'The reward; transformation through the ordeal.', mandate: ['Let the victory cost something.', 'Let it change the hero.'], exit: 'A final push or pursuit drives toward the climax.' },
            { title: 'The Final Push', genre: 'climactic', situation: 'The road back; a last confrontation or sprint.', mandate: ['Pay off the arc.', 'Let the changed hero act decisively.'], exit: 'The conflict resolves and the hero turns toward home.' },
            { title: 'Return with the Elixir', genre: 'resolution', situation: 'Resolution; a new normal carrying what was won.', mandate: ['Show the transformed status quo.', 'Pay off the ordinary world.'], exit: '' },
        ],
    },

    storycircle: {
        name: 'Story Circle (Dan Harmon)', mode: 'world', ladder: [
            { title: 'Comfort Zone', genre: 'grounded order', situation: 'The character in their familiar world, in balance.', mandate: ['Establish the routine and what feels safe.', 'Hint at the small lack beneath the order.'], exit: 'A want or need surfaces that the comfort zone cannot satisfy.' },
            { title: 'The Need', genre: 'restless', situation: 'A desire or lack sharpens; the status quo no longer fits.', mandate: ['Make the want concrete.', 'Let dissatisfaction build pressure.'], exit: 'The character steps into an unfamiliar situation to pursue it.' },
            { title: 'The Descent', genre: 'unfamiliar', situation: 'They cross into unfamiliar territory; new rules apply.', mandate: ['Disorient gently — the ground is new.', 'Raise the stakes of being out of place.'], exit: 'They begin adapting, searching, and struggling in the new world.' },
            { title: 'The Search', genre: 'trial and adaptation', situation: 'Adaptation through trials; they learn the new world.', mandate: ['Test them; let them change to cope.', 'Build toward what they came for.'], exit: 'They get what they were looking for.' },
            { title: 'The Find', genre: 'apparent victory', situation: 'They find or seize the thing they wanted.', mandate: ['Let the victory feel real.', 'Plant the cost it will demand.'], exit: 'Holding it turns out to demand a heavy price.' },
            { title: 'The Price', genre: 'hard cost', situation: 'They pay dearly for what they took.', mandate: ['Make the cost land and sting.', 'Strip away the easy version of success.'], exit: 'They turn back toward the familiar world, marked by the cost.' },
            { title: 'The Return', genre: 'changed homecoming', situation: 'They come back to where they started — but altered.', mandate: ['Mirror the opening, now off-key.', 'Show what the journey took and gave.'], exit: 'The change becomes visible and settles into a new normal.' },
            { title: 'Changed', genre: 'new equilibrium', situation: 'A new normal, carrying what was learned.', mandate: ['Pay off the opening lack.', 'Let the transformation rest.'], exit: '' },
        ],
    },

    kishotenketsu: {
        name: 'Kishōtenketsu (no-conflict 4-act)', mode: 'world', ladder: [
            { title: 'Ki — Introduction', genre: 'gentle establishment', situation: 'Characters, place, and mood are established. No conflict required.', mandate: ['Let the scene simply be; observe, do not pressure.', 'Trust mood and detail over tension.'], exit: 'The situation is established and begins to develop or deepen.' },
            { title: 'Shō — Development', genre: 'quiet deepening', situation: 'The established situation develops; texture accumulates.', mandate: ['Deepen without manufacturing conflict.', 'Follow curiosity and small change.'], exit: 'An unexpected element, shift, or new angle enters that recontextualizes things.' },
            { title: 'Ten — The Turn', genre: 'recontextualizing turn', situation: 'A surprising, often oblique element arrives — a turn, not a clash.', mandate: ['Introduce the unexpected; do NOT force it into conflict.', 'Let it reframe what came before.'], exit: 'The turn and the earlier strands begin to relate and resolve.' },
            { title: 'Ketsu — Reconciliation', genre: 'harmonized close', situation: 'The pieces harmonize; a new understanding settles.', mandate: ['Integrate the turn with the whole.', 'Close on resonance, not victory.'], exit: '' },
        ],
    },
};

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
        // SAFE IDLE DEFAULT: no ladder. Chronicler does nothing until you load one,
        // so it can never fight a story it wasn't authored for.
        m[EXT_ID] = { pointer: 0, ladder: [], mode: 'world' };
    }
    const cs = m[EXT_ID];
    if (!Array.isArray(cs.ladder)) cs.ladder = [];
    if (typeof cs.pointer !== 'number') cs.pointer = 0;
    cs.pointer = clampPointer(cs.pointer, cs.ladder.length || 1);
    if (cs.mode !== 'world' && cs.mode !== 'character' && cs.mode !== 'off') cs.mode = 'world';
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

function ladderEmpty() { return !chatState().ladder.length; }
function getMode() { return chatState().mode; }
function setMode(m) {
    if (m !== 'world' && m !== 'character' && m !== 'off') return;
    chatState().mode = m;
    saveChatState();
    refreshPanel();
    applyInjection(); // a mode change can flip whether we inject
}
function loadDemo() {
    const cs = chatState();
    cs.ladder = deepCopy(DEMO_LADDER);
    cs.pointer = 0;
    cs.mode = 'world';
    cs._walker = { lastEvalAt: -999, last: null };
    saveChatState();
    refreshPanel();
    applyInjection();
}
function clearLadder() {
    const cs = chatState();
    cs.ladder = [];
    cs.pointer = 0;
    cs._walker = { lastEvalAt: -999, last: null };
    saveChatState();
    clearInjection();
    refreshPanel();
}

// ── Templates + saved library (2a / 2c) ──
// Active ladder lives per-chat (chatMetadata). The library lets you SAVE a
// ladder and reload it elsewhere — scoped to a character (travels with them =
// character mode) or global (everywhere). Library is stored in global settings.

function currentCharKey() {
    const c = ctx();
    try {
        if (c.groupId) return 'group:' + c.groupId;
        const id = (c.characterId !== undefined && c.characterId !== null) ? c.characterId : c.this_chid;
        const char = c.characters?.[id];
        if (char) return 'char:' + (char.avatar || char.name || String(id));
    } catch (_) { /* */ }
    return 'char:' + (c.name2 || 'unknown');
}

function getLibrary() {
    const s = settings();
    if (!Array.isArray(s.library)) s.library = [];
    return s.library;
}

function applyLadderInto(ladder, mode) {
    const cs = chatState();
    cs.ladder = deepCopy(ladder);
    cs.pointer = 0;
    cs.mode = (mode === 'character' || mode === 'world' || mode === 'off') ? mode : 'world';
    cs._walker = { lastEvalAt: -999, last: null };
    saveChatState();
    refreshPanel();
    applyInjection();
}

function loadTemplate(key) {
    const t = TEMPLATES[key];
    if (!t) return false;
    applyLadderInto(t.ladder, t.mode);
    return true;
}
function loadSaved(id) {
    const e = getLibrary().find(x => x.id === id);
    if (!e) return false;
    applyLadderInto(e.ladder, e.mode);
    return true;
}
function saveCurrent(name, scope) {
    const cs = chatState();
    if (!cs.ladder.length) return { ok: false, error: 'No ladder to save.' };
    const entry = {
        id: 'lib_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: String(name || '').trim() || ('Ladder ' + new Date().toLocaleDateString()),
        scope: scope === 'character' ? 'character' : 'global',
        charKey: scope === 'character' ? currentCharKey() : null,
        mode: cs.mode,
        ladder: deepCopy(cs.ladder),
    };
    getLibrary().push(entry);
    saveSettings();
    refreshPanel();
    return { ok: true, entry };
}
function deleteSaved(id) {
    const lib = getLibrary();
    const i = lib.findIndex(x => x.id === id);
    if (i === -1) return false;
    lib.splice(i, 1);
    saveSettings();
    refreshPanel();
    return true;
}
function libraryForPicker() {
    const key = currentCharKey();
    return getLibrary().filter(e => e.scope === 'global' || (e.scope === 'character' && e.charKey === key));
}
function pickerOptionsHtml() {
    const tpl = Object.keys(TEMPLATES)
        .map(k => `<option value="tpl:${k}">Template · ${esc(TEMPLATES[k].name)}</option>`).join('');
    const lib = libraryForPicker();
    const saved = lib.length
        ? `<option disabled>──── saved ────</option>` +
          lib.map(e => `<option value="lib:${e.id}">${esc(e.name)}${e.scope === 'character' ? ' · char' : ' · global'}</option>`).join('')
        : '';
    return `<option value="">— pick a ladder —</option>${tpl}${saved}`;
}

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
    // Only WORLD mode injects a phase mandate. Character mode drives the Codex
    // era flip instead (no world injection); off mode and an empty ladder inject
    // nothing — so Chronicler stays silent until it's pointed at a story.
    if (!settings().enabled || getMode() !== 'world' || ladderEmpty()) { clearInjection(); return; }
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

async function callUtility(prompt, maxTokens) {
    const c = ctx();
    if (!c.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService unavailable');
    const profileId = resolveProfileId(settings().walkerProfile);
    if (!profileId) throw new Error('no connection profile resolved');
    const res = await c.ConnectionManagerRequestService.sendRequest(
        profileId,
        [{ role: 'user', content: prompt }],
        maxTokens || settings().tokenBudget || 2000,
        { extractData: true, includePreset: true, includeInstruct: false },
        {},
    );
    return (res && typeof res === 'object' && 'content' in res) ? res.content : res;
}

// ── Generator (2b): builds a ladder grounded in the ACTUAL story ──
// Reads the siblings (card, persona, Lexicon world facts, recent chat) so the
// spine fits the established world instead of inventing generic genre furniture.
// The premise is optional flavor layered ON TOP of that context, not a replacement.
function clip(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function gatherStoryContext() {
    const c = ctx();
    const parts = [];
    // Character card — the core world/cast grounding
    try {
        const id = (c.characterId !== undefined && c.characterId !== null) ? c.characterId : c.this_chid;
        const char = c.characters?.[id];
        if (char) {
            if (char.name) parts.push(`Character: ${char.name}`);
            if (char.description) parts.push(`Description: ${clip(char.description, 900)}`);
            if (char.scenario) parts.push(`Scenario: ${clip(char.scenario, 400)}`);
            if (char.personality) parts.push(`Personality: ${clip(char.personality, 300)}`);
        }
    } catch (_) { /* */ }
    // User persona
    try {
        const pd = c.power_user?.persona_description || c.personaDescription || '';
        if (pd) parts.push(`User persona: ${clip(pd, 300)}`);
    } catch (_) { /* */ }
    // Lexicon — established world facts
    try {
        const lex = window.LexiconAPI;
        if (lex && lex.isActive?.() !== false) {
            let block = '';
            if (typeof lex.getLoreContextBlock === 'function') block = lex.getLoreContextBlock();
            if (!block && typeof lex.getEntries === 'function') {
                const es = lex.getEntries({}) || [];
                block = es.slice(0, 12).map(e => `${e.title || e.key || ''}: ${clip(e.content || e.value || '', 180)}`).join('\n');
            }
            if (block) parts.push(`Established world facts (Lexicon):\n${clip(block, 1500)}`);
        }
    } catch (_) { /* */ }
    // Recent scene — the setting/tone actually in play right now
    try {
        const chat = c.chat || [];
        const msgs = chat.filter(m => m && !m.is_system).slice(-4);
        if (msgs.length) {
            const name1 = c.name1 || 'User', name2 = c.name2 || 'Character';
            const recent = msgs.map(m => `${m.is_user ? name1 : (m.name || name2)}: ${clip(m.mes, 300)}`).join('\n');
            parts.push(`Recent scene (the setting actually in play):\n${recent}`);
        }
    } catch (_) { /* */ }
    return parts.join('\n\n');
}

function buildGenPrompt(premise, n, context) {
    const lines = [
        'You are a story-structure author. Build a beat ladder (a plot / world spine) that fits the ESTABLISHED story below.',
        '',
    ];
    if (context) {
        lines.push('ESTABLISHED CONTEXT — the ladder MUST fit this exact world, setting, and cast. Do NOT relocate the story, invent a new setting, swap the genre\'s default backdrop in, or contradict any of these facts. If the scene is a modern city, the arc happens in that city:');
        lines.push(context);
        lines.push('');
    }
    if (premise) {
        lines.push(`Creative direction / tone to shape the arc toward: ${premise}`);
        lines.push('Treat this as flavor layered ONTO the established context above — bend the existing world toward this tone, do not replace the world with the tone\'s clichés.');
        lines.push('');
    }
    lines.push(
        'Output ONLY a JSON array of beats — no preamble, no commentary, no markdown fences. Each beat is an object:',
        '{ "title": "short beat name", "genre": "tonal register for this beat", "situation": "one sentence: what is true in the world at this beat", "mandate": ["2-3 imperative directives for writing this beat"], "exit": "the observable on-screen condition that, once met, advances the story to the next beat" }',
        '',
        `Produce ${n} beats in dramatic order. The FINAL beat must have "exit": "" (terminal).`,
        'Keep the beats COARSE — arc-level turning points (think an 8-beat Story Circle), where each beat spans MULTIPLE scenes of play. Do NOT write a fine, scene-by-scene shot list: too many small beats turn every rung into a lock and strangle pacing. Fewer, bigger beats are better.',
        'Exits must be judgeable from what happens on-screen — concrete events, not vague mood. Mandates are imperative ("Keep the dread close," never "it is dreadful").',
    );
    return lines.join('\n');
}

async function generateLadder(premise, count) {
    const c = ctx();
    if (!c.ConnectionManagerRequestService) return { ok: false, error: 'No background connection available (set a profile in the Walker section).' };
    if (!resolveProfileId(settings().walkerProfile)) return { ok: false, error: 'No connection profile resolved — set one in the Walker section.' };
    const context = gatherStoryContext();
    premise = String(premise || '').trim();
    if (!context && !premise) return { ok: false, error: 'Nothing to build from — give a premise, or open this in a chat with a card / world / scene.' };
    const n = Math.max(4, Math.min(12, (count | 0) || 8)); // coarse: arc-level beats, capped low
    let raw;
    try { raw = await callUtility(buildGenPrompt(premise, n, context), 4000); }
    catch (e) { return { ok: false, error: e?.message || String(e) }; }
    let txt = String(raw == null ? '' : raw).replace(/```json|```/g, '').trim();
    const m = txt.match(/\[[\s\S]*\]/);
    if (m) txt = m[0];
    const res = loadLadder(txt);
    if (!res.ok) return { ok: false, error: 'Generated text was not a usable ladder. ' + res.error };
    const cs = chatState();
    cs.mode = 'world';            // generated spines are world-tone by default
    saveChatState();
    applyInjection();
    refreshPanel();
    return { ok: true };
}

// force=true bypasses the cooldown (used by the "Check now" button / slash).
async function runWalker(mesId, force = false) {
    const s = settings();
    if (!s.enabled || !s.walkerEnabled) return;
    if (walkerInFlight) return;

    const cs = chatState();
    if (cs.mode === 'off' || !cs.ladder.length) return; // paused or idle
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
const PANEL_STYLE = `position:fixed;left:0;top:0;width:min(360px, calc(100vw - 16px));max-height:84vh;overflow-y:auto;background:rgba(18,22,32,0.97);border:1px solid rgba(150,170,210,0.35);border-radius:12px;padding:12px;z-index:${Z};color:#e6ecf5;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.55);display:none;`;
const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;';
const BTN = 'background:#222c40;color:#e6ecf5;border:1px solid rgba(150,170,210,0.35);border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;';
const TA = 'width:100%;box-sizing:border-box;background:#141926;color:#cfd8e8;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:6px;font-size:11px;font-family:monospace;min-height:90px;';
const NUM = 'background:#141926;color:#e6ecf5;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:3px 6px;font-size:12px;width:70px;';
const SEL = 'background:#141926;color:#e6ecf5;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:3px 6px;font-size:12px;';
const TXT = 'background:#141926;color:#e6ecf5;border:1px solid rgba(150,170,210,0.3);border-radius:6px;padding:3px 6px;font-size:12px;width:120px;';
const TABBTN = 'flex:1;background:transparent;color:#aeb8cc;border:none;border-bottom:2px solid transparent;padding:7px 4px;font-size:12px;cursor:pointer;';
const TABON = 'color:#e6ecf5;border-bottom-color:rgba(190,150,90,0.9);font-weight:bold;';

let activeTab = 'now';   // session-only; which panel tab is showing

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

function modeBtn(cs, value, label) {
    const on = cs.mode === value;
    const sel = on ? 'background:#3a4a6a;border-color:rgba(190,150,90,0.85);font-weight:bold;' : '';
    return `<button class="chron-mode-btn" data-mode="${value}" style="${BTN}flex:1;font-size:11px;padding:4px 6px;${sel}">${label}</button>`;
}

function tabBtn(tab, label) {
    const on = activeTab === tab;
    return `<button class="chron-tab" data-tab="${tab}" style="${TABBTN}${on ? TABON : ''}">${label}</button>`;
}

function panelHtml() {
    const s = settings();
    const cs = chatState();
    const empty = !cs.ladder.length;
    const r = cs.ladder[cs.pointer] || {};
    const atStart = cs.pointer <= 0;
    const atEnd = cs.pointer >= cs.ladder.length - 1;
    const mandate = (r.mandate || []).map(m => `<li style="margin:2px 0;">${esc(m)}</li>`).join('');
    const last = cs._walker?.last ? esc(cs._walker.last) : '—';

    const modeHint = cs.mode === 'world'
        ? 'World — injects the mandate each turn.'
        : cs.mode === 'character'
            ? "Character — drives the character's Codex era (needs the patched bridge + matching Codex states); injects nothing."
            : 'Off — paused. Injects nothing, walker idle. Ladder kept.';

    const modeRow = `
        <div style="display:flex;gap:6px;margin:8px 0 2px;">
            ${modeBtn(cs, 'off', 'Off')}
            ${modeBtn(cs, 'world', 'World')}
            ${modeBtn(cs, 'character', 'Character')}
        </div>
        <div style="opacity:0.55;font-size:10px;margin:0 0 6px;">${modeHint}</div>`;

    // ───────── NOW: where are we right now ─────────
    const rungDisplay = empty
        ? `<div style="text-align:center;padding:14px 4px;">
               <div style="opacity:0.8;font-size:12px;">No ladder loaded — idle.</div>
               <div style="opacity:0.5;font-size:10px;margin-top:4px;">Open the <b>Build</b> tab to load a template or generate one.</div>
           </div>`
        : `<div style="margin:6px 0;">
               <div style="display:flex;align-items:baseline;justify-content:space-between;">
                   <b style="font-size:14px;">${esc(r.title || '—')}</b>
                   <span style="opacity:0.6;font-size:11px;">${esc(rungLine(cs))}</span>
               </div>
               ${r.genre ? `<div style="opacity:0.7;font-size:11px;margin-top:1px;">${esc(r.genre)}</div>` : ''}
               ${r.situation ? `<div style="margin-top:6px;font-size:12px;">${esc(r.situation)}</div>` : ''}
               ${mandate ? `<ul style="margin:6px 0 0 0;padding-left:18px;opacity:0.85;font-size:11px;">${mandate}</ul>` : ''}
               ${r.exit ? `<div style="margin-top:7px;font-size:11px;opacity:0.7;"><b>Exit →</b> ${esc(r.exit)}</div>`
                        : `<div style="margin-top:7px;font-size:11px;opacity:0.5;">terminal rung — walker idle here</div>`}
           </div>
           <div style="display:flex;gap:8px;margin:10px 0 2px;">
               <button id="chron-back" style="${BTN}flex:1;${atStart ? 'opacity:0.4;' : ''}">◀ Back</button>
               <button id="chron-adv" style="${BTN}flex:1;${atEnd ? 'opacity:0.4;' : ''}">Advance ▶</button>
           </div>`;
    const nowPane = `
        <div style="${ROW}"><span>Enabled</span><input type="checkbox" id="chron-enabled" ${s.enabled ? 'checked' : ''}></div>
        ${modeRow}
        ${rungDisplay}`;

    // ───────── LADDER: the whole spine + raw JSON ─────────
    const rungList = empty
        ? `<div style="opacity:0.6;font-size:12px;text-align:center;padding:12px 4px;">No ladder. Load or generate one in <b>Build</b>.</div>`
        : `<div style="margin:2px 0;">` + cs.ladder.map((rg, i) => {
            const cur = i === cs.pointer;
            return `<div style="display:flex;gap:7px;padding:5px 0;border-bottom:1px solid rgba(150,170,210,0.1);${cur ? '' : 'opacity:0.6;'}">
                <span style="width:14px;text-align:right;font-size:11px;opacity:0.7;">${cur ? '▶' : (i + 1)}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;${cur ? 'font-weight:bold;' : ''}">${esc(rg.title || '—')}</div>
                    ${rg.exit ? `<div style="font-size:10px;opacity:0.6;">→ ${esc(clip(rg.exit, 72))}</div>` : `<div style="font-size:10px;opacity:0.45;">terminal</div>`}
                </div>
            </div>`;
        }).join('') + `</div>`;
    const ladderPane = `
        ${rungList}
        <div style="border-top:1px solid rgba(150,170,210,0.2);margin-top:8px;padding-top:6px;">
            <div id="chron-load-toggle" style="cursor:pointer;opacity:0.8;font-size:12px;">▾ Edit as JSON</div>
            <div id="chron-load-box" style="margin-top:6px;">
                <textarea id="chron-ladder-json" style="${TA}" placeholder='[ { "title": "Calm", "situation": "…", "mandate": ["…"], "exit": "what must happen to advance" }, … ]'></textarea>
                <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
                    <button id="chron-load-apply" style="${BTN}flex:1;">Apply</button>
                    ${empty ? '' : `<button id="chron-load-export" style="${BTN}">Copy</button>`}
                    ${empty ? '' : `<button id="chron-load-clear" style="${BTN}color:#e6a0a0;">Clear</button>`}
                </div>
                <div id="chron-load-msg" style="font-size:11px;opacity:0.75;margin-top:5px;"></div>
            </div>
        </div>`;

    // ───────── BUILD: templates, library, generator ─────────
    const libSection = `
        <div style="font-size:11px;opacity:0.8;margin-bottom:4px;">📚 Load a ladder</div>
        <div style="display:flex;gap:6px;">
            <select id="chron-lib-select" style="${SEL}flex:1;min-width:0;">${pickerOptionsHtml()}</select>
            <button id="chron-lib-load" style="${BTN}">Load</button>
        </div>
        <button id="chron-lib-del" style="${BTN}font-size:11px;color:#e6a0a0;margin-top:5px;width:100%;box-sizing:border-box;">Delete selected (saved only)</button>
        ${empty ? '' : `
        <div style="margin-top:8px;border-top:1px dashed rgba(150,170,210,0.2);padding-top:6px;">
            <div style="font-size:11px;opacity:0.8;margin-bottom:4px;">💾 Save current ladder</div>
            <input type="text" id="chron-save-name" placeholder="name this ladder…" style="${TXT}width:100%;box-sizing:border-box;margin-bottom:5px;">
            <div style="display:flex;gap:6px;">
                <select id="chron-save-scope" style="${SEL}flex:1;min-width:0;">
                    <option value="character">This character (travels)</option>
                    <option value="global">Global (everywhere)</option>
                </select>
                <button id="chron-save-btn" style="${BTN}">Save</button>
            </div>
        </div>`}
        <div id="chron-lib-msg" style="font-size:11px;opacity:0.75;margin-top:5px;"></div>`;

    const genSection = `
        <div style="border-top:1px solid rgba(150,170,210,0.2);margin-top:8px;padding-top:8px;">
            <div style="font-size:11px;opacity:0.85;margin-bottom:4px;">✨ Generate a ladder</div>
            <textarea id="chron-gen-premise" style="${TA}min-height:54px;" placeholder="optional: a tone or direction (e.g. 'gothic vampire thriller'). Leave blank to build straight from the card, world & scene."></textarea>
            <div style="display:flex;gap:6px;align-items:center;margin-top:5px;">
                <span style="font-size:11px;opacity:0.7;">beats</span>
                <input type="number" id="chron-gen-count" value="8" min="4" max="12" step="1" style="${NUM}width:56px;">
                <button id="chron-gen-btn" style="${BTN}flex:1;">Generate</button>
            </div>
            <div id="chron-gen-msg" style="font-size:11px;opacity:0.7;margin-top:5px;">Reads your card, world &amp; recent scene; premise is extra steer. Uses the Walker's profile.</div>
        </div>`;
    const buildPane = `${libSection}${genSection}`;

    // ───────── WALKER: auto-advance controls ─────────
    const walkerPane = `
        <div style="${ROW}"><span>Auto-advance</span><input type="checkbox" id="chron-walk-en" ${s.walkerEnabled ? 'checked' : ''}></div>
        <div style="${ROW}"><span>Profile</span><input type="text" id="chron-walk-profile" value="${esc(s.walkerProfile)}" style="${TXT}"></div>
        <div style="${ROW}"><span>Token budget</span><input type="number" id="chron-walk-budget" value="${s.tokenBudget}" min="256" step="256" style="${NUM}"></div>
        <div style="${ROW}"><span>Min confidence</span><input type="number" id="chron-walk-conf" value="${s.minConfidence}" min="0" max="1" step="0.05" style="${NUM}"></div>
        <div style="${ROW}"><span>Cooldown (msgs)</span><input type="number" id="chron-walk-cd" value="${s.cooldownMessages}" min="0" step="1" style="${NUM}"></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
            <button id="chron-walk-check" style="${BTN}flex:1;">Check now</button>
            <span style="font-size:11px;opacity:0.6;">last: ${last}</span>
        </div>
        <div style="opacity:0.5;font-size:10px;margin-top:8px;">Prefer a non-reasoning utility profile (e.g. GLM-4.7). Reasoning models spend the budget on hidden thinking first — raise it to 4000+ if checks get cut off.</div>`;

    const pane = (tab, html) => `<div class="chron-pane" data-tab="${tab}" style="display:${activeTab === tab ? 'block' : 'none'};">${html}</div>`;

    return `
    <div id="chronicler-panel" style="${PANEL_STYLE}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <b style="font-size:14px;">📖 Chronicler</b>
            <span id="chron-close" style="cursor:pointer;opacity:0.7;padding:2px 6px;">✕</span>
        </div>
        <div style="display:flex;gap:2px;border-bottom:1px solid rgba(150,170,210,0.2);margin-bottom:8px;">
            ${tabBtn('now', 'Now')}${tabBtn('ladder', 'Ladder')}${tabBtn('build', 'Build')}${tabBtn('walker', 'Walker')}
        </div>
        ${pane('now', nowPane)}
        ${pane('ladder', ladderPane)}
        ${pane('build', buildPane)}
        ${pane('walker', walkerPane)}
    </div>`;
}

function switchTab(tab) {
    activeTab = tab;
    const panel = document.getElementById('chronicler-panel');
    if (!panel) return;
    panel.querySelectorAll('.chron-pane').forEach(p => {
        p.style.display = (p.getAttribute('data-tab') === tab) ? 'block' : 'none';
    });
    panel.querySelectorAll('.chron-tab').forEach(b => {
        const on = b.getAttribute('data-tab') === tab;
        b.style.color = on ? '#e6ecf5' : '#aeb8cc';
        b.style.borderBottomColor = on ? 'rgba(190,150,90,0.9)' : 'transparent';
        b.style.fontWeight = on ? 'bold' : 'normal';
    });
    positionPanel();
}

let chronOutsideHandler = null;

function bindPanelEvents() {
    $('#chron-close').on('click', closePanel);
    $('.chron-tab').on('click', function () { switchTab(this.getAttribute('data-tab')); });
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
    $('#chron-load-clear').on('click', function () {
        clearLadder();
        try { toastr.info('Ladder cleared — chat is idle.', '📖 Chronicler', { timeOut: 2500 }); } catch (_) { /* */ }
    });

    // Mode switch
    $('.chron-mode-btn').on('click', function () {
        setMode(this.getAttribute('data-mode'));
    });
    // Load demo (idle state)
    $('#chron-load-demo').on('click', function () {
        loadDemo();
        try { toastr.info('Demo zombie ladder loaded (World mode).', '📖 Chronicler', { timeOut: 2500 }); } catch (_) { /* */ }
    });

    // Library: load / delete / save
    $('#chron-lib-load').on('click', function () {
        const val = String($('#chron-lib-select').val() || '');
        const msg = document.getElementById('chron-lib-msg');
        if (!val) { if (msg) { msg.textContent = 'Pick a ladder first.'; msg.style.color = '#e6a0a0'; } return; }
        let ok = false, label = '';
        if (val.startsWith('tpl:')) { ok = loadTemplate(val.slice(4)); label = TEMPLATES[val.slice(4)]?.name || 'template'; }
        else if (val.startsWith('lib:')) { const e = getLibrary().find(x => x.id === val.slice(4)); ok = loadSaved(val.slice(4)); label = e?.name || 'saved ladder'; }
        if (ok) { try { toastr.success(`Loaded “${label}”.`, '📖 Chronicler', { timeOut: 2500 }); } catch (_) { /* */ } }
    });
    $('#chron-lib-del').on('click', function () {
        const val = String($('#chron-lib-select').val() || '');
        const msg = document.getElementById('chron-lib-msg');
        if (!val.startsWith('lib:')) { if (msg) { msg.textContent = 'Only saved ladders can be deleted (templates are built in).'; msg.style.color = '#e6a0a0'; } return; }
        deleteSaved(val.slice(4));
        try { toastr.info('Saved ladder deleted.', '📖 Chronicler', { timeOut: 2200 }); } catch (_) { /* */ }
    });
    $('#chron-save-btn').on('click', function () {
        const name = String($('#chron-save-name').val() || '');
        const scope = String($('#chron-save-scope').val() || 'character');
        const res = saveCurrent(name, scope);
        const msg = document.getElementById('chron-lib-msg');
        if (msg) {
            msg.textContent = res.ok ? `✓ Saved “${res.entry.name}” (${res.entry.scope === 'character' ? 'this character' : 'global'}).` : '✗ ' + res.error;
            msg.style.color = res.ok ? '#9fd6a0' : '#e6a0a0';
        }
    });

    // Generator (2b)
    $('#chron-gen-toggle').on('click', function () {
        const box = document.getElementById('chron-gen-box');
        if (!box) return;
        box.style.display = (box.style.display === 'none') ? 'block' : 'none';
    });
    $('#chron-gen-btn').on('click', async function () {
        const premise = String($('#chron-gen-premise').val() || '').trim();
        const count = parseInt($('#chron-gen-count').val(), 10) || 8;
        const msg = document.getElementById('chron-gen-msg');
        if (msg) { msg.textContent = 'Generating from context…'; msg.style.color = '#ccd4e6'; }
        const btn = this; btn.disabled = true; btn.textContent = '…';
        try {
            const res = await generateLadder(premise, count);
            const m2 = document.getElementById('chron-gen-msg'); // panel may have rebuilt on success
            if (m2) {
                m2.textContent = res.ok ? '✓ Generated and loaded (World mode).' : '✗ ' + res.error;
                m2.style.color = res.ok ? '#9fd6a0' : '#e6a0a0';
            } else if (!res.ok) {
                try { toastr.warning(res.error, '📖 Chronicler'); } catch (_) { /* */ }
            }
        } finally {
            const b = document.getElementById('chron-gen-btn');
            if (b) { b.disabled = false; b.textContent = 'Generate'; }
        }
    });
}

function positionPanel() {
    const panel = document.getElementById('chronicler-panel');
    const fab = fabEl();
    if (!panel || !fab) return;
    const r = fab.getBoundingClientRect();
    const measured = panel.getBoundingClientRect().width;
    const pw = measured || Math.min(360, window.innerWidth - 16);
    let left = r.right + 8;                                   // prefer just right of the FAB
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8; // would overflow → pin to right margin
    left = Math.max(8, left);                                 // never clip the left edge
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
        // The Codex bridge reads this. It returns an era ONLY in character mode —
        // so world/off mode never flips a character state, and character mode does.
        getActiveEra: () => (settings().enabled && getMode() === 'character' && !ladderEmpty()
            ? (activeRung()?.era || activeRung()?.title || null) : null),
        getMode: () => getMode(),
        setMode: (m) => setMode(m),
        getActiveRung: () => { const r = activeRung(); return r ? { ...r } : null; },
        getPointer: () => chatState().pointer,
        getRungCount: () => chatState().ladder.length,
        getLadder: () => deepCopy(chatState().ladder),
        getWorldPhaseBlock: () => buildPhaseBlock(),
        advance: () => step(+1),
        retreat: () => step(-1),
        goTo: (i) => goTo(i),
        checkNow: () => runWalker(-1, true),   // force a walker evaluation
        listTemplates: () => Object.keys(TEMPLATES).map(k => ({ key: k, name: TEMPLATES[k].name })),
        loadTemplate: (k) => loadTemplate(k),
        saveLadder: (name, scope) => saveCurrent(name, scope),
        generate: (premise, count) => generateLadder(premise, count),
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
        `enabled: ${s.enabled} | mode: ${cs.mode} | walker: ${s.walkerEnabled}`,
        ladderEmpty()
            ? 'ladder: (empty — idle, injects nothing)'
            : `pointer: ${cs.pointer} (${rungLine(cs)}) — ${r ? (r.era || r.title) : 'none'}`,
        `output: ${ladderEmpty() ? 'none' : (cs.mode === 'world' ? 'injecting mandate' : cs.mode === 'character' ? 'driving Codex era (getActiveEra)' : 'paused')}`,
        ladderEmpty() ? '' : `exit watched: ${r && r.exit ? '“' + r.exit.slice(0, 55) + (r.exit.length > 55 ? '…' : '') + '”' : '(terminal — idle)'}`,
        `walker last: ${cs._walker?.last || '—'} | in-flight: ${walkerInFlight}`,
        `profile: ${s.walkerProfile} → ${profId ? 'resolved ✓' : '❌ unresolved'}`,
        `transport: ${ctx().ConnectionManagerRequestService ? 'ConnectionManagerRequestService ✓' : '❌ unavailable'}`,
        `budget: ${s.tokenBudget} | minConf: ${s.minConfidence} | cooldown: ${s.cooldownMessages}`,
        fabLine,
    ].filter(Boolean).join('<br>');
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
