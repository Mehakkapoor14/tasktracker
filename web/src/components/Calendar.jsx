// The calendar: your working hours, meetings, time off and time booked for tasks, with
// deadlines on top. Drag tasks from "To plan" onto free time, or ask for a suggested plan.
// Shown full-page at /calendar (every project) and as a project's Calendar view.
import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, GripVertical, Search, WandSparkles, X } from 'lucide-react';
import { dayCapacity, dayDate, dayOf, formatMinutes, unbooked, workload } from '../../../shared/calendar.js';
import { MODES, useCalendar, visibleDays } from '../calendar';
import { useBoard } from '../store';
import { navigate, projectPath } from '../router';
import { MonthGrid, taskDrag, TimeGrid } from './CalendarGrid';
import { BlockEditor } from './BlockEditor';
import { WorkHoursButton } from './WorkHours';
import { DueChip } from './Due';
import { PriorityIcon } from './TaskCard';
import { Logo, ThemePicker } from './TopBar';
import { InstallButton, RemindersButton } from './Reminders';
import { ChatButton } from './Chat';
import { AgentInboxButton } from './AgentInbox';
import { Button, cx, IconButton, Popover, PopoverContent, PopoverTrigger, Tip, useNow } from './ui';

const RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function rangeTitle(mode, days, anchor) {
  const d = (day, opts) => dayDate(day).toLocaleDateString(undefined, opts);
  if (mode === 'day') return d(anchor, { weekday: 'long', month: 'long', day: 'numeric' });
  if (mode === 'month') return d(anchor, { month: 'long', year: 'numeric' });
  const [a, b] = [days[0], days.at(-1)];
  return a.slice(0, 7) === b.slice(0, 7) ? `${d(a, { month: 'long', day: 'numeric' })} – ${dayDate(b).getDate()}` : `${d(a, { month: 'short', day: 'numeric' })} – ${d(b, { month: 'short', day: 'numeric' })}`;
}

/** Open a task: in place on its own board, otherwise on its project's board. */
function openTask(task, boardProjectId) {
  if (boardProjectId != null && task.projectId === boardProjectId) return useBoard.getState().select(task.id);
  useBoard.setState({ pendingSelect: task.id });
  navigate(projectPath(task.projectId));
}

export function CalendarView({ projectId = null }) {
  const data = useCalendar((s) => s.data);
  const mode = useCalendar((s) => s.mode);
  const anchor = useCalendar((s) => s.anchor);
  const boardTasks = useBoard((s) => s.tasks);
  const now = useNow(60000);

  useEffect(() => {
    useCalendar.setState((s) => ({ active: s.active + 1 }));
    useCalendar.getState().load();
    return () => useCalendar.setState((s) => ({ active: s.active - 1, suggestion: null, editing: null }));
  }, []);
  // edits made on this board (estimates, deadlines) don't come back as live updates to this tab
  useEffect(() => {
    if (projectId != null) useCalendar.getState().refresh();
  }, [projectId, boardTasks]);

  const days = useMemo(() => visibleDays(mode, anchor), [mode, anchor]);
  const tasks = useMemo(() => (data ? data.tasks.filter((t) => projectId == null || t.projectId === projectId) : []), [data, projectId]);
  // your time is shared by every project, so the workload check always counts all of them
  const load = useMemo(() => {
    if (!data) return {};
    return workload(days, { week: data.settings.week, occurrences: data.blocks, tasks: data.tasks.filter((t) => !t.done), booked: data.booked, now: now.getTime() });
  }, [data, days, now]);
  const open = (t) => openTask(t, projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar days={days} data={data} projectId={projectId} now={now} />
      <SuggestionBar />
      <div className="mx-6 mb-4 flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-card shadow-card">
        {!data ? (
          <div className="flex-1 animate-pulse bg-card/60" />
        ) : (
          <>
            {mode !== 'month' && <TaskList tasks={tasks} data={data} showProject={projectId == null} onOpen={open} />}
            {mode === 'month' ? (
              <MonthGrid days={days} month={anchor.slice(0, 7)} data={data} tasks={tasks} load={load} now={now} onOpenTask={open} />
            ) : (
              <TimeGrid days={days} data={data} tasks={tasks} load={load} now={now} onOpenTask={open} />
            )}
          </>
        )}
      </div>
      <BlockEditor onOpenTask={open} />
    </div>
  );
}

