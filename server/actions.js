// Changes proposed by the chat assistant or by agents (over MCP, in "ask me first" mode).
// Nothing is written until the user approves: preview() validates and describes each action
// for the approval card, apply() runs the approved ones in one transaction through the same
// data layer as the board. Agents may also propose a few things the chat can't (deleting a
// subtask, replacing a note), because those are tools they already have.
import * as store from './db.js';
import { dueInfo } from '../shared/due.js';
import { changeTags } from '../shared/tags.js';
import { formatEstimate, formatMoney, parseEstimate, sizeOf } from '../shared/estimate.js';
import { parseRepeat, REPEATS } from '../shared/repeat.js';
import { BLOCK_KINDS, formatMinutes, spanLabel } from '../shared/calendar.js';

export const MAX_ACTIONS = 20;
// a plan (schedule_tasks) turns into one booking per session, so it may become more than MAX_ACTIONS
const MAX_BOOKINGS = 40;

const PRIORITY_ALIASES = { med: 'medium', normal: 'medium', crit: 'urgent', critical: 'urgent', '': 'none' };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const fail = (message) => {
  throw new store.AppError(400, message);
};

function taskRef(ref) {
  const id = Number(String(ref ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) fail('It didn’t say which task to change.');
  try {
    return store.getTask(id);
  } catch {
    return fail(`Task #${id} doesn’t exist.`);
  }
}

const label = (t) => `#${t.id} ${t.title}`;
const columnOf = (t) => store.getColumn(t.columnId);

function text(v, what, { required = false, max = 2000 } = {}) {
  if (v == null || v === '') return required ? fail(`The ${what} is missing.`) : undefined;
  if (typeof v !== 'string') fail(`The ${what} should be text.`);
  const s = v.trim();
  if (required && !s) fail(`The ${what} is missing.`);
  if (s.length > max) fail(`The ${what} is too long.`);
  return s;
}

function priority(v) {
  if (v == null) return undefined;
  const p = PRIORITY_ALIASES[norm(v)] ?? norm(v);
  if (!store.PRIORITIES.includes(p)) fail(`“${v}” isn’t a priority. Use low, medium, high or urgent.`);
  return p;
}

/** Returns [value for the data layer, human label]. '' or null clears the deadline. */
function due(v) {
  if (v === undefined) return [undefined, ''];
  if (v === null || v === '') return ['', 'no deadline'];
  let parsed;
  try {
    parsed = store.parseDue(String(v));
  } catch {
    fail(`“${v}” isn’t a date this app understands.`);
  }
  const info = dueInfo(parsed[0], !!parsed[1]);
  return [String(v), info ? info.label.replace(/^Due /, 'due ').replace(/^Overdue/, 'overdue') : String(v)];
}

/** A list of tag names as the data layer will store them (throws a plain message if one is bad). */
function tagNames(v, what = 'tags') {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length > 20) fail('That’s too many tags at once.');
  return list.map((t) => {
    if (typeof t !== 'string') fail(`The ${what} should be names.`);
    try {
      return store.tagName(t);
    } catch (err) {
      return fail(err.message);
    }
  });
}

const tagWords = (list) => list.map((t) => `#${t}`).join(' ');

/** Describe a tag change, or null when it changes nothing. */
function tagChange(current, add, remove) {
  const next = changeTags(current, { add, remove });
  const lower = (l) => l.map((t) => t.toLowerCase());
  const added = next.filter((t) => !lower(current).includes(t.toLowerCase()));
  const removed = current.filter((t) => !lower(next).includes(t.toLowerCase()));
  if (!added.length && !removed.length) return null;
  return { next, summary: [added.length && `add ${tagWords(added)}`, removed.length && `remove ${tagWords(removed)}`].filter(Boolean).join(', ') };
}

/** Start date as 'YYYY-MM-DD', '' to clear, or undefined when not given. */
function start(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return '';
  try {
    return store.parseStart(String(v));
  } catch {
    return fail(`“${v}” isn’t a start date this app understands.`);
  }
}

const dayLabel = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function checkSpan(startAt, dueAt) {
  if (!startAt || !dueAt) return;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? dueAt : store.parseStart(new Date(store.parseDue(dueAt)[0]).toISOString());
  if (startAt > due) fail('The start date can’t be after the deadline.');
}

