// Repeating tasks, shared by the web UI and the server. Finishing a repeating task creates
// the next one with its dates moved on; the repeat then belongs to that new task.

import { parseDueDate } from './due.js';

export const REPEATS = {
  daily: { label: 'Every day', short: 'Daily' },
  weekdays: { label: 'Every weekday', short: 'Weekdays' },
  weekly: { label: 'Every week', short: 'Weekly' },
  biweekly: { label: 'Every 2 weeks', short: 'Every 2 wks' },
  monthly: { label: 'Every month', short: 'Monthly' },
  yearly: { label: 'Every year', short: 'Yearly' },
};

const ALIASES = {
  day: 'daily', everyday: 'daily', 'every day': 'daily',
  weekday: 'weekdays', 'every weekday': 'weekdays',
  week: 'weekly', 'every week': 'weekly',
  fortnightly: 'biweekly', 'every 2 weeks': 'biweekly', 'every two weeks': 'biweekly', 'every other week': 'biweekly',
  month: 'monthly', 'every month': 'monthly',
  year: 'yearly', annually: 'yearly', 'every year': 'yearly',
  none: '', never: '', no: '', off: '',
};

/** 'daily', 'Every week', 'fortnightly'… → a REPEATS key, or '' for no repeat. null when it isn't one. */
export function parseRepeat(v) {
  if (v == null) return '';
  const s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (REPEATS[s]) return s;
  if (s in ALIASES) return ALIASES[s];
  return Object.keys(REPEATS).find((k) => REPEATS[k].label.toLowerCase() === s || REPEATS[k].short.toLowerCase() === s) ?? null;
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function addMonths(d, n) {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); // Jan 31 → Feb 28
}

/** One step on, in local time (so a 9:00 deadline stays at 9:00 across daylight-saving changes). */
function step(date, repeat) {
  const d = new Date(date);
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekdays') do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'biweekly') d.setDate(d.getDate() + 14);
  else if (repeat === 'monthly') addMonths(d, 1);
  else if (repeat === 'yearly') addMonths(d, 12);
  else throw new Error(`Unknown repeat: ${repeat}`);
  return d;
}

/** Step at least once, then on until the day is after `today`, so the next one is never already overdue. */
function nextAfter(date, repeat, today) {
  let d = step(date, repeat);
  while (localDay(d) <= today) d = step(d, repeat);
  return d;
}

const DAY = 86400000;
const shiftDay = (day, days) => {
  const d = parseDueDate(day);
  d.setDate(d.getDate() + days);
  return localDay(d);
};

/**
 * Dates for the next task in a series. The deadline moves on by the repeat; the start date
 * keeps the same distance before it. Without any dates, the next one is due one step from today.
 * @returns {{ dueAt: string|null, startAt: string|null }}
 */
export function nextDates({ dueAt, dueHasTime, startAt }, repeat, now = new Date()) {
  const today = localDay(now);
  if (dueAt) {
    const due = parseDueDate(dueAt);
    const next = nextAfter(due, repeat, today);
    const moved = Math.round((parseDueDate(localDay(next)) - parseDueDate(localDay(due))) / DAY);
    return { dueAt: dueHasTime ? next.toISOString() : localDay(next), startAt: startAt ? shiftDay(startAt, moved) : null };
  }
  if (startAt) return { dueAt: null, startAt: localDay(nextAfter(parseDueDate(startAt), repeat, today)) };
  return { dueAt: localDay(step(parseDueDate(today), repeat)), startAt: null };
}
