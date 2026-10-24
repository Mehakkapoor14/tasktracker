// Add or edit a calendar block: a meeting (busy), time off, or time booked for a task.
// Changing one event of a repeating block asks whether it's just this one or all of them.
import { useEffect, useState } from 'react';
import { ExternalLink, Repeat, Trash2 } from 'lucide-react';
import { REPEATS } from '../../../shared/repeat.js';
import { BLOCK_KINDS, dayOf, fromMinutes, spanLabel } from '../../../shared/calendar.js';
import { useCalendar } from '../calendar';
import { blockTitle } from './CalendarGrid';
import { Button, cx, Dialog } from './ui';

const timeOf = (iso) => {
  const d = new Date(iso);
  return fromMinutes(d.getHours() * 60 + d.getMinutes());
};
const inputCls = 'h-8 rounded-lg border border-line bg-bg/60 px-2 text-[13px] outline-none focus:border-accent';

/** Form state from a block (or a new draft). Dates and times are local inputs. */
function formOf(b) {
  const end = b.allDay ? b.endAt : dayOf(Date.parse(b.endAt));
  return {
    kind: b.kind,
    title: b.title || '',
    note: b.note || '',
    allDay: !!b.allDay,
    date: b.allDay ? b.startAt : dayOf(Date.parse(b.startAt)),
    endDate: end,
    start: b.allDay ? '09:00' : timeOf(b.startAt),
    end: b.allDay ? '10:00' : timeOf(b.endAt),
    repeat: b.repeat || '',
    repeatUntil: b.repeatUntil || '',
  };
}

/** The API fields for a form. A timed block ending at or before its start runs past midnight. */
function fieldsOf(f) {
  if (f.allDay) return { kind: f.kind, title: f.title, note: f.note, allDay: true, startAt: f.date, endAt: f.endDate < f.date ? f.date : f.endDate, repeat: f.repeat || null, repeatUntil: f.repeat ? f.repeatUntil || null : null };
  const startAt = new Date(`${f.date}T${f.start}`);
  const endAt = new Date(`${f.date}T${f.end}`);
  if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  return { kind: f.kind, title: f.title, note: f.note, allDay: false, startAt: startAt.toISOString(), endAt: endAt.toISOString(), repeat: f.repeat || null, repeatUntil: f.repeat ? f.repeatUntil || null : null };
}

