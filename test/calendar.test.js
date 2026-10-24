import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-calendar-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
const actions = await import('../server/actions.js');
const chat = await import('../server/chat.js');
const { blockReminders, blockMessage } = await import('../server/reminders.js');
const cal = await import('../shared/calendar.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

// Monday 2030-01-07 to Sunday 2030-01-13, in local time
const MON = '2030-01-07';
const t = (day, hhmm) => new Date(`${day}T${hhmm}`).getTime();
const iso = (day, hhmm) => new Date(`${day}T${hhmm}`).toISOString();
const range = (day, n = 1) => ({ from: cal.dayDate(day).getTime(), to: cal.dayDate(cal.addDays(day, n)).getTime() });
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

test('interval maths: merge, subtract, intersect', () => {
  assert.deepEqual(cal.merge([[5, 8], [1, 3], [2, 4]]), [[1, 4], [5, 8]]);
  assert.deepEqual(cal.subtract([[0, 10]], [[2, 3], [5, 12]]), [[0, 2], [3, 5]]);
  assert.deepEqual(cal.intersect([[0, 10]], [[8, 20], [-5, 1]]), [[0, 1], [8, 10]]);
});

test('working hours are validated, sorted and merged', () => {
  const week = cal.cleanWeek([[], [['13:00', '17:00'], ['09:00', '12:00'], ['11:30', '12:30']], [], [], [], [['22:00', '24:00']], []]);
  assert.deepEqual(week[1], [['09:00', '12:30'], ['13:00', '17:00']]);
  assert.deepEqual(week[5], [['22:00', '24:00']]);
  assert.throws(() => cal.cleanWeek([[]]), /each of the 7 days/);
  assert.throws(() => cal.cleanWeek([[], [['10:00', '09:00']], [], [], [], [], []]), /ends before it starts/);
  assert.throws(() => cal.cleanWeek([[], [['9am', '5pm']], [], [], [], [], []]), /look like 09:00/);
  assert.equal(cal.weekLabel(cal.DEFAULT_WEEK), 'Mon–Fri 09:00–17:00');
  assert.equal(cal.weekMinutes(cal.DEFAULT_WEEK), 40 * 60);
  assert.throws(() => store.updateCalendarSettings({ week: 'always' }), /each of the 7 days/);
  assert.throws(() => store.updateCalendarSettings({ sessionMinutes: 5 }), /between 30 and 480/);
});

test('repeating blocks expand per occurrence, keep their time, and honour skips and an end', () => {
  const standup = { id: 1, kind: 'busy', allDay: false, startAt: iso(MON, '09:30'), endAt: iso(MON, '09:45'), repeat: 'weekdays', repeatUntil: '2030-01-16', skips: ['2030-01-09'] };
  const occ = cal.expandBlocks([standup], t(MON, '00:00'), t('2030-01-31', '00:00'));
  assert.deepEqual(occ.map((o) => o.day), ['2030-01-07', '2030-01-08', '2030-01-10', '2030-01-11', '2030-01-14', '2030-01-15', '2030-01-16']);
  assert.ok(occ.every((o) => hhmm(o.start) === '09:30' && o.end - o.start === 15 * 60000));
  assert.equal(occ[0].key, '1:2030-01-07');
  // all-day blocks run midnight to midnight, both days included
  const off = { id: 2, kind: 'off', allDay: true, startAt: '2030-01-10', endAt: '2030-01-11', skips: [] };
  const [o] = cal.expandBlocks([off], t(MON, '00:00'), t('2030-01-14', '00:00'));
  assert.equal(o.end - o.start, 2 * 86400000);
});

test('a day’s capacity counts working hours less time off, meetings and booked task time', () => {
  const occurrences = cal.expandBlocks(
    [
      { id: 1, kind: 'busy', startAt: iso(MON, '08:00'), endAt: iso(MON, '10:00') }, // only 9–10 is in working hours
      { id: 2, kind: 'task', taskId: 1, startAt: iso(MON, '09:30'), endAt: iso(MON, '11:00') }, // overlaps the meeting
      { id: 3, kind: 'busy', startAt: iso(MON, '18:00'), endAt: iso(MON, '19:00') }, // after hours
    ],
    ...Object.values(range(MON))
  );
  const cap = cal.dayCapacity(MON, { week: cal.DEFAULT_WEEK, occurrences });
  assert.deepEqual([cap.work, cap.busy, cap.booked, cap.free], [480, 60, 60, 360]);
  assert.deepEqual(cap.freeSlots.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`), ['11:00–17:00']);
  const left = cal.dayCapacity(MON, { week: cal.DEFAULT_WEEK, occurrences, now: t(MON, '15:00') });
  assert.equal(left.freeLeft, 120);
  const off = cal.expandBlocks([{ id: 4, kind: 'off', allDay: true, startAt: MON, endAt: MON }], ...Object.values(range(MON)));
  assert.equal(cal.dayCapacity(MON, { week: cal.DEFAULT_WEEK, occurrences: off }).work, 0);
});

test('the suggested plan puts important work first, in sessions, before deadlines', () => {
  const tasks = [
    { id: 1, title: 'Low, no deadline', priority: 'low', estimateMinutes: 60 },
    { id: 2, title: 'Urgent, due Tuesday', priority: 'urgent', estimateMinutes: 300, dueAt: '2030-01-08' },
    { id: 3, title: 'High, starts Wednesday', priority: 'high', estimateMinutes: 90, startAt: '2030-01-09' },
    { id: 4, title: 'High, half tracked', priority: 'high', estimateMinutes: 120, timeSpent: 3600 },
    { id: 5, title: 'No estimate', priority: 'urgent' },
    { id: 6, title: 'Too big for its deadline', priority: 'medium', estimateMinutes: 6000, dueAt: '2030-01-09' },
  ];
  const occurrences = cal.expandBlocks([{ id: 1, kind: 'busy', startAt: iso(MON, '12:00'), endAt: iso(MON, '13:00') }], ...Object.values(range(MON, 7)));
  const plan = cal.suggestPlan({ tasks, week: cal.DEFAULT_WEEK, occurrences, from: t(MON, '00:00'), to: t('2030-01-14', '00:00'), now: t(MON, '08:00'), maxSession: 120 });
  const of = (id) => plan.bookings.filter((b) => b.taskId === id);
  const at = (b) => `${cal.dayOf(Date.parse(b.start))} ${hhmm(Date.parse(b.start))}–${hhmm(Date.parse(b.end))}`;
  // urgent first: 2h sessions, one per free stretch, the meeting respected, all before Tuesday ends
  assert.deepEqual(of(2).map(at), ['2030-01-07 09:00–11:00', '2030-01-07 13:00–15:00', '2030-01-08 09:00–10:00']);
  assert.ok(of(3).every((b) => b.start >= iso('2030-01-09', '00:00')), 'not before its start date');
  assert.equal(of(4).reduce((n, b) => n + b.minutes, 0), 60, 'tracked time counts');
  assert.deepEqual(plan.needsEstimate, [5]);
  assert.deepEqual(plan.unplaced.map((u) => [u.taskId, u.reason]), [[6, 'deadline']]);
  // nothing overlaps
  const spans = plan.bookings.map((b) => [Date.parse(b.start), Date.parse(b.end)]).sort((a, b) => a[0] - b[0]);
  spans.slice(1).forEach(([s], i) => assert.ok(s >= spans[i][1]));
  // with a deadline close, sessions fill the rest of a stretch instead of leaving it free
  const crunch = cal.suggestPlan({ tasks: [{ id: 9, priority: 'high', estimateMinutes: 480, dueAt: MON }], week: cal.DEFAULT_WEEK, occurrences: [], from: t(MON, '00:00'), to: t('2030-01-14', '00:00'), now: t(MON, '08:00') });
  assert.deepEqual(crunch.bookings.map(at), ['2030-01-07 09:00–11:00', '2030-01-07 11:00–13:00', '2030-01-07 13:00–15:00', '2030-01-07 15:00–17:00']);
  assert.deepEqual(crunch.unplaced, []);
  // already booked time counts too
  const again = cal.suggestPlan({ tasks: [tasks[0]], booked: { 1: 60 }, week: cal.DEFAULT_WEEK, occurrences: [], from: t(MON, '00:00'), to: t('2030-01-14', '00:00'), now: t(MON, '08:00') });
  assert.equal(again.bookings.length, 0);
});

test('workload flags the day when the work due no longer fits', () => {
  const days = Array.from({ length: 3 }, (_, i) => cal.addDays(MON, i));
  const tasks = [
    { id: 1, priority: 'high', estimateMinutes: 600, dueAt: '2030-01-08' }, // 10h due Tuesday; Mon+Tue have 16h
    { id: 2, priority: 'high', estimateMinutes: 600, dueAt: '2030-01-08' }, // now 20h: 4h short
  ];
  const load = cal.workload(days, { week: cal.DEFAULT_WEEK, occurrences: [], tasks, now: t(MON, '08:00') });
  assert.deepEqual(load['2030-01-07'], { due: 0, short: 0 });
  assert.deepEqual(load['2030-01-08'], { due: 1200, short: 240 });
  const booked = cal.workload(days, { week: cal.DEFAULT_WEEK, occurrences: [], tasks, booked: { 2: 600 }, now: t(MON, '08:00') });
  assert.equal(booked['2030-01-08'].short, 0, 'booked time is no longer missing');
});

test('blocks: create, validate, edit one occurrence or the series, delete', () => {
  const task = store.createTask({ title: 'Write report', estimateMinutes: 240 });
  assert.throws(() => store.createBlock({ kind: 'task', startAt: iso(MON, '09:00'), endAt: iso(MON, '10:00') }), /needs a task/);
  assert.throws(() => store.createBlock({ startAt: iso(MON, '10:00'), endAt: iso(MON, '09:00') }), /end after it starts/);
  assert.throws(() => store.createBlock({ startAt: MON, endAt: MON }), /needs a time of day/);
  assert.throws(() => store.createBlock({ kind: 'party', startAt: iso(MON, '09:00'), endAt: iso(MON, '10:00') }), /kind must be one of/);
  assert.throws(() => store.createBlock({ startAt: iso(MON, '09:00'), endAt: iso('2030-01-09', '09:00') }), /at most 24 hours/);

  const focus = store.createBlock({ taskId: task.id, startAt: `${MON}T13:00`, endAt: `${MON}T15:00` });
  assert.equal(focus.kind, 'task', 'a task makes it task time');
  const off = store.createBlock({ kind: 'off', allDay: true, startAt: '2030-01-11', title: 'Holiday' });
  assert.equal(off.endAt, '2030-01-11');

  const standup = store.createBlock({ title: 'Standup', startAt: `${MON}T09:30`, endAt: `${MON}T09:45`, repeat: 'weekdays' });
  // move only Wednesday's standup to 10:00
  const moved = store.updateBlock(standup.id, { startAt: '2030-01-09T10:00', endAt: '2030-01-09T10:15' }, { occurrence: '2030-01-09' });
  assert.notEqual(moved.id, standup.id);
  assert.equal(moved.repeat, null);
  assert.deepEqual(store.getBlock(standup.id).skips, ['2030-01-09']);
  // move the whole series to 9:00, using Thursday's times
  store.updateBlock(standup.id, { startAt: '2030-01-10T09:00', endAt: '2030-01-10T09:20' }, { occurrence: '2030-01-10', scope: 'all' });
  const week = store.listBlocks(range(MON, 7)).filter((o) => o.title === 'Standup');
  assert.deepEqual(week.map((o) => `${o.day} ${hhmm(o.start)}–${hhmm(o.end)}`), ['2030-01-07 09:00–09:20', '2030-01-08 09:00–09:20', '2030-01-09 10:00–10:15', '2030-01-10 09:00–09:20', '2030-01-11 09:00–09:20']);
  // removing one occurrence keeps the rest; removing the block removes them all
  assert.deepEqual(store.deleteBlock(standup.id, { occurrence: '2030-01-08' }), { skipped: '2030-01-08', blockId: standup.id });
  assert.equal(store.listBlocks(range(MON, 7)).filter((o) => o.blockId === standup.id).length, 3);
  assert.throws(() => store.deleteBlock(standup.id, { occurrence: '2030-01-12' }), /doesn’t happen on 2030-01-12/);
  store.deleteBlock(standup.id);
  assert.throws(() => store.getBlock(standup.id), /not found/);

  // task time shows its task, and goes when the task is deleted
  const [occ] = store.listBlocks(range(MON)).filter((o) => o.kind === 'task');
  assert.equal(occ.task.title, 'Write report');
  store.deleteTask(task.id);
  assert.throws(() => store.getBlock(focus.id), /not found/);
  store.deleteBlock(off.id);
  store.deleteBlock(moved.id);
});

test('calendar data and a suggested plan from the data layer', () => {
  const p = store.createProject({ name: 'Planning' });
  const a = store.createTask({ projectId: p.id, title: 'Slides', priority: 'high', estimateMinutes: 90, dueAt: '2030-01-09' });
  const b = store.createTask({ projectId: p.id, title: 'Read paper', priority: 'low', estimateMinutes: 60 });
  store.createTask({ projectId: p.id, title: 'Vague idea', priority: 'high' });
  store.createBlock({ taskId: a.id, startAt: '2030-01-07T09:00', endAt: '2030-01-07T10:00' });

  const data = store.calendar({ from: MON, to: '2030-01-13' });
  assert.deepEqual(data.settings.week, cal.DEFAULT_WEEK);
  assert.ok(data.tasks.some((x) => x.id === a.id && x.projectId === p.id));
  assert.equal(data.blocks.length, 1);
  assert.throws(() => store.calendar({ from: '2030-01-13', to: MON }), /before its start/);

  const now = new Date('2030-01-06T12:00').getTime();
  assert.equal(store.bookedMinutes(now)[a.id], 60);
  const plan = store.suggestSchedule({ from: MON, to: '2030-01-13', projectId: p.id, minPriority: 'high', now });
  assert.deepEqual(plan.bookings.map((x) => [x.taskId, x.minutes]), [[a.id, 30]], 'only what isn’t booked yet');
  assert.deepEqual(plan.needsEstimate.map((x) => x.title), ['Vague idea']);
  assert.ok(!plan.bookings.some((x) => x.taskId === b.id), 'low priority left out');
  // the user's longest session applies
  store.updateCalendarSettings({ sessionMinutes: 30 });
  const all = store.suggestSchedule({ from: MON, to: '2030-01-13', projectId: p.id, now });
  assert.ok(all.bookings.every((x) => x.minutes <= 30));
  store.updateCalendarSettings({ sessionMinutes: 120 });
});

test('the assistant and agents can book time and plan, with each booking reviewed', () => {
  const task = store.createTask({ title: 'Prepare demo', priority: 'urgent', estimateMinutes: 180, dueAt: '2099-01-09' });
  const [item] = actions.preview([{ type: 'create_block', title: 'Dentist', start: '2099-01-07T14:00', end: '2099-01-07T15:00' }]);
  assert.ok(item.ok, item.summary);
  assert.equal(item.verb, 'Block time');
  assert.match(item.summary, /“Dentist” · .* \(1h\)/);
  assert.equal(actions.preview([{ type: 'create_block', kind: 'off', title: 'Holiday', start: '2099-01-09' }])[0].verb, 'Time off');
  assert.match(actions.preview([{ type: 'create_block', start: '2099-01-07T14:00', end: '2099-01-07T13:00' }])[0].summary, /end after it starts/);

  // a plan becomes one booking per session, plus notes for what didn't fit
  const { items, actions: list } = actions.review([{ type: 'schedule_tasks', from: '2099-01-05', to: '2099-01-09', tasks: [task.id] }]);
  assert.ok(list.every((a) => a.type === 'create_block' && a.task === task.id));
  assert.equal(items.length, 2, '3h in sessions of at most 2h');
  assert.ok(items.every((i) => i.ok && i.verb === 'Book time'));
  const nothing = actions.review([{ type: 'schedule_tasks', from: '2099-01-05', to: '2099-01-09', tasks: [store.createTask({ title: 'No size' }).id] }]);
  assert.deepEqual(nothing.items.map((i) => [i.ok, i.verb]), [[false, 'Not planned']]);
  assert.match(nothing.items[0].summary, /No estimate/);

  const { applied } = actions.apply(list);
  assert.equal(applied.length, 2);
  assert.ok(applied.every((a) => a.blockId));
  assert.throws(() => actions.apply(nothing.actions), /No estimate/);

  // move one, and only agents can remove blocks
  const blockId = applied[0].blockId;
  const [move] = actions.preview([{ type: 'update_block', block: blockId, start: '2099-01-05T15:00', end: '2099-01-05T16:00' }]);
  assert.equal(move.verb, 'Move block');
  assert.match(actions.preview([{ type: 'delete_block', block: blockId }])[0].summary, /isn’t something the assistant can do/);
  assert.ok(actions.preview([{ type: 'delete_block', block: blockId }], { source: 'agent' })[0].ok);
  // agents asking first: the request stores the bookings, not the plan
  const other = store.createTask({ title: 'Tidy inbox', estimateMinutes: 60 });
  const p = actions.propose({ agent: 'Test', actions: [{ type: 'schedule_tasks', from: '2099-01-12', to: '2099-01-16', tasks: [other.id] }] });
  assert.deepEqual(p.actions.map((a) => a.type), ['create_block']);
  // a plan with nothing that fits (here: only after the deadline) isn't a request at all
  assert.throws(() => actions.propose({ agent: 'Test', actions: [{ type: 'schedule_tasks', from: '2099-01-12', to: '2099-01-16', tasks: [task.id] }] }), /doesn’t fit before its deadline/);
});

test('the assistant sees free time, blocks and overbooked days', () => {
  const now = new Date('2031-03-03T08:00'); // a Monday
  const big = store.createTask({ title: 'Huge job', priority: 'high', estimateMinutes: 1200, dueAt: '2031-03-04' });
  const meeting = store.createBlock({ title: 'Board meeting', startAt: '2031-03-03T10:00', endAt: '2031-03-03T11:30' });
  const text = chat.calendarContext({ now });
  assert.match(text, /Working hours: Mon–Fri 09:00–17:00/);
  assert.match(text, new RegExp(`\\[block ${meeting.id}\\] 10:00–11:30 Board meeting \\(busy\\)`));
  assert.match(text, /\(2031-03-03\), today: 6h 30m free of 8h working/);
  assert.match(text, /Free: 09:00–10:00, 11:30–17:00/);
  // Tuesday: 20h due (plus anything overdue), but only Monday's and Tuesday's free time to do it in
  assert.match(text, /\(2031-03-04\): 8h free of 8h working · ~20h of estimated work due · OVERBOOKED: \d+h/);
  assert.doesNotMatch(text, /\(2031-03-05\).*OVERBOOKED/);
  assert.match(chat.systemPrompt(text), /schedule_tasks/);
  store.deleteBlock(meeting.id);
  store.deleteTask(big.id);
});

test('calendar blocks remind shortly before they start', () => {
  const settings = { ...store.getReminderSettings() };
  const occ = (start, extra = {}) => ({ key: `1:${start}`, kind: 'busy', title: 'Standup', allDay: false, start: Date.parse(start), end: Date.parse(start) + 900000, ...extra });
  const now = new Date('2030-01-07T09:22').getTime();
  const list = [occ('2030-01-07T09:30'), occ('2030-01-07T09:45'), occ('2030-01-07T09:20'), occ('2030-01-07T09:30', { kind: 'off' }), occ('2030-01-07T09:30', { allDay: true })];
  assert.deepEqual(blockReminders(list, settings, now).map((o) => new Date(o.start).toTimeString().slice(0, 5)), ['09:30']);
  assert.deepEqual(blockReminders(list, { ...settings, blocks: false }, now), []);
  assert.match(blockMessage(list[0], now).title, /^Starts in 8 min · Standup$/);
  assert.equal(blockMessage(list[0], now).url, '/calendar');
  assert.throws(() => store.updateReminderSettings({ blockLead: 0 }), /between 1 and 240/);
});
