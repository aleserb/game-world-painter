// The agent's changes as units the user sees on a card over the map (js/agent.js routes the changing calls here).
// begin_change … end_change groups calls into one change; a call alone is one too. Each can carry the agent's text
// (title, description, a comment per call), shown on the card and in the Activity.
// Review mode (AI Agent → Settings, on by default): a change is a proposal. It is applied, so the map shows it, but it
// is held: not saved, its layers are not edited by the user, its undo steps are not undone one by one. The user
// accepts it (one undo step), asks for changes (with a comment, the change is undone) or rejects it (undone). The
// agent gets the decision as the result of its call, or later with wait_for_review.
// Without review mode a change applies at once; a group becomes one undo step, and the card shows what was done.
(function (ME) {
'use strict';

const A = () => ME.app;
const fail = msg => { throw new ME.agentInternals.ToolError(msg); };
const DEFAULT_WAIT = 45; // seconds a call waits for the user (some agents give up on a call after 60 s)
const MAX_WAIT = 110;
const SHOW_DONE = 20000; // ms a finished change stays on the card (longer while the pointer is on it)
let nextId = 1;

const R = ME.agentReview = {
  active: null, // the change being made ('open') or the proposal waiting for the user ('pending')
  shown: null, // a finished change (review mode off) on the card
  list: [], // every change of this session, newest first
  collecting: null, // the change the current tool call adds to

  /** Is this layer held by the active proposal? */
  holds(layer) { return !!(R.active?.review && layer && R.active.layers.has(layer)); },
  /** Does the active proposal change the layer list or settings (metadata.json)? */
  holdsStructure() { return !!(R.active?.review && R.active.meta); },
  /** Is this undo step part of the active proposal? */
  owns(entry) { return !!(R.active?.review && entry && R.active.entries.includes(entry)); },
};

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

function create(title, client, single, review, active = true) {
  const P = {
    id: nextId++, title, description: '', client: client?.name || 'agent', single, review, status: 'open', created: new Date(),
    entries: [], layers: new Set(), meta: false, marks: [], changes: [], results: [], before: false, feedback: '', waiters: [],
  };
  if (active) { R.active = P; hideDone(); }
  R.list.unshift(P);
  if (R.list.length > 100) R.list.length = 100;
  return P;
}

const label = e => String(e.label || '').replace(/^AI: /, '');
const what = P => (P.review ? 'proposal' : 'change');

/** Runs a changing tool call as (part of) a change. exec() runs the tool. Returns {result, later?}: later resolves to
 *  the result with the user's decision (a proposal of one call waits for it). */
R.run = async (call, exec, { review = true, comment = '' } = {}) => {
  let P = R.active;
  if (P?.status === 'pending') {
    fail(`Your proposal #${P.id} ("${P.title}") is waiting for the user's review. Call wait_for_review (id ${P.id}) and act on the decision before changing more.`);
  }
  if (!P && !review) return direct(call, exec, comment);
  const single = !P;
  if (single) P = create(call.tool.replace(/_/g, ' '), call.client, true, true);
  const collect = [], mv = A().S.metaVersion, had = new Set(A().S.layers);
  ME.agentCollect = collect;
  if (P.review) ME.agentApplying = true;
  R.collecting = P;
  let result;
  try {
    result = await exec();
  } catch (e) {
    if (P.review) revertEntries(collect); // a failed call leaves nothing of a proposal behind
    else P.entries.push(...collect);
    if (single) discard(P);
    throw e;
  } finally {
    ME.agentCollect = null;
    ME.agentApplying = false;
    R.collecting = null;
  }
  for (const e of collect) { P.entries.push(e); if (e.layer) P.layers.add(e.layer); }
  for (const L of A().S.layers) if (!had.has(L)) P.layers.add(L); // a new layer is the proposal's too
  if (A().S.metaVersion !== mv) P.meta = true;
  const changed = collect.map(label).filter(Boolean);
  P.results.push(result.data);
  if (single) {
    if (!collect.length) { discard(P); return { result }; } // nothing changed (e.g. nothing to place)
    P.title = changed.join('; ');
    P.description = comment;
    P.changes = changed.map(l => ({ label: l }));
    submit(P);
    return { result, later: R.decision(P, DEFAULT_WAIT).then(d => withDecision(result, d, 'proposal')) };
  }
  if (changed.length) P.changes.push(...changed.map((l, k) => ({ label: l, comment: k === changed.length - 1 ? comment : '' })));
  else if (comment) P.changes.push({ label: call.tool.replace(/_/g, ' ') + ': nothing changed', comment });
  render();
  return { result: withDecision(result, { id: P.id, status: 'open', note: `Part of your open ${what(P)}: call end_change when it is complete.` }, what(P)) };
};

/** A change without review mode and outside begin_change … end_change: it applies; with a comment the card shows it. */
async function direct(call, exec, comment) {
  const collect = [];
  ME.agentCollect = collect;
  let result;
  try { result = await exec(); } finally { ME.agentCollect = null; }
  if (comment && collect.length) {
    const P = create(collect.map(label).filter(Boolean).join('; '), call.client, true, false, false);
    P.description = comment;
    P.entries = collect;
    finishDirect(P);
  }
  return { result };
}

function withDecision(result, d, key) {
  const data = result.data && typeof result.data === 'object' ? result.data : (result.text ? { text: result.text } : {});
  return { ...result, data: { ...data, [key]: d } };
}

function discard(P) {
  if (R.active === P) R.active = null;
  R.list = R.list.filter(x => x !== P);
  render();
}

function submit(P) {
  P.status = 'pending';
  P.submitted = new Date();
  render();
  ME.agent?.changed();
  ME.app.renderSaveState();
  R.show(P, true);
}

/** Many undo steps of a change -> one, named after it (only while they are the latest steps: else they stay apart). */
function mergeSteps(P) {
  const h = A().history, live = P.entries.filter(e => h.undo.includes(e));
  P.entries = live;
  if (live.length < 2) return;
  const top = h.undo.slice(-live.length);
  if (!top.every((e, k) => e === live[k])) return; // the user changed something in between
  const layers = [...new Set(live.map(e => e.layer).filter(Boolean))];
  const entry = {
    label: `AI: ${P.title}`, layers, content: live.some(e => e.content),
    undo: () => { for (const e of [...live].reverse()) e.undo(); },
    redo: () => { for (const e of live) e.redo(); },
  };
  if (layers.length === 1) entry.layer = layers[0];
  h.undo.splice(-live.length, live.length, entry);
  P.entries = [entry];
}

/** Resolves with the decision, or {status: 'pending'} after `seconds`. */
R.decision = (P, seconds) => {
  if (P.status !== 'pending' && P.status !== 'open') return Promise.resolve(decisionOf(P));
  return new Promise(resolve => {
    const w = { resolve, timer: setTimeout(() => { P.waiters = P.waiters.filter(x => x !== w); resolve(decisionOf(P)); }, Math.max(0, Math.min(MAX_WAIT, seconds)) * 1000) };
    P.waiters.push(w);
  });
};

function decisionOf(P) {
  const base = { id: P.id, status: P.status };
  if (P.status === 'pending') return { ...base, note: `The user has not decided yet. Call wait_for_review with {"id": ${P.id}} to keep waiting.` };
  if (P.status === 'open') return { ...base, note: `The ${what(P)} is open: add changes, then call end_change.` };
  if (P.status === 'accepted') return { ...base, note: 'The user accepted it: the changes are on the map and saved.' };
  if (P.status === 'changes_requested') return { ...base, feedback: P.feedback, note: 'The proposal was undone: nothing of it is on the map. Make a new proposal that follows the user\'s feedback.' };
  if (P.status === 'rejected') return { ...base, note: 'The user rejected it: it was undone, nothing of it is on the map. Do not repeat it; ask the user what they want if unsure.' };
  if (P.status === 'done') return { ...base, note: 'Applied (review mode is off): the user can undo it in one step.' };
  if (P.status === 'undone') return { ...base, note: 'The user undid this change.' };
  return { ...base, note: P.note || 'The proposal was dropped.' };
}

function decide(P, status, feedback = '') {
  if (P.status !== 'pending' && P.status !== 'open') return;
  if (status === 'accepted') {
    if (P.before) toggleBefore(P, false);
  } else {
    if (!P.before) revertEntries(P.entries);
    removeFromHistory(P.entries);
    if (A().S.sel.layer && P.layers.has(A().S.sel.layer)) A().select(null, []);
  }
  P.status = status;
  P.feedback = feedback;
  P.decided = new Date();
  if (R.active === P) R.active = null;
  if (status === 'accepted') mergeSteps(P); // one undo step
  for (const w of P.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(decisionOf(P)); }
  A().afterHistory();
  A().scheduleSave();
  render();
  ME.agent?.changed();
  A().toast(status === 'accepted' ? 'AI proposal accepted' : status === 'rejected' ? 'AI proposal rejected: undone' : status === 'withdrawn' ? 'The agent withdrew its proposal' : 'Sent to the agent; the proposal was undone', 2500);
}

/** A change without review: its steps become one undo step and the card shows it for a while. */
function finishDirect(P) {
  P.status = 'done';
  P.decided = new Date();
  if (R.active === P) R.active = null;
  mergeSteps(P);
  for (const w of P.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(decisionOf(P)); }
  A().renderSaveState();
  R.shown = P;
  render();
  ME.agent?.changed();
}

/** Undoes a finished change from its card: only while it is the latest in the app's history. */
function undoDone(P) {
  if (!canUndo(P)) return;
  for (let k = 0; k < P.entries.length; k++) A().undo();
  P.status = 'undone';
  hideDone();
  ME.agent?.changed();
}
const canUndo = P => P.entries.length > 0 && P.entries.every((e, k, all) => A().history.undo.at(k - all.length) === e);

let doneTimer = null;
function hideDone() {
  clearTimeout(doneTimer);
  if (!R.shown) return;
  R.shown = null;
  render();
}
function hideLater(ms = SHOW_DONE) { clearTimeout(doneTimer); doneTimer = setTimeout(hideDone, ms); }

/** The map before the proposal (true) or with it (false): to compare. */
function toggleBefore(P, before) {
  if (P.before === before) return;
  ME.agentApplying = true;
  try {
    if (before) for (const e of [...P.entries].reverse()) e.undo();
    else for (const e of P.entries) e.redo();
  } finally { ME.agentApplying = false; }
  P.before = before;
  A().afterHistory();
  render();
}

function revertEntries(entries) {
  ME.agentApplying = true;
  try { for (const e of [...entries].reverse()) e.undo(); } finally { ME.agentApplying = false; }
  removeFromHistory(entries);
}

function removeFromHistory(entries) {
  const set = new Set(entries), h = A().history;
  h.undo = h.undo.filter(e => !set.has(e));
  h.redo = h.redo.filter(e => !set.has(e));
}

/** The map was opened again (or another one): the change cannot be applied any more. revert: the map is still
 *  open (it is saved next): a proposal nobody accepted is undone first. */
R.drop = (why, { revert = false } = {}) => {
  hideDone();
  const P = R.active;
  if (!P) return;
  if (revert && P.review) {
    if (!P.before) revertEntries(P.entries); else removeFromHistory(P.entries);
    A().afterHistory();
  }
  P.status = 'dropped';
  P.note = `The ${what(P)} was dropped: ${why}.`;
  R.active = null;
  for (const w of P.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(decisionOf(P)); }
  render();
};

/** Brings the places of a change into view. */
R.show = (P, quiet) => {
  const box = marksBox(P);
  if (!box) return;
  const v = A().view, g = ME.agentInternals.G();
  const pad = Math.max(box[2] - box[0], box[3] - box[1], 20 * g.k) * 0.3;
  const [lo, hi] = v.limits(), W = box[2] - box[0] + 2 * pad, H = box[3] - box[1] + 2 * pad;
  const scale = Math.max(lo, Math.min(hi, Math.min(v.w / W, v.h / H)));
  const [x0, z0] = v.toWorld(0, 0), [x1, z1] = v.toWorld(v.w, v.h);
  const inView = box[0] >= x0 && box[1] >= z0 && box[2] <= x1 && box[3] <= z1;
  if (quiet && inView) return; // already in sight
  v.scale = Math.min(scale, Math.max(v.scale, scale / 4));
  const [sx, sy] = v.toScreen((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
  v.pan(v.w / 2 - sx, v.h / 2 - sy);
  A().saveUi();
  A().requestRender();
};

function marksBox(P) {
  const g = ME.agentInternals.G();
  let b = null;
  const add = r => { b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : [...r]; };
  for (const m of P.marks) {
    if (m.box) add(m.box);
    else if (m.mask) { const k = ME.agentInternals.bounds(g, m.mask); if (k.count) add(ME.agentInternals.worldBox(g, k)); }
  }
  return b;
}

/** The latest changes for the agent (get_user_context): what the user did with them. */
R.recent = (n = 5) => R.list.slice(0, n).map(P => ({ id: P.id, title: P.title, status: P.status, ...(P.feedback ? { feedback: P.feedback } : {}) }));

// ------------------------------------------------------------------------------------------------ tools

const T = ME.agentTools;

T.begin_change = (args, ctx) => {
  if (!ctx.canWrite) fail('The user lets the agent only read the map (AI Agent → Settings in the app). Ask them to allow changes.');
  const P0 = R.active;
  if (P0?.status === 'pending') fail(`Proposal #${P0.id} is still waiting for the user's review: call wait_for_review first.`);
  if (P0?.status === 'open') fail(`${what(P0) === 'proposal' ? 'Proposal' : 'Change'} #${P0.id} ("${P0.title}") is already open: add changes to it and call end_change.`);
  const P = create(clip(args.title, 120) || 'AI change', ctx.client, false, !!ctx.review);
  P.description = clip(args.description, 4000);
  render();
  return {
    data: {
      id: P.id, status: 'open', review_mode: !!ctx.review,
      note: ctx.review
        ? 'Now make the changes (each call adds to this proposal; the map shows them at once, held for the user), then call end_change: the user accepts, asks for changes or rejects it.'
        : 'Now make the changes (each call adds to this change; they apply at once), then call end_change: they become one undo step, shown to the user with your title and summary.',
    },
  };
};

T.end_change = (args, ctx) => {
  const P = R.active;
  if (!P || P.status !== 'open') {
    const last = R.list.find(x => !x.single);
    fail(last && ['rejected', 'dropped'].includes(last.status) ? `There is no open change: the user rejected #${last.id} ("${last.title}") while you were preparing it.` : 'There is no open change: call begin_change first.');
  }
  if (args.title) P.title = clip(args.title, 120);
  if (args.summary) P.description = clip(args.summary, 4000);
  if (!P.review) {
    if (!P.entries.some(e => A().history.undo.includes(e))) {
      discard(P);
      return { data: { change: { id: P.id, status: 'empty' }, note: 'Nothing on the map changed: the change was closed.' } };
    }
    finishDirect(P);
    return { data: { change: { id: P.id, status: 'done', changes: P.changes.map(c => c.label), undo_steps: P.entries.length }, note: 'Applied. The user sees your title and summary, and can undo it in one step.' } };
  }
  if (!P.entries.length) { discard(P); fail('The proposal has no changes: nothing to review. It was closed.'); }
  submit(P);
  return { deferred: R.decision(P, args.wait ?? DEFAULT_WAIT).then(d => ({ data: { proposal: d, changes: P.changes.map(c => c.label) } })) };
};

T.begin_proposal = T.begin_change; // the names before 0.3
T.submit_proposal = T.end_change;

T.wait_for_review = args => {
  const P = args.id != null ? R.list.find(x => x.id === args.id) : (R.active?.review ? R.active : null) || R.list.find(x => x.review) || R.list[0];
  if (!P) fail(args.id != null ? `No proposal #${args.id}` : 'There is no proposal');
  return { deferred: R.decision(P, args.wait ?? DEFAULT_WAIT).then(d => ({ data: { proposal: d } })) };
};

/** The agent's undo in review mode: withdraws the active proposal. */
R.withdraw = () => {
  const P = R.active;
  if (!P) fail('Review mode is on: the agent cannot undo accepted changes (the user can, with Ctrl+Z). There is no proposal to withdraw.');
  decide(P, 'withdrawn');
  return { data: { withdrawn: P.id } };
};

// ------------------------------------------------------------------------------------------------ the card over the map

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};

/** The agent's text: lines, "- " lists, **bold** and `code` (as text: no HTML). */
function richText(text, cls) {
  const box = el('div', { class: cls });
  let list = null;
  for (const line of String(text).split('\n')) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { if (!list) box.append(list = el('ul')); list.append(el('li', {}, ...inline(item[1]))); continue; }
    list = null;
    if (line.trim()) box.append(el('p', {}, ...inline(line.trim())));
  }
  return box;
}
function inline(s) {
  const out = [], re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let k = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > k) out.push(s.slice(k, m.index));
    out.push(m[1] != null ? el('b', {}, m[1]) : el('code', {}, m[2]));
    k = re.lastIndex;
  }
  if (k < s.length) out.push(s.slice(k));
  return out;
}