export function BlockEditor({ onOpenTask }) {
  const editing = useCalendar((s) => s.editing);
  const { edit, createBlock, updateBlock, deleteBlock } = useCalendar.getState();
  const occ = editing?.occ;
  const source = occ || editing?.draft;
  const [form, setForm] = useState(null);
  const [scope, setScope] = useState('one');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (source) setForm(formOf(source));
    setScope('one');
  }, [source]);

  if (!form) return null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const repeating = !!occ?.repeat;
  const isTask = form.kind === 'task';
  const close = () => edit(null);

  const save = async () => {
    setBusy(true);
    try {
      const fields = fieldsOf(form);
      if (!occ) await createBlock(fields);
      else {
        // only what changed, so editing the series doesn't move every event to this one's day
        const before = fieldsOf(formOf(occ));
        const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
        if (Object.keys(patch).length) {
          // a new time moves the start and end together
          if (patch.startAt || patch.endAt) Object.assign(patch, { startAt: fields.startAt, endAt: fields.endAt, allDay: fields.allDay });
          await updateBlock(occ, patch, repeating ? scope : undefined);
        }
      }
      close();
    } catch {
      // the store already said what went wrong
    } finally {
      setBusy(false);
    }
  };

  const remove = async (which) => {
    close();
    await deleteBlock(occ, which);
  };

  return (
    <Dialog
      open={!!editing}
      onOpenChange={(o) => !o && close()}
      title={occ ? (isTask ? 'Task time' : 'Edit block') : form.allDay ? 'Add an all-day block' : 'Block time'}
      description={occ ? spanLabel(occ) : 'Busy time and time off aren’t used for planning tasks.'}
      className="w-[min(94vw,480px)]"
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {isTask ? (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-bg/40 px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{blockTitle(occ)}</span>
            {occ?.task && (
              <Button size="sm" variant="ghost" onClick={() => (close(), onOpenTask(occ.task))}>
                <ExternalLink className="size-3.5" /> Open task
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="inline-flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Kind">
              {['busy', 'off'].map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={form.kind === k}
                  title={BLOCK_KINDS[k].hint}
                  onClick={() => set({ kind: k })}
                  className={cx('h-7 rounded-md px-3 text-[12.5px] transition-colors', form.kind === k ? 'bg-accent-soft font-medium text-fg shadow-sm' : 'text-muted hover:text-fg')}
                >
                  {k === 'busy' ? 'Busy · meeting' : 'Time off'}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder={form.kind === 'off' ? 'Holiday, day off…' : 'Standup, dentist, school run…'}
              aria-label="Title"
              className="h-10 w-full rounded-lg border border-line bg-bg/60 px-3 text-[14px] outline-none focus:border-accent"
            />
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input type="date" aria-label="Date" value={form.date} onChange={(e) => e.target.value && set({ date: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} className={inputCls} />
          {form.allDay ? (
            <>
              <span className="text-[12px] text-faint">to</span>
              <input type="date" aria-label="Last day" value={form.endDate} min={form.date} onChange={(e) => e.target.value && set({ endDate: e.target.value })} className={inputCls} />
            </>
          ) : (
            <>
              <input type="time" step={900} aria-label="Start" value={form.start} onChange={(e) => e.target.value && set({ start: e.target.value })} className={inputCls} />
              <span className="text-[12px] text-faint">–</span>
              <input type="time" step={900} aria-label="End" value={form.end} onChange={(e) => e.target.value && set({ end: e.target.value })} className={inputCls} />
            </>
          )}
          {!isTask && (
            <label className="ml-auto flex items-center gap-1.5 text-[12.5px] text-muted">
              <input type="checkbox" checked={form.allDay} onChange={(e) => set({ allDay: e.target.checked })} className="accent-[var(--accent)]" /> All day
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Repeat className="size-3.5 text-faint" />
          <select aria-label="Repeat" value={form.repeat} onChange={(e) => set({ repeat: e.target.value })} className={inputCls}>
            <option value="">Doesn’t repeat</option>
            {Object.entries(REPEATS).map(([k, r]) => (
              <option key={k} value={k}>
                {r.label}
              </option>
            ))}
          </select>
          {form.repeat && (
            <>
              <span className="text-[12px] text-faint">until</span>
              <input type="date" aria-label="Repeat until" value={form.repeatUntil} min={form.date} onChange={(e) => set({ repeatUntil: e.target.value })} className={inputCls} />
              {form.repeatUntil && (
                <button type="button" onClick={() => set({ repeatUntil: '' })} className="text-[12px] text-faint hover:text-fg">
                  forever
                </button>
              )}
            </>
          )}
        </div>

        <textarea value={form.note} onChange={(e) => set({ note: e.target.value })} rows={2} placeholder="Note (optional)" aria-label="Note" className="w-full rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13px] outline-none focus:border-accent" />

        {repeating && (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-bg/40 px-3 py-2 text-[12.5px]">
            <span className="text-muted">Save changes to</span>
            <div className="inline-flex rounded-lg border border-line bg-card p-0.5" role="radiogroup" aria-label="Which events">
              {[
                ['one', 'This event'],
                ['all', 'All events'],
              ].map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={scope === k}
                  onClick={() => setScope(k)}
                  className={cx('h-6 rounded-md px-2.5 transition-colors', scope === k ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:text-fg')}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {occ &&
            (repeating ? (
              <>
                <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => remove('one')}>
                  <Trash2 className="size-3.5" /> Delete this one
                </Button>
                <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => remove('all')}>
                  Delete all
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => remove('all')}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            ))}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {occ ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
