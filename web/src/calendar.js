// The calendar's state: what's on screen (day, week or month around `anchor`), the data for
// it, the block being edited, and a suggested plan waiting for review.
import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from './api';
import { addDays, dayOf, formatMinutes, weekStart } from '../../shared/calendar.js';

export const MODES = { day: 'Day', week: 'Week', month: 'Month' };

/** The days on screen: one, a Monday-to-Sunday week, or whole weeks covering the month. */
export function visibleDays(mode, anchor) {
  if (mode === 'day') return [anchor];
  if (mode === 'week') return Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i));
  const first = `${anchor.slice(0, 7)}-01`;
  const last = addDays(`${addDays(first, 31).slice(0, 7)}-01`, -1);
  const days = [];
  for (let d = weekStart(first); d <= last || days.length % 7; d = addDays(d, 1)) days.push(d);
  return days;
}

const savedMode = localStorage.getItem('tt-calendar-mode');

export const useCalendar = create((set, get) => ({
  mode: MODES[savedMode] ? savedMode : 'week',
  anchor: dayOf(new Date()),
  data: null,
  // views showing the calendar register here, so live updates only reload it while it's open
  active: 0,
  // { occ } to edit an existing block (occurrence), { draft } for a new one
  editing: null,
  // a suggested plan: { from, to, bookings, unplaced, needsEstimate, skipped: Set of booking indexes }
  suggestion: null,

  async load() {
    const { mode, anchor } = get();
    const days = visibleDays(mode, anchor);
    // from today at the latest, so the workload check can count free time from now
    const today = dayOf(new Date());
    const from = days[0] < today ? days[0] : today;
    try {
      const data = await api.calendar(from, days.at(-1));
      if (get().mode === mode && get().anchor === anchor) set({ data });
    } catch (err) {
      toast.error(`Could not load the calendar: ${err.message}`);
    }
  },
  refresh() {
    if (get().active > 0) get().load();
  },

  setMode(mode) {
    localStorage.setItem('tt-calendar-mode', mode);
    set({ mode, suggestion: null });
    get().load();
  },
  /** dir: -1 / +1 a day, week or month */
  go(dir) {
    const { mode, anchor } = get();
    const next = mode === 'day' ? addDays(anchor, dir) : mode === 'week' ? addDays(anchor, 7 * dir) : `${addDays(`${anchor.slice(0, 7)}-15`, 30 * dir).slice(0, 7)}-01`;
    set({ anchor: next, suggestion: null });
    get().load();
  },
  goTo(day, mode = get().mode) {
    if (mode !== get().mode) localStorage.setItem('tt-calendar-mode', mode);
    set({ anchor: day, mode, suggestion: null });
    get().load();
  },

  edit: (editing) => set({ editing }),

  async createBlock(body) {
    try {
      const block = await api.createBlock(body);
      await get().load();
      return block;
    } catch (err) {
      toast.error(err.message);
      throw err;
    }
  },

  /** Change a block. For an occurrence of a repeating block, `scope` 'one' or 'all'. */
  async updateBlock(occ, patch, scope = 'one') {
    // dragging should feel instant: move the occurrence on screen, then confirm
    if (patch.startAt && patch.endAt && !occ.allDay) {
      const start = Date.parse(patch.startAt);
      const end = Date.parse(patch.endAt);
      set((s) => ({ data: s.data && { ...s.data, blocks: s.data.blocks.map((b) => (b.key === occ.key ? { ...b, ...patch, start, end } : b)) } }));
    }
    try {
      await api.updateBlock(occ.blockId, patch, occ.repeat ? occ.day : undefined, scope);
    } catch (err) {
      toast.error(err.message);
    }
    await get().load();
  },

  async deleteBlock(occ, scope = 'all') {
    set((s) => ({ data: s.data && { ...s.data, blocks: s.data.blocks.filter((b) => (scope === 'one' ? b.key !== occ.key : b.blockId !== occ.blockId)) } }));
    try {
      await api.deleteBlock(occ.blockId, occ.repeat && scope === 'one' ? occ.day : undefined);
    } catch (err) {
      toast.error(err.message);
    }
    await get().load();
  },

  async saveSettings(patch) {
    try {
      const settings = await api.updateCalendarSettings(patch);
      set((s) => ({ data: s.data && { ...s.data, settings } }));
      return settings;
    } catch (err) {
      toast.error(err.message);
      get().load();
    }
  },

  /** Ask for a plan for the days on screen (from today on). Nothing is written yet. */
  async suggest({ minPriority, projectId } = {}) {
    const days = visibleDays(get().mode, get().anchor);
    const today = dayOf(new Date());
    const to = days.at(-1);
    if (to < today) return toast('These days are in the past', { description: 'Go to this week or later to plan your time.' });
    try {
      const plan = await api.suggestPlan({ from: days[0] > today ? days[0] : today, to, minPriority, projectId });
      set({ suggestion: { ...plan, skipped: new Set() } });
      if (!plan.bookings.length) {
        toast(plan.considered ? 'Nothing more to plan here' : 'No open tasks to plan', {
          description: plan.needsEstimate.length ? `${plan.needsEstimate.length} task${plan.needsEstimate.length === 1 ? ' needs' : 's need'} an estimate first.` : undefined,
        });
      }
    } catch (err) {
      toast.error(err.message);
    }
  },
  toggleSuggested(i) {
    set((s) => {
      const skipped = new Set(s.suggestion.skipped);
      skipped.has(i) ? skipped.delete(i) : skipped.add(i);
      return { suggestion: { ...s.suggestion, skipped } };
    });
  },
  dismissSuggestion: () => set({ suggestion: null }),
  async acceptSuggestion() {
    const { bookings, skipped } = get().suggestion;
    const chosen = bookings.filter((_, i) => !skipped.has(i));
    if (!chosen.length) return set({ suggestion: null });
    try {
      await api.createBlocks(chosen.map((b) => ({ kind: 'task', taskId: b.taskId, startAt: b.start, endAt: b.end })));
      set({ suggestion: null });
      toast.success(`Booked ${chosen.length} session${chosen.length === 1 ? '' : 's'} · ${formatMinutes(chosen.reduce((n, b) => n + b.minutes, 0))}`);
    } catch (err) {
      toast.error(err.message);
    }
    await get().load();
  },
}));
