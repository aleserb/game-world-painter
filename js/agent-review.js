// Review mode (AI Agent → Settings): the agent's changes become proposals. A change is applied, so the map shows it,
// but it is held: not saved, its layers are not edited by the user, its undo steps are not undone one by one. The user
// accepts it, asks for changes (with a comment, the change is undone) or rejects it (undone). The agent gets the
// decision as the result of its call, or later with wait_for_review; begin_proposal … submit_proposal groups calls.
(function (ME) {
'use strict';

const A = () => ME.app;
const fail = msg => { throw new ME.agentInternals.ToolError(msg); };
const DEFAULT_WAIT = 45; // seconds a call waits for the user (some agents give up on a call after 60 s)
const MAX_WAIT = 110;
let nextId = 1;

const R = ME.agentReview = {
  active: null, // the proposal being prepared ('open') or waiting for the user ('pending')
  list: [], // every proposal of this session, newest first
  collecting: null, // the proposal the current tool call adds to

  /** Is this layer held by the active proposal? */
  holds(layer) { return !!(R.active && layer && R.active.layers.has(layer)); },
  /** Does the active proposal change the layer list or settings (metadata.json)? */
  holdsStructure() { return !!(R.active && R.active.meta); },
  /** Is this undo step part of the active proposal? */
  owns(entry) { return !!(R.active && entry && R.active.entries.includes(entry)); },
};

function create(title, client, single) {
  const P = {
    id: nextId++, title, description: '', client: client?.name || 'agent', single, status: 'open', created: new Date(),
    entries: [], layers: new Set(), meta: false, marks: [], changes: [], results: [], before: false, feedback: '', waiters: [],
  };
  R.active = P;
  R.list.unshift(P);
  return P;
}

const label = e => String(e.label || '').replace(/^AI: /, '');

/** Runs a changing tool call as (part of) a proposal. exec() runs the tool. Returns {result, later?}: later resolves
 *  to the result with the user's decision (a single call waits for it). */
R.run = async (call, exec) => {
  let P = R.active;
  if (P?.status === 'pending') {
    fail(`Your proposal #${P.id} ("${P.title}") is waiting for the user's review. Call wait_for_review (id ${P.id}) and act on the decision before changing more.`);
  }
  const single = !P;
  if (single) P = create(call.tool.replace(/_/g, ' '), call.client, true);
  const collect = [], mv = A().S.metaVersion, had = new Set(A().S.layers);
  ME.agentCollect = collect;
  ME.agentApplying = true;
  R.collecting = P;
  let result;
  try {
    result = await exec();
  } catch (e) {
    revertEntries(collect); // a failed call leaves nothing behind
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
  if (changed.length) P.changes.push(...changed);
  if (single) {
    if (!collect.length) { discard(P); return { result }; } // nothing changed (e.g. nothing to place)
    P.title = changed.join('; ');
    P.results.push(result.data);
    submit(P);
    return { result, later: R.decision(P, DEFAULT_WAIT).then(d => withDecision(result, d)) };
  }
  P.results.push(result.data);
  render();
  return { result: withDecision(result, { id: P.id, status: 'open', note: 'Part of your open proposal: call submit_proposal when it is complete.' }) };
};

function withDecision(result, d) {
  const data = result.data && typeof result.data === 'object' ? result.data : (result.text ? { text: result.text } : {});
  return { ...result, data: { ...data, proposal: d } };
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
  if (P.status === 'open') return { ...base, note: 'The proposal is open: add changes, then call submit_proposal.' };
  if (P.status === 'accepted') return { ...base, note: 'The user accepted it: the changes are on the map and saved.' };
  if (P.status === 'changes_requested') return { ...base, feedback: P.feedback, note: 'The proposal was undone: nothing of it is on the map. Make a new proposal that follows the user\'s feedback.' };
  if (P.status === 'rejected') return { ...base, note: 'The user rejected it: it was undone, nothing of it is on the map. Do not repeat it; ask the user what they want if unsure.' };
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
  for (const w of P.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(decisionOf(P)); }
  A().afterHistory();
  A().scheduleSave();
  render();
  ME.agent?.changed();
  A().toast(status === 'accepted' ? 'AI proposal accepted' : status === 'rejected' ? 'AI proposal rejected: undone' : 'Sent to the agent; the proposal was undone', 2500);
}

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

/** The map was opened again (or another one): the proposal cannot be applied any more. */
R.drop = why => {
  const P = R.active;
  if (!P) return;
  P.status = 'dropped';
  P.note = `The proposal was dropped: ${why}.`;
  R.active = null;
  for (const w of P.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(decisionOf(P)); }
  render();
};

/** Brings the proposal's places into view. */
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

// ------------------------------------------------------------------------------------------------ tools

const T = ME.agentTools;

T.begin_proposal = (args, ctx) => {
  if (!ctx.review) return { data: { review_mode: false, note: 'Review mode is off: your changes apply directly (each is one undo step). No need for proposals.' } };
  if (R.active?.status === 'pending') fail(`Proposal #${R.active.id} is still waiting for the user's review: call wait_for_review first.`);
  if (R.active?.status === 'open') fail(`Proposal #${R.active.id} is already open: add changes to it and call submit_proposal.`);
  const P = create(String(args.title || 'AI proposal').slice(0, 120), ctx.client, false);
  P.description = String(args.description || '').slice(0, 2000);
  render();
  return { data: { id: P.id, status: 'open', note: 'Now make the changes (each call adds to this proposal), then call submit_proposal.' } };
};

T.submit_proposal = (args, ctx) => {
  if (!ctx.review) return { data: { review_mode: false, note: 'Review mode is off: your changes were applied directly.' } };
  const P = R.active;
  if (!P || P.status !== 'open') {
    const last = R.list.find(x => !x.single);
    fail(last && ['rejected', 'dropped'].includes(last.status) ? `There is no open proposal: the user rejected #${last.id} ("${last.title}") while you were preparing it.` : 'There is no open proposal: call begin_proposal first.');
  }
  if (!P.entries.length) { discard(P); fail('The proposal has no changes: nothing to review. It was closed.'); }
  if (args.summary) P.description = String(args.summary).slice(0, 2000);
  submit(P);
  return { deferred: R.decision(P, args.wait ?? DEFAULT_WAIT).then(d => ({ data: { proposal: d, changes: P.changes } })) };
};

T.wait_for_review = args => {
  const P = args.id != null ? R.list.find(x => x.id === args.id) : R.active || R.list[0];
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

let card = null, changing = false, draft = '';

function render() {
  const P = R.active;
  if (!P) { card?.remove(); card = null; changing = false; draft = ''; ME.app?.requestRender(); return; }
  if (!card) {
    card = el('div', { id: 'ai-proposal' });
    document.getElementById('stage').append(card);
    for (const t of ['pointerdown', 'wheel', 'keydown']) card.addEventListener(t, e => e.stopPropagation());
  }
  const pending = P.status === 'pending';
  const btn = (text, cls, onclick, title = '') => el('button', { type: 'button', class: cls, onclick, title }, text);
  const ta = el('textarea', { rows: 3, placeholder: 'What should the agent change? E.g. “fewer trees near the road, more birches”', value: draft,
    oninput: e => { draft = e.target.value; send.disabled = !draft.trim(); },
    onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) { e.preventDefault(); decide(P, 'changes_requested', draft.trim()); } else if (e.key === 'Escape') { changing = false; render(); } } });
  const send = btn('Send to the agent', 'primary', () => decide(P, 'changes_requested', draft.trim()), 'Ctrl+Enter');
  send.disabled = !draft.trim();
  card.className = pending ? 'pending' : 'open';
  card.replaceChildren(
    el('div', { class: 'head' }, el('span', { class: `led ${pending ? 'review' : 'busy'}` }), el('b', {}, 'AI proposal'),
      el('span', { class: 'muted' }, `· ${P.client}${pending ? '' : ' · preparing…'}`), el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'ibtn', title: 'Show it on the map', onclick: () => R.show(P) }, ME.icon('crosshair'))),
    el('div', { class: 'title' }, P.title),
    P.description ? el('div', { class: 'desc' }, P.description) : null,
    P.changes.length ? el('ul', { class: 'changes' }, ...P.changes.slice(0, 8).map(c => el('li', {}, c)), P.changes.length > 8 ? el('li', { class: 'muted' }, `and ${P.changes.length - 8} more`) : null) : null,
    pending && P.entries.length ? el('div', { class: 'compare' },
      el('span', { class: 'muted small' }, 'Compare'),
      el('div', { class: 'seg' },
        btn('Before', P.before ? 'on' : '', () => toggleBefore(P, true), 'The map without the proposal'),
        btn('After', P.before ? '' : 'on', () => toggleBefore(P, false), 'The map with the proposal'))) : null,
    changing
      ? el('div', { class: 'change-box' }, ta, el('div', { class: 'actions' }, btn('Cancel', '', () => { changing = false; render(); }), send))
      : el('div', { class: 'actions' },
        btn('Reject', 'danger', () => decide(P, 'rejected'), 'Undo it: nothing of it stays'),
        pending ? btn('Change…', '', () => { changing = true; render(); card.querySelector('textarea')?.focus(); }, 'Undo it and tell the agent what to do instead') : null,
        pending ? btn('Accept', 'primary accept', () => decide(P, 'accepted'), 'Keep it: it is saved') : null),
  );
  ME.app?.requestRender();
}
R.render = render;

// the places of the proposal on the map: a dashed outline while it waits
R.drawMarks = (ctx, view) => {
  const P = R.active;
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
