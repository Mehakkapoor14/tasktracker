// Working hours for each day of the week (with breaks), and the longest session a suggested
// plan books. Saves as you go, once the times make sense.
import { useEffect, useState } from 'react';
import { Clock, Plus, X } from 'lucide-react';
import { cleanWeek, formatMinutes, fromMinutes, toMinutes, weekMinutes, WEEKDAYS } from '../../../shared/calendar.js';
import { useCalendar } from '../calendar';
import { Button, cx, Popover, PopoverContent, PopoverTrigger, Tip } from './ui';

const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const weekdays = (ranges) => [[], ranges, ranges, ranges, ranges, ranges, []];
const PRESETS = [
  ['Mon–Fri 9–5', weekdays([['09:00', '17:00']])],
  ['Mon–Fri 9–6, lunch 1–2', weekdays([['09:00', '13:00'], ['14:00', '18:00']])],
  ['Mon–Fri 8–4', weekdays([['08:00', '16:00']])],
];
const SESSIONS = [60, 90, 120, 180, 240];
const timeCls = 'h-7 w-[92px] rounded-md border border-line bg-bg/60 px-1.5 text-[12.5px] tabular-nums outline-none focus:border-accent';

export function WorkHoursButton() {
  const settings = useCalendar((s) => s.data?.settings);
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && settings) (setWeek(settings.week), setError(''));
  }, [open, settings]);

  const change = (next) => {
    setWeek(next);
    try {
      const clean = cleanWeek(next);
      setError('');
      useCalendar.getState().saveSettings({ week: clean });
    } catch (err) {
      setError(err.message);
    }
  };
  const setDay = (i, ranges) => change(week.map((r, j) => (j === i ? ranges : r)));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Working hours">
        <PopoverTrigger asChild>
          <Button variant="ghost" aria-label="Working hours">
            <Clock className="size-4" /> <span className="hidden xl:inline">Working hours</span>
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-[380px] p-4">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display flex-1 text-[16px] text-fg">Working hours</h3>
          {week && <span className="text-[12px] tabular-nums text-faint">{formatMinutes(weekMinutes(week))} a week</span>}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">Plans only use these hours. Time outside them is shaded on the calendar.</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {PRESETS.map(([label, preset]) => (
            <button key={label} type="button" onClick={() => change(preset)} className="h-6 rounded-full border border-line px-2.5 text-[11.5px] text-muted hover:border-line-strong hover:text-fg">
              {label}
            </button>
          ))}
        </div>
        {week && (
          <div className="mt-3 divide-y divide-line">
            {ORDER.map((i) => {
              const ranges = week[i];
              const on = ranges.length > 0;
              return (
                <div key={i} className="flex items-start gap-2 py-1.5">
                  <label className="flex w-14 shrink-0 items-center gap-1.5 pt-1 text-[12.5px] text-fg">
                    <input type="checkbox" checked={on} onChange={(e) => setDay(i, e.target.checked ? [['09:00', '17:00']] : [])} className="accent-[var(--accent)]" />
                    {WEEKDAYS[i]}
                  </label>
                  <div className="min-w-0 flex-1 space-y-1">
                    {!on && <p className="pt-1 text-[12px] text-faint">Not working</p>}
                    {ranges.map(([s, e], k) => (
                      <div key={k} className="flex items-center gap-1">
                        <input type="time" step={900} aria-label={`${WEEKDAYS[i]} from`} value={s} onChange={(ev) => ev.target.value && setDay(i, ranges.map((r, n) => (n === k ? [ev.target.value, r[1]] : r)))} className={timeCls} />
                        <span className="text-[12px] text-faint">–</span>
                        <input type="time" step={900} aria-label={`${WEEKDAYS[i]} until`} value={e} onChange={(ev) => ev.target.value && setDay(i, ranges.map((r, n) => (n === k ? [r[0], ev.target.value] : r)))} className={timeCls} />
                        <button type="button" aria-label="Remove these hours" onClick={() => setDay(i, ranges.filter((_, n) => n !== k))} className="rounded p-1 text-faint hover:text-danger">
                          <X className="size-3.5" />
                        </button>
                        {k === ranges.length - 1 && ranges.length < 6 && (
                          <Tip label="Add more hours (after a break)">
                            <button
                              type="button"
                              aria-label="Add more hours"
                              onClick={() => {
                                // an hour's break, then an hour more
                                const from = Math.min(23 * 60, toMinutes(e) + 60);
                                setDay(i, [...ranges, [fromMinutes(from), fromMinutes(Math.min(1440, from + 60))]]);
                              }}
                              className="rounded p-1 text-faint hover:text-fg"
                            >
                              <Plus className="size-3.5" />
                            </button>
                          </Tip>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <span className="flex-1 text-[12.5px] text-fg">
            Longest planned session
            <span className="block text-[11.5px] text-faint">Longer tasks are split across free time</span>
          </span>
          <div className="inline-flex rounded-lg border border-line p-0.5 text-[12px]">
            {SESSIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => useCalendar.getState().saveSettings({ sessionMinutes: m })}
                className={cx('h-6 rounded-md px-2 tabular-nums transition-colors', settings?.sessionMinutes === m ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:text-fg')}
              >
                {formatMinutes(m)}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