function Toolbar({ days, data, projectId, now }) {
  const mode = useCalendar((s) => s.mode);
  const anchor = useCalendar((s) => s.anchor);
  const { go, goTo, setMode } = useCalendar.getState();
  const today = dayOf(now);

  // the days on screen from today on: working time and how it's used
  const totals = useMemo(() => {
    if (!data) return null;
    const t = { work: 0, busy: 0, booked: 0, free: 0 };
    for (const d of days.filter((d) => d >= today && (mode !== 'month' || d.slice(0, 7) === anchor.slice(0, 7)))) {
      const c = dayCapacity(d, { week: data.settings.week, occurrences: data.blocks, now: now.getTime() });
      t.work += c.work;
      t.busy += c.busy;
      t.booked += c.booked;
      t.free += c.freeLeft;
    }
    return t;
  }, [data, days, today, now, mode, anchor]);

  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
      <Button variant="outline" size="sm" onClick={() => goTo(today)}>
        Today
      </Button>
      <IconButton label={`Previous ${mode}`} onClick={() => go(-1)}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <IconButton label={`Next ${mode}`} onClick={() => go(1)}>
        <ChevronRight className="size-4" />
      </IconButton>
      <h2 className="font-display mr-2 text-[18px] text-fg">{rangeTitle(mode, days, anchor)}</h2>
      {totals && totals.work > 0 && (
        <p className="hidden text-[12px] text-muted lg:block" title="Working time from today to the end of what’s shown">
          <span className="font-medium text-fg">{formatMinutes(totals.free)} free</span>
          {totals.busy > 0 && ` · ${formatMinutes(totals.busy)} busy`}
          {totals.booked > 0 && ` · ${formatMinutes(totals.booked)} booked for tasks`}
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        <div className="inline-flex h-8 items-center rounded-lg border border-line bg-card/70 p-0.5 text-[12px]" role="radiogroup" aria-label="Calendar range">
          {Object.entries(MODES).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              onClick={() => setMode(key)}
              className={cx('h-full rounded-md px-2.5 transition-colors', mode === key ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:text-fg')}
            >
              {label}
            </button>
          ))}
        </div>
        <WorkHoursButton />
        <PlanButton projectId={projectId} />
      </div>
    </div>
  );
}

/** Ask for a suggested plan of the days on screen. */
function PlanButton({ projectId }) {
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState('high');
  const [onlyHere, setOnlyHere] = useState(true);
  const mode = useCalendar((s) => s.mode);
  const run = () => {
    setOpen(false);
    useCalendar.getState().suggest({ minPriority: which === 'all' ? undefined : which, projectId: projectId != null && onlyHere ? projectId : undefined });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="primary">
          <WandSparkles className="size-4" /> Plan my {mode === 'day' ? 'day' : mode === 'week' ? 'week' : 'month'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[330px] p-4">
        <h3 className="font-display text-[16px] text-fg">Suggest a plan</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Fits what’s left of each task’s estimate into your free working time on the days shown, most important first and before deadlines. Nothing is booked until you accept it.
        </p>
        <div className="mt-3 space-y-1.5 text-[13px]">
          {[
            ['high', 'High priority and urgent tasks'],
            ['medium', 'Medium priority and up'],
            ['all', 'Every task with an estimate'],
          ].map(([k, l]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="radio" name="plan-which" checked={which === k} onChange={() => setWhich(k)} className="accent-[var(--accent)]" /> {l}
            </label>
          ))}
          {projectId != null && (
            <label className="flex items-center gap-2 border-t border-line pt-2 text-muted">
              <input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} className="accent-[var(--accent)]" /> Only tasks in this project
            </label>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" onClick={run}>
            Suggest a plan
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A suggested plan waiting for review: its sessions show dashed on the calendar. */
function SuggestionBar() {
  const s = useCalendar((x) => x.suggestion);
  const tasks = useCalendar((x) => x.data?.tasks);
  const { dismissSuggestion, acceptSuggestion } = useCalendar.getState();
  if (!s || (!s.bookings.length && !s.unplaced.length && !s.needsEstimate.length)) return null;
  const chosen = s.bookings.filter((_, i) => !s.skipped.has(i));
  const minutes = chosen.reduce((n, b) => n + b.minutes, 0);
  const sessions = (n) => `${n} session${n === 1 ? '' : 's'}`;
  return (
    <section aria-label="Suggested plan" className="mx-6 mb-3 rounded-xl border border-accent/40 bg-card px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <WandSparkles className="size-4 text-accent" />
        <span className="text-[13px] font-medium text-fg">
          {s.bookings.length ? `Suggested plan · ${sessions(chosen.length)} · ${formatMinutes(minutes)}` : 'Nothing could be planned'}
        </span>
        {s.bookings.length > 0 && <span className="text-[12px] text-faint">Click a dashed session to leave it out</span>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={dismissSuggestion}>
            <X className="size-3.5" /> Dismiss
          </Button>
          {s.bookings.length > 0 && (
            <Button size="sm" variant="primary" disabled={!chosen.length} onClick={acceptSuggestion}>
              Book {sessions(chosen.length)}
            </Button>
          )}
        </div>
      </div>
      {(s.unplaced.length > 0 || s.needsEstimate.length > 0) && (
        <ul className="mt-2 space-y-0.5 text-[12px] text-muted">
          {s.unplaced.map((u) => (
            <li key={u.taskId}>
              <span className={u.reason === 'deadline' ? 'text-danger' : 'text-warn'}>●</span> {tasks?.find((t) => t.id === u.taskId)?.title ?? u.title}: {formatMinutes(u.minutes)}{' '}
              {u.reason === 'deadline' ? 'won’t fit before its deadline' : 'doesn’t fit in the free time shown'}
            </li>
          ))}
          {s.needsEstimate.length > 0 && (
            <li>
              <span className="text-faint">●</span> Not planned, no estimate: {s.needsEstimate.map((t) => t.title).join(', ')}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Open tasks with time still to book (or no estimate yet). Drag one onto the calendar. */
function TaskList({ tasks, data, showProject, onOpen }) {
  const [q, setQ] = useState('');
  const projects = useMemo(() => new Map(data.projects.map((p) => [p.id, p])), [data.projects]);
  const session = data.settings.sessionMinutes;
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return tasks
      .filter((t) => !t.done)
      .map((t) => ({ t, left: unbooked(t, data.booked[t.id] || 0) }))
      .filter(({ t, left }) => left !== 0 && words.every((w) => `${t.title} ${(t.tags || []).join(' ')}`.toLowerCase().includes(w)))
      .sort((a, b) => RANK[a.t.priority] - RANK[b.t.priority] || (a.t.dueAt || '9999').localeCompare(b.t.dueAt || '9999') || (a.left == null) - (b.left == null));
  }, [tasks, data.booked, q]);

  return (
    <aside className="hidden w-[250px] shrink-0 flex-col border-r border-line lg:flex">
      <div className="border-b border-line px-3 pb-2 pt-2.5">
        <div className="flex items-baseline gap-2">
          <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">To plan</h3>
          <span className="text-[11px] tabular-nums text-faint">{list.length}</span>
        </div>
        <p className="mt-0.5 text-[11.5px] text-faint">Drag onto the calendar to book time</p>
        <label className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg/50 px-2">
          <Search className="size-3.5 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter tasks to plan" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
        </label>
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {list.length === 0 && <li className="px-1 py-6 text-center text-[12.5px] text-faint">{q ? 'No matching tasks' : 'Everything with an estimate is booked.'}</li>}
        {list.slice(0, 150).map(({ t, left }) => (
          <li
            key={t.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-tt-task', String(t.id));
              e.dataTransfer.effectAllowed = 'copy';
              // a task books what's left of its estimate, up to one session (an hour without an estimate)
              taskDrag.current = { id: t.id, minutes: left ? Math.min(session, Math.ceil(left / 15) * 15) : 60 };
            }}
            onDragEnd={() => (taskDrag.current = null)}
            className="group/task flex cursor-grab items-start gap-1.5 rounded-lg border border-line bg-card px-2 py-1.5 shadow-card hover:border-line-strong active:cursor-grabbing"
          >
            <GripVertical className="mt-0.5 size-3.5 shrink-0 text-faint opacity-0 group-hover/task:opacity-100" />
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => onOpen(t)} className="block w-full truncate text-left text-[12.5px] text-fg hover:underline">
                {showProject && <span className="mr-1">{projects.get(t.projectId)?.icon}</span>}
                {t.title}
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {t.priority !== 'none' && <PriorityIcon priority={t.priority} />}
                <span className={cx('inline-flex h-[18px] items-center rounded px-1.5 font-mono text-[10.5px]', left == null ? 'text-faint' : 'bg-hover text-muted')}>
                  {left == null ? 'no estimate' : `${formatMinutes(left)} left`}
                </span>
                <DueChip dueAt={t.dueAt} hasTime={t.dueHasTime} compact />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** The calendar on its own page, with every project. */
export function CalendarPage() {
  useEffect(() => {
    document.title = 'Calendar · Task Tracker';
  }, []);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pb-4 pt-5">
        <Tip label="All projects">
          <button type="button" aria-label="All projects" onClick={() => navigate('/')} className="rounded-[10px] transition-transform hover:scale-105 active:scale-95">
            <Logo />
          </button>
        </Tip>
        <div className="leading-tight">
          <h1 className="font-display flex items-center gap-2 text-[22px] text-fg">
            <CalendarDays className="size-5 text-accent" /> Calendar
          </h1>
          <p className="text-[12px] text-muted">Every project · your working hours, meetings and booked time</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <AgentInboxButton />
          <ChatButton />
          <RemindersButton />
          <ThemePicker />
          <InstallButton />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <CalendarView />
      </main>
    </div>
  );
}