/** Estimate in minutes (null clears), or undefined when not given. */
function estimate(v) {
  if (v === undefined) return undefined;
  try {
    return parseEstimate(v);
  } catch (err) {
    return fail(err.message);
  }
}

/** A REPEATS key, '' to stop repeating, or undefined when not given. */
function repeat(v) {
  if (v === undefined) return undefined;
  const r = parseRepeat(v);
  if (r == null) fail(`“${v}” isn’t a repeat. Use daily, weekdays, weekly, biweekly, monthly or yearly.`);
  return r;
}

const repeatWords = (r) => (r ? REPEATS[r].label.toLowerCase() : 'no repeat');

const estimateWords = (m) => {
  if (!m) return 'no estimate';
  const s = sizeOf(m);
  return s ? `${s.key} (${formatEstimate(m)})` : `~${formatEstimate(m)}`;
};

function resolveColumnIn(ref, projectId) {
  try {
    return store.resolveColumn(ref, projectId);
  } catch {
    const names = store.listColumns(projectId).map((c) => c.name).join(', ');
    return fail(`There’s no column called “${ref}” here. Columns: ${names}.`);
  }
}

function resolveProjectRef(ref) {
  try {
    return store.resolveProject(ref);
  } catch {
    return fail(`There’s no project called “${ref}”.`);
  }
}

const AGENT_ONLY = new Set(['delete_subtask', 'delete_block']);

function subtaskRef(ref) {
  const id = Number(ref);
  if (!Number.isInteger(id) || id <= 0) fail('It didn’t say which subtask to change.');
  for (const t of store.listTasks({ archived: 'all', limit: 1000 })) {
    const sub = t.subtasks.find((s) => s.id === id);
    if (sub) return { sub, task: t };
  }
  return fail(`Subtask ${id} doesn’t exist.`);
}

function blockRef(ref) {
  const id = Number(String(ref ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) fail('It didn’t say which calendar block to change.');
  try {
    return store.getBlock(id);
  } catch {
    return fail(`Calendar block ${id} doesn’t exist.`);
  }
}

const BLOCK_VERBS = { busy: 'Block time', task: 'Book time', off: 'Time off' };

/** The data layer's message, as a plain-language failure. */
function checked(fn) {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof store.AppError)) throw err;
    return fail(`${err.message.replace(/\.$/, '')}.`);
  }
}

/** A block's fields from an action, in the data layer's names (only those given). */
function blockFields(a) {
  const out = {};
  if (a.kind !== undefined) {
    const k = norm(a.kind);
    const kind = { meeting: 'busy', busy: 'busy', event: 'busy', task: 'task', tasktime: 'task', focus: 'task', off: 'off', timeoff: 'off', holiday: 'off', vacation: 'off' }[k];
    if (!kind) fail(`“${a.kind}” isn’t a kind of block. Use busy (meetings), task (task time) or off (time off).`);
    out.kind = kind;
  }
  if (a.task !== undefined && a.task !== null && a.task !== '') out.taskId = taskRef(a.task).id;
  if (a.title !== undefined) out.title = text(a.title, 'block title', { max: 200 }) ?? '';
  if (a.note !== undefined) out.note = text(a.note, 'block note', { max: 2000 }) ?? '';
  if (a.all_day !== undefined) out.allDay = !!a.all_day;
  if (a.start !== undefined) out.startAt = a.start;
  if (a.end !== undefined) out.endAt = a.end;
  if (a.repeat !== undefined) out.repeat = repeat(a.repeat) || null;
  if (a.repeat_until !== undefined) out.repeatUntil = a.repeat_until || null;
  return out;
}

const blockName = (v) => (v.kind === 'task' ? label(store.getTask(v.taskId)) : `“${v.title || BLOCK_KINDS[v.kind].label}”`);
const blockExtras = (v) => [v.repeat && repeatWords(v.repeat), v.repeat && v.repeatUntil && `until ${dayLabel(v.repeatUntil)}`].filter(Boolean);

/**
 * Validates one action and returns { verb, summary, run }. Throws AppError with a
 * plain-language message when the action can't be applied.
 * @param {'chat'|'agent'} source  who proposed it; the chat assistant can never delete
 */
