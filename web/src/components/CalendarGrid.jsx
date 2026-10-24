// The calendar's grids. Day and week: a time grid where you drag on empty time to block it,
// drag a block to move it, pull its bottom edge to resize it, and drop a task from the list to
// book time for it. Month: each day's free time, deadlines and blocks at a glance.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Repeat } from 'lucide-react';
import { dueInfo } from '../../../shared/due.js';
import { addDays, at, dayCapacity, dayDate, dayOf, formatMinutes, fromMinutes, SLOT } from '../../../shared/calendar.js';
import { useCalendar } from '../calendar';
import { toneClass } from './Due';
import { cx, Tip } from './ui';

export const HOUR = 44; // px per hour
const PX = HOUR / 60;
const GUTTER = 56;

/** The task being dragged from the list (dataTransfer can't be read while hovering). */
export const taskDrag = { current: null };

const snap = (min) => Math.max(0, Math.min(1440, Math.round(min / SLOT) * SLOT));
const nextDay = (day) => dayDate(addDays(day, 1)).getTime();
/** Minutes after midnight on `day`, by the local clock (so daylight-saving days still line up). */
function minuteOf(ms, day) {
  if (ms <= dayDate(day).getTime()) return 0;
  if (ms >= nextDay(day)) return 1440;
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}
const isoAt = (day, min) => new Date(at(day, fromMinutes(min))).toISOString();
const timeLabel = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const blockTitle = (b) => (b.kind === 'task' ? b.task?.title || 'Task time' : b.title || (b.kind === 'off' ? 'Time off' : 'Busy'));

/** Colour of a block: its project for task time, otherwise by kind. */
export function blockColor(b, projects) {
  if (b.kind === 'task') return projects?.find((p) => p.id === b.task?.projectId)?.color || 'blue';
  return b.kind === 'off' ? 'rose' : 'slate';
}

/** Side-by-side lanes for overlapping items in one day: sets `lane` and `lanes` on each. */
function layout(segs) {
  const sorted = [...segs].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out = [];
  let cluster = [];
  let end = -1;
  const flush = () => {
    const lanes = [];
    for (const s of cluster) {
      let i = lanes.findIndex((e) => e <= s.top);
      if (i < 0) i = lanes.push(0) - 1;
      lanes[i] = s.bottom;
      s.lane = i;
    }
    for (const s of cluster) s.lanes = lanes.length;
    out.push(...cluster);
    cluster = [];
  };
  for (const s of sorted) {
    if (cluster.length && s.top >= end) flush();
    cluster.push(s);
    end = Math.max(end, s.bottom);
  }
  if (cluster.length) flush();
  return out;
}

/** Deadlines that fall on `day`. */
const dueOn = (tasks, day) => tasks.filter((t) => t.dueAt && (t.dueHasTime ? dayOf(Date.parse(t.dueAt)) : t.dueAt) === day);

function DeadlineChip({ task, onOpen }) {
  const info = dueInfo(task.dueAt, task.dueHasTime);
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      title={`${task.title} · ${info?.label ?? ''}`}
      className={cx('flex w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] font-medium', task.done ? 'text-faint line-through' : toneClass[info?.tone] || 'bg-hover text-muted')}
    >
      <span className="size-1.5 shrink-0 rotate-45 rounded-[1px] bg-current" />
      <span className="truncate">
        {task.dueHasTime && `${timeLabel(Date.parse(task.dueAt))} `}
        {task.title}
      </span>
    </button>
  );
}

/** Free time (or the shortfall when the work due won't fit) under a day's name. */
function DayLoad({ cap, load, past }) {
  if (past) return <span className="text-faint"> </span>;
  if (load?.short) {
    return (
      <Tip label={`${formatMinutes(load.short)} more estimated work is due by the end of this day than you have free time`}>
        <span className="inline-flex items-center gap-1 font-medium text-danger">
          <AlertTriangle className="size-3" /> {formatMinutes(load.short)} over
        </span>
      </Tip>
    );
  }
  if (!cap.work) return <span className="text-faint">Day off</span>;
  return <span className={cap.freeLeft ? 'text-muted' : 'text-faint'}>{cap.freeLeft ? `${formatMinutes(cap.freeLeft)} free` : 'Fully booked'}</span>;
}

