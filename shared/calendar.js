// Calendar maths, shared by the web UI, the server, the assistant and the MCP server:
// working hours, time blocks (meetings, booked task time, time off) and their repeats, free
// time per day, whether the work that's due fits, and a suggested plan that fits tasks into
// free time. Everything is in this machine's local time. Timed blocks are stored as ISO
// datetimes; all-day blocks as 'YYYY-MM-DD' days, both ends included.
import { parseDueDate } from './due.js';
import { step } from './repeat.js';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const BLOCK_KINDS = {
  busy: { label: 'Busy', hint: 'Meetings, appointments, anything that takes your time' },
  task: { label: 'Task time', hint: 'Time booked to work on a task' },
  off: { label: 'Time off', hint: 'Holidays and days off: no working hours' },
};

const nineToFive = [['09:00', '17:00']];
/** Sunday first, like Date#getDay(). Mon–Fri 9–5 keeps "1 day" estimates at 8 hours. */
export const DEFAULT_WEEK = [[], nineToFive, nineToFive, nineToFive, nineToFive, nineToFive, []];
export const DEFAULT_SESSION = 120; // longest stretch a suggested plan books for one task

export const SLOT = 15; // minutes; times snap to this
const MIN = 60000;
const DAY_MS = 86400000;
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

// ---------- days and times ----------

const pad = (n) => String(n).padStart(2, '0');
/** The local day of a Date (or ms) as 'YYYY-MM-DD'. */
export const dayOf = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};
/** Local midnight at the start of `day`. */
export const dayDate = (day) => parseDueDate(day);
export function addDays(day, n) {
  const d = dayDate(day);
  d.setDate(d.getDate() + n);
  return dayOf(d);
}
export const weekdayOf = (day) => dayDate(day).getDay();
/** The Monday of `day`'s week. */
export const weekStart = (day) => addDays(day, -((weekdayOf(day) + 6) % 7));
export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const fromMinutes = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
/** `day` at local `time` ('HH:MM'; '24:00' is the next midnight), in ms. */
export function at(day, time) {
  const d = dayDate(day);
  const m = toMinutes(time);
  d.setHours(Math.floor(m / 60), m % 60);
  return d.getTime();
}
const roundUp = (ms) => Math.ceil(ms / (SLOT * MIN)) * SLOT * MIN;
const roundDown = (ms) => Math.floor(ms / (SLOT * MIN)) * SLOT * MIN;

/** "45m", "2h", "3h 30m": durations in hours, never days (a day of free time isn't 24h). */
export function formatMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

const timeLabel = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dateLabel = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** "Mon, Oct 26, 9:00 AM – 10:30 AM", or "Mon, Oct 26 – Wed, Oct 28" for all-day blocks. */
export function spanLabel({ startAt, endAt, allDay }) {
  if (allDay) return startAt === endAt ? `${dateLabel(dayDate(startAt))}, all day` : `${dateLabel(dayDate(startAt))} – ${dateLabel(dayDate(endAt))}`;
  const s = new Date(startAt);
  const e = new Date(endAt);
  return dayOf(s) === dayOf(e) ? `${dateLabel(s)}, ${timeLabel(s)} – ${timeLabel(e)}` : `${dateLabel(s)}, ${timeLabel(s)} – ${dateLabel(e)}, ${timeLabel(e)}`;
}

// ---------- intervals: lists of [start, end) in ms ----------