function plan(a, source = 'chat') {
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('This change couldn’t be read.');
  if (source === 'chat' && AGENT_ONLY.has(a.type)) fail(`“${a.type}” isn’t something the assistant can do.`);
  switch (a.type) {
    case 'create_task': {
      const project = resolveProjectRef(a.project);
      const cols = store.listColumns(project.id);
      const column = a.column ? resolveColumnIn(a.column, project.id) : cols.find((c) => !c.hidden && !c.isDone) || cols.find((c) => !c.hidden);
      if (!column) fail(`${project.name} has no visible column to add tasks to.`);
      const title = text(a.title, 'task title', { required: true, max: 500 });
      const description = text(a.description, 'description', { max: 20000 });
      const note = text(a.note, 'note', { max: 20000 });
      const p = priority(a.priority);
      const [dueAt, dueLabel] = due(a.due);
      const startAt = start(a.start);
      if (startAt && dueAt) checkSpan(startAt, dueAt);
      const est = estimate(a.estimate);
      const rep = repeat(a.repeat);
      const subtasks = Array.isArray(a.subtasks) ? a.subtasks.map((s) => text(s, 'subtask', { required: true, max: 500 })).slice(0, 30) : [];
      const tags = tagNames(a.tags);
      const extras = [p && p !== 'none' && `${p} priority`, est && `~${formatEstimate(est)}`, startAt && `starts ${dayLabel(startAt)}`, dueLabel, rep && repeatWords(rep), subtasks.length && `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}`, tags.length && tagWords(tags)].filter(Boolean);
      return {
        verb: 'Create',
        summary: `“${title}” in ${project.icon} ${project.name} › ${column.name}${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
        run: () => store.createTask({ projectId: project.id, columnId: column.id, title, description, note, priority: p, startAt: startAt || undefined, dueAt: dueAt || undefined, estimateMinutes: est ?? undefined, repeat: rep || undefined, subtasks, tags }),
      };
    }

    case 'update_task': {
      const t = taskRef(a.task);
      const patch = {};
      const changes = [];
      // only fields that actually differ count as changes
      if (a.title !== undefined) {
        const v = text(a.title, 'task title', { required: true, max: 500 });
        if (v !== t.title) (patch.title = v), changes.push(`title → “${v}”`);
      }
      if (a.description !== undefined) {
        const v = text(a.description, 'description', { max: 20000 }) ?? '';
        if (v !== t.description) (patch.description = v), changes.push(v ? 'new description' : 'clear description');
      }
      if (a.note !== undefined) {
        const v = text(a.note, 'note', { max: 20000 }) ?? '';
        if (v !== t.note) (patch.note = v), changes.push(v ? 'replace the note' : 'clear the note');
      }
      if (a.priority !== undefined) {
        const v = priority(a.priority);
        if (v !== t.priority) (patch.priority = v), changes.push(`priority → ${v}`);
      }
      if (a.due !== undefined) {
        const [dueAt, dueLabel] = due(a.due);
        const same = dueAt ? t.dueAt && store.parseDue(dueAt)[0] === t.dueAt : !t.dueAt;
        if (!same) (patch.dueAt = dueAt), changes.push(dueAt ? dueLabel : 'remove deadline');
      }
      if (a.estimate !== undefined) {
        const v = estimate(a.estimate);
        if ((v ?? null) !== t.estimateMinutes) (patch.estimateMinutes = v), changes.push(`estimate → ${estimateWords(v)}`);
      }
      if (a.repeat !== undefined) {
        const r = repeat(a.repeat);
        if ((r || null) !== t.repeat) (patch.repeat = r), changes.push(r ? `repeat ${repeatWords(r)}` : 'stop repeating');
      }
      if (a.start !== undefined) {
        const s = start(a.start);
        if ((s || null) !== t.startAt) (patch.startAt = s || ''), changes.push(s ? `starts ${dayLabel(s)}` : 'remove start date');
      }
      if (patch.startAt !== undefined || patch.dueAt !== undefined) {
        checkSpan(patch.startAt !== undefined ? patch.startAt : t.startAt, patch.dueAt !== undefined ? patch.dueAt : t.dueAt);
      }
      if (a.add_tags !== undefined || a.remove_tags !== undefined || a.tags !== undefined) {
        const base = a.tags !== undefined ? tagNames(a.tags) : t.tags;
        const c = a.tags !== undefined ? tagChange(t.tags, base, t.tags.filter((x) => !base.some((y) => y.toLowerCase() === x.toLowerCase()))) : tagChange(t.tags, tagNames(a.add_tags), tagNames(a.remove_tags, 'tags to remove'));
        if (c) (patch.tags = c.next), changes.push(`tags: ${c.summary}`);
      }
      if (!changes.length) fail(`${label(t)} already looks like that.`);
      return { verb: 'Edit', summary: `${label(t)}: ${changes.join(', ')}`, run: () => store.updateTask(t.id, patch) };
    }

    case 'move_task': {
      const t = taskRef(a.task);
      const from = columnOf(t);
      const project = a.project != null && a.project !== '' ? resolveProjectRef(a.project) : null;
      if (project?.archived) fail(`${project.name} is archived. Restore it first.`);
      if (!project && (a.column == null || a.column === '')) fail('It didn’t say which column or project to move to.');
      const intoProject = project ?? store.getProject(from.projectId);
      const to = a.column != null && a.column !== '' ? resolveColumnIn(a.column, intoProject.id) : store.columnForMove(t, intoProject.id);
      if (to.id === from.id) fail(`${label(t)} is already in ${to.name}.`);
      const top = a.position === 'top';
      // another project: say where it's going, not just the column
      const dest = to.projectId !== from.projectId ? `${intoProject.name} · ${to.name}` : to.name;
      return { verb: 'Move', summary: `${label(t)}: ${from.name} → ${dest}${top ? ' (top)' : ''}`, run: () => store.moveTask(t.id, { columnId: to.id, index: top ? 0 : undefined }) };
    }

    case 'complete_task': {
      const t = taskRef(a.task);
      if (columnOf(t).isDone) fail(`${label(t)} is already done.`);
      return { verb: 'Complete', summary: label(t), run: () => store.completeTask(t.id) };
    }

    case 'archive_task': {
      const t = taskRef(a.task);
      if (t.archived) fail(`${label(t)} is already archived.`);
      return { verb: 'Archive', summary: `${label(t)} (you can restore it from the archive)`, run: () => store.archiveTask(t.id) };
    }

    case 'restore_task': {
      const t = taskRef(a.task);
      if (!t.archived) fail(`${label(t)} isn’t archived.`);
      return { verb: 'Restore', summary: `${label(t)} from the archive`, run: () => store.archiveTask(t.id, false) };
    }

    case 'add_subtasks': {
      const t = taskRef(a.task);
      const items = (Array.isArray(a.subtasks) ? a.subtasks : [a.subtasks]).filter((s) => s != null && s !== '').map((s) => text(s, 'subtask', { required: true, max: 500 }));
      if (!items.length) fail(`No subtasks to add to ${label(t)}.`);
      if (items.length > 30) fail('That’s too many subtasks at once.');
      return { verb: 'Add subtasks', summary: `${label(t)}: ${items.map((s) => `“${s}”`).join(', ')}`, run: () => items.forEach((s) => store.addSubtask(t.id, s)) };
    }

    case 'check_subtask': {
      const t = taskRef(a.task);
      const want = norm(text(a.subtask, 'subtask', { required: true }));
      const sub = t.subtasks.find((s) => norm(s.title) === want) || t.subtasks.find((s) => norm(s.title).includes(want));
      if (!sub) fail(`${label(t)} has no subtask like “${a.subtask}”.`);
      const done = a.done !== false;
      if (sub.done === done) fail(`“${sub.title}” is already ${done ? 'ticked' : 'unticked'}.`);
      return { verb: done ? 'Tick' : 'Untick', summary: `“${sub.title}” on ${label(t)}`, run: () => store.updateSubtask(sub.id, { done }) };
    }

    case 'update_subtask': {
      const { sub, task } = subtaskRef(a.subtask_id);
      const patch = {};
      const changes = [];
      if (a.title !== undefined) {
        const v = text(a.title, 'subtask', { required: true, max: 500 });
        if (v !== sub.title) (patch.title = v), changes.push(`rename to “${v}”`);
      }
      if (a.done !== undefined && !!a.done !== sub.done) (patch.done = !!a.done), changes.push(a.done ? 'tick' : 'untick');
      if (!changes.length) fail(`“${sub.title}” already looks like that.`);
      return { verb: 'Edit subtask', summary: `“${sub.title}” on ${label(task)}: ${changes.join(', ')}`, run: () => store.updateSubtask(sub.id, patch) };
    }

    case 'delete_subtask': {
      const { sub, task } = subtaskRef(a.subtask_id);
      return { verb: 'Delete subtask', summary: `“${sub.title}” from ${label(task)}`, run: () => store.deleteSubtask(sub.id) };
    }

    case 'add_note': {
      const t = taskRef(a.task);
      const note = text(a.text, 'note', { required: true });
      return { verb: 'Add note', summary: `${label(t)}: “${note.length > 80 ? `${note.slice(0, 79)}…` : note}”`, run: () => store.appendNote(t.id, note) };
    }

    case 'create_project': {
      const name = text(a.name, 'project name', { required: true, max: 80 });
      const icon = text(a.icon, 'icon', { max: 16 }) || '📋';
      const description = text(a.description, 'project description', { max: 500 }) || '';
      const tags = tagNames(a.tags);
      const p = priority(a.priority);
      const extras = [p && p !== 'none' && `${p} priority`, tags.length && tagWords(tags)].filter(Boolean);
      return {
        verb: 'Create project',
        summary: `${icon} ${name} (with the four default columns)${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
        run: () => store.createProject({ name, icon, description, priority: p, tags }),
      };
    }

    case 'update_project':
    case 'tag_project': {
      const project = resolveProjectRef(a.project);
      const patch = {};
      const changes = [];
      if (a.name !== undefined) {
        const v = text(a.name, 'project name', { required: true, max: 80 });
        if (v !== project.name) (patch.name = v), changes.push(`rename to “${v}”`);
      }
      if (a.icon !== undefined) {
        const v = text(a.icon, 'icon', { required: true, max: 16 });
        if (v !== project.icon) (patch.icon = v), changes.push(`icon → ${v}`);
      }
      if (a.description !== undefined) {
        const v = text(a.description, 'project description', { max: 280 }) ?? '';
        if (v !== project.description) (patch.description = v), changes.push(v ? 'new description' : 'clear description');
      }
      if (a.priority !== undefined) {
        const p = priority(a.priority);
        if (p !== project.priority) (patch.priority = p), changes.push(`priority → ${p}`);
      }
      if (a.currency !== undefined) {
        const c = String(a.currency).trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) fail(`“${a.currency}” isn’t a currency code. Use one like USD, EUR or INR.`);
        if (c !== project.currency) patch.currency = c;
      }
      if (a.hourly_rate !== undefined) {
        const r = a.hourly_rate === null || a.hourly_rate === '' ? null : Number(a.hourly_rate);
        if (r !== null && (!Number.isFinite(r) || r < 0 || r > 100000)) fail('The hourly rate must be a number between 0 and 100,000.');
        if ((r || null) !== project.hourlyRate || patch.currency) {
          patch.hourlyRate = r || null;
          changes.push(r ? `rate → ${formatMoney(r, patch.currency || project.currency)}/h` : 'remove hourly rate');
        }
      } else if (patch.currency) changes.push(`currency → ${patch.currency}`);
      if (a.add_tags !== undefined || a.remove_tags !== undefined || a.tags !== undefined) {
        const base = a.tags !== undefined ? tagNames(a.tags) : null;
        const c = base
          ? tagChange(project.tags, base, project.tags.filter((x) => !base.some((y) => y.toLowerCase() === x.toLowerCase())))
          : tagChange(project.tags, tagNames(a.add_tags), tagNames(a.remove_tags, 'tags to remove'));
        if (c) (patch.tags = c.next), changes.push(`tags: ${c.summary}`);
      }
      if (!changes.length) fail(`${project.icon} ${project.name} already looks like that.`);
      return { verb: 'Edit project', summary: `${project.icon} ${project.name}: ${changes.join(', ')}`, run: () => store.updateProject(project.id, patch) };
    }

    case 'create_block': {
      const fields = blockFields(a);
      // a bare date means an all-day block (time off, usually)
      if (fields.allDay === undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(a.start ?? '').trim())) fields.allDay = true;
      if (fields.kind === undefined) fields.kind = fields.taskId ? 'task' : 'busy';
      const v = checked(() => store.checkBlock(fields));
      const extras = blockExtras(v);
      return {
        verb: BLOCK_VERBS[v.kind],
        summary: `${blockName(v)} · ${spanLabel(v)}${v.allDay ? '' : ` (${formatMinutes((Date.parse(v.endAt) - Date.parse(v.startAt)) / 60000)})`}${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
        run: () => store.createBlock(v),
      };
    }

    case 'update_block': {
      const b = blockRef(a.block);
      const fields = blockFields(a);
      const opts = { occurrence: a.occurrence || undefined, scope: a.scope === 'all' ? 'all' : 'one' };
      const v = checked(() => store.checkBlockUpdate(b.id, fields, opts));
      const changes = [];
      const moved = v.startAt !== b.startAt || v.endAt !== b.endAt || v.allDay !== b.allDay || !!opts.occurrence;
      if (moved) changes.push(`→ ${spanLabel(v)}`);
      if (v.title !== b.title) changes.push(v.title ? `title → “${v.title}”` : 'clear title');
      if (v.kind !== b.kind) changes.push(`→ ${BLOCK_KINDS[v.kind].label.toLowerCase()}`);
      if ((v.repeat || null) !== b.repeat && !(opts.occurrence && opts.scope === 'one')) changes.push(v.repeat ? `repeat ${repeatWords(v.repeat)}` : 'stop repeating');
      if (v.note !== b.note) changes.push(v.note ? 'new note' : 'clear note');
      if (!changes.length) fail(`${blockName(b)} already looks like that.`);
      const which = opts.occurrence && b.repeat ? (opts.scope === 'all' ? ' (every one)' : ` (only on ${dayLabel(opts.occurrence)})`) : '';
      return { verb: moved && changes.length === 1 ? 'Move block' : 'Edit block', summary: `${blockName(b)}${which}: ${changes.join(', ')}`, run: () => store.updateBlock(b.id, fields, opts) };
    }

    case 'delete_block': {
      const b = blockRef(a.block);
      const one = a.occurrence && b.repeat;
      return {
        verb: 'Remove block',
        summary: `${blockName(b)}${one ? ` on ${dayLabel(String(a.occurrence).slice(0, 10))} only` : ` · ${spanLabel(b)}${b.repeat ? ` and every repeat` : ''}`}`,
        run: () => store.deleteBlock(b.id, { occurrence: one ? a.occurrence : undefined }),
      };
    }

    // what a plan couldn't fit: shown on the approval card, never applied
    case 'schedule_note':
      throw Object.assign(new store.AppError(400, String(a.text || 'Part of the plan didn’t fit.')), { verb: 'Not planned' });

    default:
      return fail(a.type ? `“${a.type}” isn’t something ${source === 'chat' ? 'the assistant' : 'Task Tracker'} can do.` : 'This change couldn’t be read.');
  }
}

function checkList(actions, limit = MAX_ACTIONS) {
  if (!Array.isArray(actions) || !actions.length) fail('There are no changes to review.');
  if (actions.length > limit) fail(`That’s too many changes at once (the limit is ${limit}).`);
}

/** The bookings a schedule_tasks request suggests, plus notes on anything that didn't fit. */
function planActions(a) {
  let plan;
  try {
    const project = a.project != null && a.project !== '' ? resolveProjectRef(a.project) : null;
    const taskIds = a.tasks == null ? undefined : (Array.isArray(a.tasks) ? a.tasks : [a.tasks]).map((t) => taskRef(t).id);
    const min = a.priority == null || a.priority === '' ? undefined : priority(a.priority);
    plan = store.suggestSchedule({ from: a.from || undefined, to: a.to || undefined, projectId: project?.id, minPriority: min === 'none' ? undefined : min, taskIds });
  } catch (err) {
    if (!(err instanceof store.AppError)) throw err;
    return [{ type: 'schedule_note', text: err.message }];
  }
  const out = plan.bookings.slice(0, MAX_BOOKINGS).map((b) => ({ type: 'create_block', kind: 'task', task: b.taskId, start: b.start, end: b.end }));
  if (plan.bookings.length > MAX_BOOKINGS) out.push({ type: 'schedule_note', text: `…and ${plan.bookings.length - MAX_BOOKINGS} more sessions. Plan a shorter stretch to see them all.` });
  for (const u of plan.unplaced) {
    out.push({ type: 'schedule_note', text: `#${u.taskId} ${u.title}: ${formatMinutes(u.minutes)} ${u.reason === 'deadline' ? 'doesn’t fit before its deadline' : 'doesn’t fit in the free time'}` });
  }
  if (plan.needsEstimate.length) out.push({ type: 'schedule_note', text: `No estimate, so not planned: ${plan.needsEstimate.map((t) => `#${t.taskId} ${t.title}`).join(', ')}` });
  if (!out.length) {
    out.push({ type: 'schedule_note', text: plan.considered ? 'Everything that matches is already booked or tracked.' : 'No open tasks match, so there’s nothing to plan.' });
  }
  return out;
}

/** Replace schedule_tasks requests with the bookings they suggest, so each can be reviewed. */
export function expand(actions, limit = MAX_ACTIONS) {
  checkList(actions, limit);
  return actions.flatMap((a) => (a?.type === 'schedule_tasks' ? planActions(a) : [a]));
}

function describe(list, source) {
  return list.map((a) => {
    try {
      const { verb, summary } = plan(a, source);
      return { ok: true, verb, summary };
    } catch (err) {
      if (!(err instanceof store.AppError)) throw err;
      return { ok: false, verb: err.verb || 'Can’t do', summary: err.message };
    }
  });
}

/** Describe each proposed action without changing anything. */
export function preview(actions, { source = 'chat' } = {}) {
  return review(actions, { source }).items;
}

/** Like preview, plus the actions as they'll be applied (a plan becomes its bookings). */
export function review(actions, { source = 'chat' } = {}) {
  const list = expand(actions);
  return { items: describe(list, source), actions: list };
}

/** What an applied change created or touched, so an agent can refer to it afterwards. */
function refOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('columnId' in value) return { taskId: value.id };
  if ('icon' in value && 'archived' in value) return { projectId: value.id };
  if ('kind' in value && 'startAt' in value) return { blockId: value.id };
  return undefined;
}

/** Apply approved actions, all or nothing. Later actions see the effects of earlier ones. */
export function apply(actions, { source = 'chat' } = {}) {
  // approved plans arrive already expanded into their bookings
  const list = expand(actions, MAX_ACTIONS + MAX_BOOKINGS + 10);
  const notes = list.filter((a) => a?.type === 'schedule_note');
  const runs = list.filter((a) => a?.type !== 'schedule_note');
  if (!runs.length) fail(notes.map((n) => n.text).join(' ') || 'There are no changes to apply.');
  const done = [];
  try {
    store.transaction(() => {
      for (const a of runs) {
        const step = plan(a, source);
        const value = step.run();
        done.push({ verb: step.verb, summary: step.summary, ...refOf(value) });
      }
    });
  } catch (err) {
    if (!(err instanceof store.AppError)) throw err;
    throw new store.AppError(400, `Nothing was changed. ${err.message}`);
  }
  return notes.length ? { applied: done, notes: notes.map((n) => n.text) } : { applied: done };
}

// ---------- agent requests ("ask me first") ----------

const FIELD_NAMES = {
  title: 'title',
  description: 'description',
  note: 'note',
  priority: 'priority',
  due: 'deadline',
  start: 'start date',
  estimate: 'estimate',
  repeat: 'repeat',
  rate: 'hourly rate',
  tags: 'tags',
  column: 'status',
  archived: 'archive state',
  subtask: 'subtask',
  name: 'name',
  icon: 'icon',
  block: 'calendar block',
};

/** The task an action works on, if any (for claims and conflict checks). */
function targetTaskId(a) {
  if (a?.task != null) return Number(String(a.task).replace(/^#/, '')) || null;
  if (a?.subtask_id != null) {
    try {
      return subtaskRef(a.subtask_id).task.id;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The current values an action would overwrite, so a review can tell whether they changed
 * since the agent asked. Append-only actions (notes, new subtasks, new items) have none.
 */
function basisOf(a) {
  try {
    switch (a?.type) {
      case 'update_task': {
        const t = taskRef(a.task);
        const b = {};
        if (a.title !== undefined) b.title = t.title;
        if (a.description !== undefined) b.description = t.description;
        if (a.note !== undefined) b.note = t.note;
        if (a.priority !== undefined) b.priority = t.priority;
        if (a.due !== undefined) b.due = t.dueAt;
        if (a.start !== undefined) b.start = t.startAt;
        if (a.estimate !== undefined) b.estimate = t.estimateMinutes;
        if (a.repeat !== undefined) b.repeat = t.repeat;
        if (a.tags !== undefined || a.add_tags !== undefined || a.remove_tags !== undefined) b.tags = t.tags.join('\u0000');
        return b;
      }
      case 'move_task':
      case 'complete_task':
        return { column: taskRef(a.task).columnId };
      case 'archive_task':
      case 'restore_task':
        return { archived: taskRef(a.task).archived };
      case 'check_subtask':
      case 'update_subtask':
      case 'delete_subtask': {
        const t = a.subtask_id != null ? subtaskRef(a.subtask_id).sub : null;
        const sub = t || taskRef(a.task).subtasks.find((s) => norm(s.title).includes(norm(a.subtask || '')));
        return sub ? { subtask: `${sub.title}\u0000${sub.done}` } : null;
      }
      case 'update_block':
      case 'delete_block': {
        const b = blockRef(a.block);
        return { block: [b.kind, b.title, b.startAt, b.endAt, b.allDay, b.repeat, b.skips.join(',')].join('\u0000') };
      }
      case 'update_project':
      case 'tag_project': {
        const p = resolveProjectRef(a.project);
        const b = {};
        for (const k of ['name', 'icon', 'description', 'priority']) if (a[k] !== undefined) b[k] = p[k];
        if (a.hourly_rate !== undefined || a.currency !== undefined) b.rate = `${p.hourlyRate}|${p.currency}`;
        if (a.tags !== undefined || a.add_tags !== undefined || a.remove_tags !== undefined) b.tags = p.tags.join('\u0000');
        return b;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Queue an agent's changes for approval. Throws if none of them could be applied. */
export function propose({ agent, actions, session = null }) {
  const { items, actions: list } = review(actions, { source: 'agent' });
  if (!items.some((i) => i.ok)) fail(items.map((i) => i.summary).join(' '));
  return store.createProposal({ agent, actions: list, items, session, basis: list.map(basisOf) });
}

/**
 * Add review hints to pending requests: which changes would overwrite something edited
 * since the agent asked (`changed`), and which cards another agent is working on (`claimedBy`).
 */
export function annotate(proposal) {
  const items = proposal.items.map((item, i) => {
    const a = proposal.actions[i];
    const out = { ...item };
    const then = proposal.basis?.[i];
    if (item.ok && then) {
      const current = basisOf(a);
      const changed = Object.keys(then).filter((k) => !current || current[k] !== then[k]);
      if (changed.length) out.changed = changed.map((k) => FIELD_NAMES[k] || k);
    }
    const taskId = targetTaskId(a);
    const claim = taskId && store.getClaim(taskId);
    if (claim && claim.session !== proposal.session) out.claimedBy = { agent: claim.agent, since: claim.claimedAt, note: claim.note };
    return out;
  });
  return { ...proposal, items };
}

/** Apply the chosen changes of a pending request (all by default). */
export function approve(id, selected) {
  const p = store.getProposal(id);
  if (p.status !== 'pending') throw new store.AppError(409, `This request was already ${p.status}.`);
  const chosen = p.actions.filter((_, i) => p.items[i]?.ok && (!Array.isArray(selected) || selected[i]));
  if (!chosen.length) return dismiss(id);
  const result = apply(chosen, { source: 'agent' });
  return store.decideProposal(id, { status: 'applied', result });
}

export function dismiss(id) {
  return store.decideProposal(id, { status: 'dismissed' });
}