let card = null, changing = false, draft = '', shownFor = null;

// The card can be dragged by its head to another place over the map; the place is kept in this browser (double-click
// the head: back to the top right corner). It always stays inside the map.
const POS_KEY = 'gwp-ai-card';
let pos = (() => { try { const p = JSON.parse(localStorage.getItem(POS_KEY)); return p && isFinite(p.x) && isFinite(p.y) ? p : null; } catch { return null; } })();

function placeCard() {
  if (!card) return;
  if (!pos) { card.style.left = card.style.top = card.style.right = card.style.maxHeight = ''; return; }
  const st = card.parentElement.getBoundingClientRect(), head = card.querySelector('.head')?.offsetHeight || 24;
  const x = Math.max(0, Math.min(st.width - card.offsetWidth, pos.x)), y = Math.max(0, Math.min(st.height - head - 18, pos.y));
  Object.assign(card.style, { left: `${x}px`, top: `${y}px`, right: 'auto', maxHeight: `${Math.max(head + 18, st.height - y - 8)}px` });
}

function dragCard(e) {
  if (e.button !== 0 || !e.target.closest('.head') || e.target.closest('button')) return;
  e.preventDefault();
  const st = card.parentElement.getBoundingClientRect(), r = card.getBoundingClientRect(), off = [e.clientX - r.left, e.clientY - r.top];
  const [x0, y0] = [e.clientX, e.clientY];
  let moved = false;
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return; // a click, not a drag
    moved = true;
    card?.classList.add('dragging');
    pos = { x: ev.clientX - st.left - off[0], y: ev.clientY - st.top - off[1] };
    placeCard();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!card || !moved) return;
    card.classList.remove('dragging');
    pos = { x: parseFloat(card.style.left), y: parseFloat(card.style.top) }; // where it is seen
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