export function TimeGrid({ days, data, tasks, load, now, onOpenTask }) {
  const { settings, blocks, projects } = data;
  const { edit, updateBlock, createBlock } = useCalendar.getState();
  const suggestion = useCalendar((s) => s.suggestion);
  const toggleSuggested = useCalendar((s) => s.toggleSuggested);
  const today = dayOf(now);
  const scroller = useRef(null);
  const cols = useRef(null);
  const drag = useRef(null);
  const [preview, setPreview] = useState(null); // { kind: 'create'|'move'|'drop', day, a, b, key? }

  // open on the start of the working day (an hour before)
  const firstHour = useMemo(() => {
    const starts = settings.week.flat().map(([s]) => Number(s.slice(0, 2)));
    return Math.max(0, (starts.length ? Math.min(...starts) : 8) - 1);
  }, [settings.week]);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = firstHour * HOUR - 8;
  }, [firstHour, days.length]);

  const allDay = blocks.filter((b) => b.allDay);
  const timed = blocks.filter((b) => !b.allDay);

  const perDay = useMemo(
    () =>
      days.map((day) => {
        const from = dayDate(day).getTime();
        const to = nextDay(day);
        const segs = timed.filter((b) => b.start < to && b.end > from).map((b) => ({ b, top: minuteOf(b.start, day), bottom: Math.max(minuteOf(b.end, day), minuteOf(b.start, day) + SLOT) }));
        const ghosts = (suggestion?.bookings || [])
          .map((g, i) => ({ g, i, s: Date.parse(g.start), e: Date.parse(g.end) }))
          .filter(({ s, e }) => s < to && e > from)
          .map(({ g, i, s, e }) => ({ ghost: g, index: i, top: minuteOf(s, day), bottom: minuteOf(e, day) }));
        return { day, segs: layout([...segs, ...ghosts]), cap: dayCapacity(day, { week: settings.week, occurrences: blocks, now: now.getTime() }) };
      }),
    [days, timed, blocks, suggestion, settings.week, now]
  );

  // ---------- pointer: create, move, resize ----------

  const pointAt = (e) => {
    const r = cols.current.getBoundingClientRect();
    const i = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - r.left) / r.width) * days.length)));
    return { day: days[i], min: (e.clientY - r.top) / PX };
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('[data-block]')) return;
    const { day, min } = pointAt(e);
    const a = Math.floor(min / SLOT) * SLOT;
    cols.current.setPointerCapture(e.pointerId);
    drag.current = { kind: 'create', day, a, x0: e.clientX, y0: e.clientY, moved: false };
    setPreview({ kind: 'create', day, a, b: a + SLOT });
  };

  const beginBlock = (e, b, seg, mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    cols.current.setPointerCapture(e.pointerId);
    const { min } = pointAt(e);
    drag.current = { kind: mode, b, seg, grab: min - seg.top, len: Math.round((b.end - b.start) / 60000), x0: e.clientX, y0: e.clientY, moved: false };
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 4) d.moved = true;
    if (!d.moved) return;
    const { day, min } = pointAt(e);
    if (d.kind === 'create') {
      const cur = snap(min);
      setPreview({ kind: 'create', day: d.day, a: Math.min(d.a, cur), b: Math.max(d.a + SLOT, cur) });
    } else if (d.kind === 'move') {
      const a = Math.max(0, Math.min(1440 - SLOT, snap(min - d.grab)));
      setPreview({ kind: 'move', key: d.b.key, day, a, b: a + d.len });
    } else {
      setPreview({ kind: 'move', key: d.b.key, day: d.seg.day, a: d.seg.top, b: Math.max(d.seg.top + SLOT, snap(min)) });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = preview;
    setPreview(null);
    if (d.kind === 'create') {
      // a click blocks an hour; a drag blocks what was dragged over
      const b = d.moved && p ? p.b : Math.min(1440, d.a + 60);
      const a = d.moved && p ? p.a : d.a;
      return edit({ draft: { kind: 'busy', title: '', allDay: false, startAt: isoAt(d.day, a), endAt: isoAt(d.day, b) } });
    }
    if (!d.moved || !p) return edit({ occ: d.b });
    if (d.kind === 'move') {
      const startAt = isoAt(p.day, p.a);
      updateBlock(d.b, { startAt, endAt: new Date(Date.parse(startAt) + d.len * 60000).toISOString() });
    } else {
      updateBlock(d.b, { startAt: d.b.startAt, endAt: isoAt(p.day, p.b) });
    }
  };

  // ---------- dropping a task from the list ----------

  const onDragOver = (e) => {
    if (!taskDrag.current || !e.dataTransfer.types.includes('application/x-tt-task')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { day, min } = pointAt(e);
    const a = Math.min(1440 - SLOT, Math.floor(min / SLOT) * SLOT);
    setPreview({ kind: 'drop', day, a, b: Math.min(1440, a + taskDrag.current.minutes) });
  };
  const onDrop = (e) => {
    const t = taskDrag.current;
    const p = preview;
    taskDrag.current = null;
    setPreview(null);
    if (!t || !p || p.kind !== 'drop') return;
    e.preventDefault();
    createBlock({ kind: 'task', taskId: t.id, startAt: isoAt(p.day, p.a), endAt: isoAt(p.day, p.b) }).catch(() => {});
  };

  const nowMin = minuteOf(now.getTime(), today);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* day names, free time, and the all-day row */}
      <div className="flex border-b border-line pr-[var(--sbw,0px)]">
        <div className="shrink-0" style={{ width: GUTTER }} />
        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {perDay.map(({ day, cap }) => {
            const d = dayDate(day);
            const isToday = day === today;
            return (
              <div key={day} className="min-w-0 border-l border-line px-2 pb-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => days.length > 1 && useCalendar.getState().goTo(day, 'day')}
                  className={cx('flex items-baseline gap-1.5 rounded-md text-left', days.length > 1 && 'hover:text-accent')}
                >
                  <span className={cx('text-[11px] font-medium uppercase tracking-wider', isToday ? 'text-accent' : 'text-faint')}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <span className={cx('font-display text-[18px] leading-none', isToday ? 'text-accent' : 'text-fg')}>{d.getDate()}</span>
                </button>
                <div className="mt-0.5 truncate text-[11px]">
                  <DayLoad cap={cap} load={load[day]} past={day < today} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex border-b border-line pr-[var(--sbw,0px)]">
        <div className="shrink-0 py-1.5 pr-2 text-right text-[10.5px] text-faint" style={{ width: GUTTER }}>
          All day
        </div>
        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((day) => {
            const mine = allDay.filter((b) => b.startAt <= day && b.endAt >= day);
            const deadlines = dueOn(tasks, day);
            return (
              <div
                key={day}
                onDoubleClick={(e) => e.target === e.currentTarget && edit({ draft: { kind: 'off', title: '', allDay: true, startAt: day, endAt: day } })}
                title="Double-click to add time off or an all-day block"
                className="flex min-h-9 min-w-0 flex-col gap-0.5 border-l border-line p-1"
              >
                {mine.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    data-color={blockColor(b, projects)}
                    onClick={() => edit({ occ: b })}
                    className="flex min-w-0 items-center gap-1 rounded bg-[color-mix(in_oklab,var(--bar)_22%,var(--card))] px-1.5 py-0.5 text-left text-[11px] font-medium text-fg"
                  >
                    {b.repeat && <Repeat className="size-2.5 shrink-0 text-muted" />}
                    <span className="truncate">{blockTitle(b)}</span>
                  </button>
                ))}
                {deadlines.slice(0, 4).map((t) => (
                  <DeadlineChip key={t.id} task={t} onOpen={onOpenTask} />
                ))}
                {deadlines.length > 4 && <span className="px-1.5 text-[10.5px] text-faint">+{deadlines.length - 4} more due</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* the hours */}
      <div
        ref={(el) => {
          scroller.current = el;
          // header rows leave room for the scrollbar so the columns line up
          if (el) el.parentElement.style.setProperty('--sbw', `${el.offsetWidth - el.clientWidth}px`);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="relative flex" style={{ height: 24 * HOUR }}>
          <div className="relative shrink-0" style={{ width: GUTTER }}>
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-2 -translate-y-1/2 text-[10.5px] tabular-nums text-faint" style={{ top: (i + 1) * HOUR }}>
                {new Date(2000, 0, 1, i + 1).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </span>
            ))}
          </div>
          <div
            ref={cols}
            className="relative grid flex-1 touch-none select-none"
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => ((drag.current = null), setPreview(null))}
            onDragOver={onDragOver}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setPreview((p) => (p?.kind === 'drop' ? null : p))}
            onDrop={onDrop}
          >
            {perDay.map(({ day, segs }) => (
              <DayColumn
                key={day}
                day={day}
                segs={segs}
                week={settings.week}
                offDay={allDay.some((b) => b.kind === 'off' && b.startAt <= day && b.endAt >= day)}
                projects={projects}
                preview={preview}
                nowMin={day === today ? nowMin : null}
                beginBlock={beginBlock}
                toggleSuggested={toggleSuggested}
                skipped={suggestion?.skipped}
                titleOf={(id) => tasks.find((t) => t.id === id)?.title}
              />
            ))}
            {/* hour lines over the working-hours shading, under the blocks */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ backgroundImage: 'linear-gradient(to bottom, var(--border) 1px, transparent 1px)', backgroundSize: `100% ${HOUR}px` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DayColumn({ day, segs, week, offDay, projects, preview, nowMin, beginBlock, toggleSuggested, skipped, titleOf }) {
  const work = offDay ? [] : week[dayDate(day).getDay()] || [];
  const shown = preview && preview.day === day;
  return (
    <div className="relative border-l border-line bg-[color-mix(in_oklab,var(--text)_4%,transparent)]">
      {/* working hours are lighter than the rest of the day */}
      {work.map(([s, e]) => {
        const a = Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
        const b = Number(e.slice(0, 2)) * 60 + Number(e.slice(3));
        return <div key={s} className="absolute inset-x-0 bg-card" style={{ top: a * PX, height: (b - a) * PX }} />;
      })}

      {segs.map((s) =>
        s.ghost ? (
          <Ghost key={`g${s.index}`} seg={s} title={titleOf(s.ghost.taskId)} color={projects.find((p) => p.id === s.ghost.projectId)?.color} skipped={skipped?.has(s.index)} onToggle={() => toggleSuggested(s.index)} />
        ) : (
          <Block key={s.b.key} seg={{ ...s, day }} projects={projects} moving={preview?.kind === 'move' && preview.key === s.b.key} onBegin={beginBlock} />
        )
      )}

      {shown && (
        <div
          className={cx(
            'pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-dashed px-1.5 py-0.5 text-[11px] font-medium',
            preview.kind === 'drop' ? 'border-accent bg-accent-soft/70 text-fg' : 'border-accent/70 bg-accent-soft/50 text-fg'
          )}
          style={{ top: preview.a * PX, height: Math.max(SLOT, preview.b - preview.a) * PX }}
        >
          {fromMinutes(preview.a)}–{fromMinutes(Math.min(1440, preview.b)).replace('24:00', '0:00')}
        </div>
      )}

      {nowMin != null && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger" style={{ top: nowMin * PX }}>
          <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}

function Block({ seg, projects, moving, onBegin }) {
  const { b, top, bottom, lane, lanes } = seg;
  const h = (bottom - top) * PX;
  const short = h < 34;
  const done = b.kind === 'task' && b.task?.done;
  return (
    <div
      data-block
      data-color={blockColor(b, projects)}
      role="button"
      tabIndex={0}
      aria-label={`${blockTitle(b)}, ${timeLabel(b.start)} to ${timeLabel(b.end)}. Drag to move.`}
      onPointerDown={(e) => onBegin(e, b, seg, 'move')}
      onKeyDown={(e) => e.key === 'Enter' && useCalendar.getState().edit({ occ: b })}
      className={cx(
        'group/block absolute z-[5] cursor-grab overflow-hidden rounded-md border-l-[3px] border-[var(--bar)] px-1.5 text-[11.5px] leading-tight shadow-card outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing',
        b.kind === 'off' ? 'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--bar)_14%,var(--card))_0_6px,var(--card)_6px_12px)]' : 'bg-[color-mix(in_oklab,var(--bar)_18%,var(--card))]',
        moving && 'opacity-30',
        done && 'opacity-55'
      )}
      style={{ top: top * PX + 1, height: Math.max(h - 2, 14), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
    >
      <div className={cx('flex min-w-0 gap-1', short ? 'items-center py-0' : 'flex-col py-1')}>
        <span className={cx('truncate font-medium text-fg', done && 'line-through')}>
          {b.repeat && <Repeat className="mr-0.5 inline size-2.5 text-muted" />}
          {blockTitle(b)}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted">
          {timeLabel(b.start)}
          {!short && ` – ${timeLabel(b.end)}`}
        </span>
      </div>
      <span onPointerDown={(e) => onBegin(e, b, seg, 'resize')} title="Drag to change the end" className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" />
    </div>
  );
}

/** A suggested session: dashed until accepted. Click to leave it out (or back in). */
function Ghost({ seg, title, color, skipped, onToggle }) {
  const { ghost, top, bottom, lane, lanes } = seg;
  return (
    <button
      type="button"
      data-block
      data-color={color || 'blue'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
      title={skipped ? 'Left out of the plan. Click to add it back.' : 'Suggested. Click to leave it out.'}
      className={cx(
        'absolute z-[6] overflow-hidden rounded-md border-2 border-dashed border-[var(--bar)] px-1.5 py-0.5 text-left text-[11.5px] leading-tight transition-opacity',
        skipped ? 'bg-card/60 opacity-40' : 'bg-[color-mix(in_oklab,var(--bar)_10%,var(--card))]'
      )}
      style={{ top: top * PX + 1, height: Math.max((bottom - top) * PX - 2, 14), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
    >
      <span className={cx('block truncate font-medium text-fg', skipped && 'line-through')}>{title || `#${ghost.taskId}`}</span>
      <span className="block text-[10.5px] tabular-nums text-muted">
        {timeLabel(Date.parse(ghost.start))} – {timeLabel(Date.parse(ghost.end))}
      </span>
    </button>
  );
}

// ---------- month ----------

export function MonthGrid({ days, month, data, tasks, load, now, onOpenTask }) {
  const { settings, blocks, projects } = data;
  const today = dayOf(now);
  const { goTo } = useCalendar.getState();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-line">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
            {dayDate(d).toLocaleDateString(undefined, { weekday: 'short' })}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 overflow-y-auto">
        {days.map((day) => {
          const inMonth = day.slice(0, 7) === month;
          const cap = dayCapacity(day, { week: settings.week, occurrences: blocks, now: now.getTime() });
          const from = dayDate(day).getTime();
          const mine = blocks.filter((b) => b.start < nextDay(day) && b.end > from);
          const deadlines = dueOn(tasks, day);
          const meetings = mine.filter((b) => b.kind === 'busy').length;
          return (
            <div key={day} className={cx('flex min-h-[104px] min-w-0 flex-col gap-0.5 border-b border-l border-line p-1.5', !inMonth && 'bg-[color-mix(in_oklab,var(--text)_3%,transparent)]')}>
              <button type="button" onClick={() => goTo(day, 'day')} className="flex items-center justify-between gap-1 rounded text-left hover:text-accent">
                <span
                  className={cx(
                    'flex size-6 items-center justify-center rounded-full text-[12.5px] tabular-nums',
                    day === today ? 'bg-accent font-semibold text-accent-fg' : inMonth ? 'text-fg' : 'text-faint'
                  )}
                >
                  {dayDate(day).getDate()}
                </span>
                <span className="truncate text-[10.5px]">
                  <DayLoad cap={cap} load={load[day]} past={day < today} />
                </span>
              </button>
              {mine
                .filter((b) => b.allDay)
                .map((b) => (
                  <span key={b.key} data-color={blockColor(b, projects)} className="truncate rounded bg-[color-mix(in_oklab,var(--bar)_22%,var(--card))] px-1.5 text-[10.5px] font-medium text-fg">
                    {blockTitle(b)}
                  </span>
                ))}
              {deadlines.slice(0, 3).map((t) => (
                <DeadlineChip key={t.id} task={t} onOpen={onOpenTask} />
              ))}
              {deadlines.length > 3 && <span className="px-1.5 text-[10.5px] text-faint">+{deadlines.length - 3} more due</span>}
              {(meetings > 0 || cap.booked > 0) && (
                <span className="mt-auto truncate px-1 text-[10.5px] text-faint">
                  {[meetings && `${meetings} busy`, cap.booked && `${formatMinutes(cap.booked)} booked`].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