export function merge(list) {
  const out = [];
  for (const [s, e] of list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function subtract(list, cut) {
  let out = merge(list);
  for (const [cs, ce] of merge(cut)) {
    out = out.flatMap(([s, e]) => (ce <= s || cs >= e ? [[s, e]] : [...(cs > s ? [[s, cs]] : []), ...(ce < e ? [[ce, e]] : [])]));
  }
  return out;
}

export const intersect = (a, b) => subtract(a, subtract(a, b));
export const minutesIn = (list) => Math.round(merge(list).reduce((n, [s, e]) => n + e - s, 0) / MIN);
const clip = (list, from, to) => list.map(([s, e]) => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s);

// ---------- working hours ----------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * Clean a week of working hours: 7 lists (Sunday first) of ['HH:MM', 'HH:MM'] ranges, sorted
 * and merged where they touch. Throws an Error with a plain message.
 */
export function cleanWeek(week) {
  if (!Array.isArray(week) || week.length !== 7) throw new Error('Working hours need a list of times for each of the 7 days.');
  return week.map((ranges, i) => {
    if (!Array.isArray(ranges)) throw new Error(`The working hours for ${WEEKDAYS[i]} should be a list of times.`);
    if (ranges.length > 6) throw new Error(`${WEEKDAYS[i]} has too many time ranges (at most 6).`);
    const mins = ranges
      .map((r) => {
        const [s, e] = Array.isArray(r) ? r : [r?.start, r?.end];
        if (!TIME.test(String(s)) || !END_TIME.test(String(e))) throw new Error(`Working hours look like 09:00–17:00 (check ${WEEKDAYS[i]}).`);
        if (toMinutes(e) <= toMinutes(s)) throw new Error(`On ${WEEKDAYS[i]}, ${s}–${e} ends before it starts.`);
        return [toMinutes(s), toMinutes(e)];
      })
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of mins) {
      const last = merged.at(-1);
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged.map(([s, e]) => [fromMinutes(s), fromMinutes(e)]);
  });
}

/** Minutes of working time in a normal week. */
export const weekMinutes = (week) => week.flat().reduce((n, [s, e]) => n + toMinutes(e) - toMinutes(s), 0);

/** "Mon–Fri 09:00–17:00; Sat 10:00–12:00". */
export function weekLabel(week) {
  const groups = [];
  for (const i of [1, 2, 3, 4, 5, 6, 0]) {
    const key = week[i].map((r) => r.join('–')).join(', ');
    const last = groups.at(-1);
    if (last && last.key === key) last.days.push(i);
    else groups.push({ key, days: [i] });
  }
  const parts = groups.filter((g) => g.key).map((g) => `${WEEKDAYS[g.days[0]]}${g.days.length > 1 ? `–${WEEKDAYS[g.days.at(-1)]}` : ''} ${g.key}`);
  return parts.length ? parts.join('; ') : 'no working hours set';
}

/** Working time between `from` and `to` (ms) as intervals. */
export function workIntervals(week, from, to) {
  const out = [];
  for (let day = dayOf(from); dayDate(day).getTime() < to; day = addDays(day, 1)) {
    for (const [s, e] of week[weekdayOf(day)] || []) out.push([at(day, s), at(day, e)]);
  }
  return clip(out, from, to);
}

// ---------- blocks and their repeats ----------

/** [start, end) of a block in ms. All-day blocks run from the first midnight to the one after the last day. */
export function blockSpan(b) {
  if (b.allDay) return [dayDate(b.startAt).getTime(), dayDate(addDays(b.endAt, 1)).getTime()];
  return [Date.parse(b.startAt), Date.parse(b.endAt)];
}

/**
 * Every occurrence of `blocks` that overlaps [from, to), soonest first. A repeating block's
 * occurrences keep its local time of day and length; `skips` lists the days (of an
 * occurrence's start) that were removed. Each occurrence has `start`/`end` in ms, its `day`,
 * the `blockId` and a `key` that is unique per occurrence.
 */
export function expandBlocks(blocks, from, to) {
  const out = [];
  for (const b of blocks) {
    const [s0, e0] = blockSpan(b);
    const len = e0 - s0;
    const days = b.allDay ? Math.round((dayDate(b.endAt) - dayDate(b.startAt)) / DAY_MS) : 0;
    const emit = (start) => {
      const day = dayOf(start);
      const occ = b.allDay
        ? { startAt: day, endAt: addDays(day, days), start: start.getTime(), end: dayDate(addDays(day, days + 1)).getTime() }
        : { startAt: start.toISOString(), endAt: new Date(start.getTime() + len).toISOString(), start: start.getTime(), end: start.getTime() + len };
      if (occ.end > from && occ.start < to) out.push({ ...b, ...occ, blockId: b.id, day, key: `${b.id}:${day}` });
    };
    if (!b.repeat) {
      emit(new Date(s0));
      continue;
    }
    const skips = new Set(b.skips || []);
    let d = new Date(s0);
    for (let i = 0; i < 20000 && d.getTime() < to; i++, d = step(d, b.repeat)) {
      const day = dayOf(d);
      if (b.repeatUntil && day > b.repeatUntil) break;
      if (!skips.has(day)) emit(d);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------- free time and workload ----------

const spansOf = (occurrences, kind) => occurrences.filter((o) => o.kind === kind).map((o) => [o.start, o.end]);

/**
 * One day's time in minutes: working hours less time off (`work`), how much of that is busy
 * or booked for tasks, and what's `free` (and `freeLeft` after `now`). Overlaps count once.
 * `freeSlots` are the free intervals.
 */
export function dayCapacity(day, { week, occurrences, now = null }) {
  const from = dayDate(day).getTime();
  const to = dayDate(addDays(day, 1)).getTime();
  const work = subtract(workIntervals(week, from, to), spansOf(occurrences, 'off'));
  const busy = intersect(work, spansOf(occurrences, 'busy'));
  const booked = intersect(subtract(work, busy), spansOf(occurrences, 'task'));
  const free = subtract(work, [...busy, ...booked]);
  const left = now == null ? free : clip(free, now, to);
  return { work: minutesIn(work), busy: minutesIn(busy), booked: minutesIn(booked), free: minutesIn(free), freeLeft: minutesIn(left), freeSlots: left };
}

/** Free working time between `from` and `to` (never before `now`), snapped to whole slots. */
export function freeTime({ week, occurrences, from, to, now = Date.now() }) {
  const start = Math.max(from, roundUp(now));
  const taken = occurrences.map((o) => [o.start, o.end]);
  return subtract(workIntervals(week, start, to), taken)
    .map(([s, e]) => [roundUp(s), roundDown(e)])
    .filter(([s, e]) => e - s >= SLOT * MIN);
}

/** When a task is due, in ms: its time, or the end of its day. null without a deadline. */
export function deadlineOf(task) {
  if (!task.dueAt) return null;
  return task.dueHasTime ? Date.parse(task.dueAt) : dayDate(addDays(task.dueAt.slice(0, 10), 1)).getTime();
}

const dueDayOf = (task) => (task.dueHasTime ? dayOf(Date.parse(task.dueAt)) : task.dueAt.slice(0, 10));

/** Minutes of a task's estimate that are neither tracked nor booked yet. null without an estimate. */
export function unbooked(task, bookedMinutes = 0) {
  if (!task.estimateMinutes) return null;
  return Math.max(0, task.estimateMinutes - Math.round((task.timeSpent || 0) / 60) - bookedMinutes);
}

/**
 * Does the estimated work that's due fit into the free time before it's due? For each of
 * `days`: minutes of unbooked work due that day (`due`), and how far the free time from now
 * falls short of everything due by the end of that day (`short`, 0 when it fits). Overdue
 * work counts as due today. `occurrences` must cover today through the last day.
 */
export function workload(days, { week, occurrences, tasks, booked = {}, now = Date.now() }) {
  const today = dayOf(now);
  const need = tasks
    .map((t) => ({ day: t.dueAt ? (deadlineOf(t) <= now ? today : dueDayOf(t)) : null, minutes: unbooked(t, booked[t.id] || 0) || 0 }))
    .filter((x) => x.day && x.minutes);
  const dueOn = (day) => need.filter((x) => x.day === day).reduce((n, x) => n + x.minutes, 0);
  const out = Object.fromEntries(days.map((d) => [d, { due: d < today ? 0 : dueOn(d), short: 0 }]));
  let free = 0;
  let demand = 0;
  for (let d = today; d <= days.at(-1); d = addDays(d, 1)) {
    free += dayCapacity(d, { week, occurrences, now }).freeLeft;
    const due = dueOn(d);
    demand += due;
    if (out[d] && due) out[d].short = Math.max(0, demand - free);
  }
  return out;
}

/**
 * Fit tasks into free working time between `from` and `to`, most important first (priority,
 * then deadline). Each task gets sessions of at most `maxSession` minutes, one per stretch of
 * free time so long tasks spread out (unless it needs more to fit), never before its start
 * date or after its deadline.
 * Nothing is written: it's a suggestion for the user to review.
 * @returns {{ bookings: {taskId, start, end, minutes}[], unplaced: {taskId, minutes, reason: 'deadline'|'time'}[], needsEstimate: number[] }}
 */
export function suggestPlan({ tasks, booked = {}, week, occurrences, from, to, now = Date.now(), maxSession = DEFAULT_SESSION, minSession = 30 }) {
  let free = freeTime({ week, occurrences, from, to, now });
  const order = [...tasks].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (deadlineOf(a) ?? Infinity) - (deadlineOf(b) ?? Infinity) || a.id - b.id
  );
  const bookings = [];
  const unplaced = [];
  const needsEstimate = [];
  for (const t of order) {
    const left = unbooked(t, booked[t.id] || 0);
    if (left == null) {
      needsEstimate.push(t.id);
      continue;
    }
    let need = Math.ceil(left / SLOT) * SLOT;
    if (!need) continue;
    const due = deadlineOf(t);
    // overdue work goes in as soon as possible
    const limit = due != null && due > now ? due : to;
    const earliest = t.startAt ? dayDate(t.startAt).getTime() : 0;
    // one session per stretch first; when that isn't enough, more passes fill what's left
    for (let progress = true; need > 0 && progress; ) {
      progress = false;
      const next = [];
      for (const [s, e] of free) {
        const a = Math.max(s, earliest);
        const fit = Math.floor((Math.min(e, limit) - a) / MIN / SLOT) * SLOT;
        const take = Math.min(need, maxSession, fit);
        if (need > 0 && take > 0 && (take >= minSession || take === need)) {
          bookings.push({ taskId: t.id, start: new Date(a).toISOString(), end: new Date(a + take * MIN).toISOString(), minutes: take });
          need -= take;
          progress = true;
          next.push(...[[s, a], [a + take * MIN, e]].filter(([x, y]) => y - x >= SLOT * MIN));
        } else next.push([s, e]);
      }
      free = next.sort((x, y) => x[0] - y[0]);
    }
    if (need > 0) unplaced.push({ taskId: t.id, minutes: need, reason: due != null && due > now && due < to ? 'deadline' : 'time' });
  }
  return { bookings: bookings.sort((x, y) => x.start.localeCompare(y.start)), unplaced, needsEstimate };
}