let stageWatch = null; // the map gets bigger or smaller (window, panels): the card stays inside

function resetCard(e) {
  if (!e.target.closest('.head') || e.target.closest('button')) return;
  pos = null;
  localStorage.removeItem(POS_KEY);
  placeCard();
}

function render() {
  const P = R.active || R.shown;
  if (!P) { card?.remove(); card = null; changing = false; draft = ''; shownFor = null; ME.app?.requestRender(); return; }
  if (!card) {
    card = el('div', { id: 'ai-proposal' });
    document.getElementById('stage').append(card);
    for (const t of ['pointerdown', 'wheel', 'keydown']) card.addEventListener(t, e => e.stopPropagation());
    card.addEventListener('pointerdown', dragCard);
    card.addEventListener('dblclick', resetCard);
    if (!stageWatch) (stageWatch = new ResizeObserver(() => placeCard())).observe(card.parentElement);
    card.addEventListener('pointerenter', () => { if (card.classList.contains('done')) clearTimeout(doneTimer); });
    card.addEventListener('pointerleave', () => { if (card.classList.contains('done')) hideLater(8000); });
  }
  if (shownFor !== P) { changing = false; draft = ''; shownFor = P; }
  const pending = P.status === 'pending', done = P.status === 'done';
  if (done) { if (!card.matches(':hover')) hideLater(); } else clearTimeout(doneTimer);
  const btn = (text, cls, onclick, title = '') => el('button', { type: 'button', class: cls, onclick, title }, text);
  const ta = el('textarea', { rows: 3, placeholder: 'What should the agent change? E.g. “fewer trees near the road, more birches”', value: draft,
    oninput: e => { draft = e.target.value; send.disabled = !draft.trim(); },
    onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) { e.preventDefault(); decide(P, 'changes_requested', draft.trim()); } else if (e.key === 'Escape') { changing = false; render(); } } });
  const send = btn('Send to the agent', 'primary', () => decide(P, 'changes_requested', draft.trim()), 'Ctrl+Enter');
  send.disabled = !draft.trim();
  const state = P.review ? (pending ? '' : ' · preparing…') : done ? ' · done' : ' · working…';
  const undoable = done && canUndo(P);
  card.className = `${pending ? 'pending' : done ? 'done' : 'open'}${P.review ? ' review' : ''}`;
  card.replaceChildren(...[
    el('div', { class: 'head', title: 'Drag to move the card; double-click: back to the corner' }, el('span', { class: `led ${pending ? 'review' : done ? 'on' : 'busy'}` }), el('b', {}, P.review ? 'AI proposal' : 'AI change'),
      el('span', { class: 'muted' }, `· ${P.client}${state}`), el('span', { class: 'spacer' }),
      P.marks.length ? el('button', { type: 'button', class: 'ibtn', title: 'Show it on the map', onclick: () => R.show(P) }, ME.icon('crosshair')) : null,
      done ? el('button', { type: 'button', class: 'ibtn', title: 'Close', onclick: hideDone }, ME.icon('x')) : null),
    el('div', { class: 'title' }, P.title),
    P.description ? richText(P.description, 'desc') : null,
    P.changes.length && !(P.single && P.changes.length === 1) ? el('ul', { class: 'changes' }, ...P.changes.slice(0, 12).map(c => el('li', {}, c.label, c.comment ? richText(c.comment, 'comment') : null)),
      P.changes.length > 12 ? el('li', { class: 'muted' }, `and ${P.changes.length - 12} more`) : null) : null,
    pending && P.entries.length ? el('div', { class: 'compare' },
      el('span', { class: 'muted small' }, 'Compare'),
      el('div', { class: 'seg' },
        btn('Before', P.before ? 'on' : '', () => toggleBefore(P, true), 'The map without the proposal'),
        btn('After', P.before ? '' : 'on', () => toggleBefore(P, false), 'The map with the proposal'))) : null,
    done
      ? el('div', { class: 'actions' },
        Object.assign(btn('Undo', 'danger', () => undoDone(P), undoable ? 'Undo this change (one step)' : 'You changed the map since: use Undo (Ctrl+Z)'), { disabled: !undoable }),
        btn('OK', 'primary', hideDone))
      : !P.review
        ? el('div', { class: 'actions' }, btn('Finish', '', () => finishDirect(P), 'End the change now: what is done stays, as one undo step'))
        : changing
          ? el('div', { class: 'change-box' }, ta, el('div', { class: 'actions' }, btn('Cancel', '', () => { changing = false; render(); }), send))
          : el('div', { class: 'actions' },
            btn('Reject', 'danger', () => decide(P, 'rejected'), 'Undo it: nothing of it stays'),
            pending ? btn('Change…', '', () => { changing = true; render(); card.querySelector('textarea')?.focus(); }, 'Undo it and tell the agent what to do instead') : null,
            pending ? btn('Accept', 'primary accept', () => decide(P, 'accepted'), 'Keep it: it is saved') : null),
  ].filter(Boolean));
  placeCard();
  ME.app?.requestRender();
}
R.render = render;

