import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-repeat-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
const actions = await import('../server/actions.js');
const { nextDates, parseRepeat } = await import('../shared/repeat.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

const at = (day) => new Date(`${day}T10:00`); // "now", in local time

test('reads repeat names people use', () => {
  assert.equal(parseRepeat('Daily'), 'daily');
  assert.equal(parseRepeat('every week'), 'weekly');
  assert.equal(parseRepeat('fortnightly'), 'biweekly');
  assert.equal(parseRepeat(''), '');
  assert.equal(parseRepeat('hourly'), null);
});

test('moves the deadline on, never leaving the next one overdue', () => {
  const now = at('2026-10-14'); // a Wednesday
  assert.equal(nextDates({ dueAt: '2026-10-14' }, 'daily', now).dueAt, '2026-10-15');
  assert.equal(nextDates({ dueAt: '2026-10-01' }, 'weekly', now).dueAt, '2026-10-15', 'skips missed weeks');
  assert.equal(nextDates({ dueAt: '2026-10-20' }, 'weekly', now).dueAt, '2026-10-27', 'finished early: one step on');
  assert.equal(nextDates({ dueAt: '2026-10-16' }, 'weekdays', at('2026-10-16')).dueAt, '2026-10-19', 'Friday → Monday');
  assert.equal(nextDates({ dueAt: '2026-01-31' }, 'monthly', at('2026-01-31')).dueAt, '2026-02-28');
  assert.equal(nextDates({ dueAt: '2026-10-14' }, 'yearly', now).dueAt, '2027-10-14');
});

test('keeps the start the same distance before the deadline, and the time of day', () => {
  const now = at('2026-10-14');
  assert.deepEqual(nextDates({ dueAt: '2026-10-16', startAt: '2026-10-13' }, 'weekly', now), { dueAt: '2026-10-23', startAt: '2026-10-20' });
  const due = new Date('2026-10-14T09:30').toISOString();
  const next = new Date(nextDates({ dueAt: due, dueHasTime: true }, 'daily', now).dueAt);
  assert.equal(`${next.getDate()} ${next.getHours()}:${next.getMinutes()}`, '15 9:30');
  assert.deepEqual(nextDates({}, 'weekly', now), { dueAt: '2026-10-21', startAt: null }, 'no dates: due a step from today');
});

test('finishing a repeating task adds the next one; reopening takes it back', () => {
  const t = store.createTask({ title: 'Water plants', dueAt: '2030-01-06', repeat: 'weekly', subtasks: ['Ferns'], tags: ['home'] });
  store.updateSubtask(t.subtasks[0].id, { done: true });
  const open = store.getColumn(t.columnId);

  store.completeTask(t.id);
  const next = store.listTasks({ query: 'Water plants' }).find((x) => x.id !== t.id);
  assert.ok(next, 'next one created');
  assert.equal(next.dueAt, '2030-01-13');
  assert.equal(next.repeat, 'weekly');
  assert.equal(next.columnId, open.id);
  assert.deepEqual(next.subtasks.map((s) => [s.title, s.done]), [['Ferns', false]]);
  assert.deepEqual(next.tags, ['home']);
  assert.equal(store.getTask(t.id).repeat, null, 'the repeat moved to the new task');

  store.moveTask(t.id, { columnId: open.id }); // undo
  assert.throws(() => store.getTask(next.id), /not found/);
  assert.equal(store.getTask(t.id).repeat, 'weekly');

  // once the next one has been worked on, reopening leaves it alone
  store.completeTask(t.id);
  const kept = store.listTasks({ query: 'Water plants' }).find((x) => x.id !== t.id);
  store.updateTask(kept.id, { priority: 'high' });
  store.moveTask(t.id, { columnId: open.id });
  assert.equal(store.getTask(kept.id).repeat, 'weekly');
});

test('chat and agents can set a repeat in plain words', () => {
  const t = store.createTask({ title: 'Pay rent' });
  const [item] = actions.preview([{ type: 'update_task', task: t.id, repeat: 'every month' }]);
  assert.match(item.summary, /repeat every month/);
  actions.apply([{ type: 'update_task', task: t.id, repeat: 'monthly' }]);
  assert.equal(store.getTask(t.id).repeat, 'monthly');
  assert.match(actions.preview([{ type: 'update_task', task: t.id, repeat: 'hourly' }])[0].summary, /isn’t a repeat/);
  assert.throws(() => store.updateTask(t.id, { repeat: 'sometimes' }), /repeat must be one of/);
});