// the places of the change on the map: a dashed outline while it is on the card
R.drawMarks = (ctx, view) => {
  const P = R.active || R.shown;
  if (!P || !P.marks.length) return;
  ctx.save();
  for (const m of P.marks) {
    if (m.path) {
      const c = view.cellPx();
      view.setCellTransform(ctx);
      ctx.lineWidth = 4.5 / c; ctx.strokeStyle = 'rgba(16,13,20,0.4)'; ctx.setLineDash([]); ctx.stroke(m.path);
      ctx.lineWidth = 2.6 / c; ctx.strokeStyle = '#ffc56b'; ctx.setLineDash([7 / c, 4 / c]); ctx.stroke(m.path);
    } else if (m.box) {
      view.setScreenTransform(ctx);
      const [x0, y0] = view.toScreen(m.box[0], m.box[1]), [x1, y1] = view.toScreen(m.box[2], m.box[3]), pad = 6;
      ctx.beginPath(); ctx.roundRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad, 5);
      ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(16,13,20,0.4)'; ctx.setLineDash([]); ctx.stroke();
      ctx.lineWidth = 2.6; ctx.strokeStyle = '#ffc56b'; ctx.setLineDash([7, 4]); ctx.stroke();
    }
  }
  ctx.restore();
};
})(window.ME);
