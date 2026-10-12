import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Archive, Check, ChevronDown, FolderInput, GripVertical, MoreHorizontal, Pause, Play, Plus, Repeat, Trash2, X } from 'lucide-react';
import { formatDuration } from '../../../shared/due.js';
import { nextDates, REPEATS } from '../../../shared/repeat.js';
import { useBoard } from '../store';
import { DuePicker, dueDay, StartPicker } from './Due';
import { TagEditor } from './Tags';
import { ClaimBanner } from './Claim';
import { EstimatePicker } from './Estimate';
import { NoteField } from './Note';
import { PRIORITY, PriorityIcon } from './TaskCard';
import { Button, ColorDot, cx, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Sheet, useNow } from './ui';

/** Textarea that grows with its content and autosaves (debounced + on blur). */
function AutoField({ value, onSave, className, placeholder, singleLine, autoFocus, minRows = 1 }) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const timer = useRef();
  const ref = useRef(null);

  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [local]);

  const flush = (v = local) => {
    clearTimeout(timer.current);
    if (v !== value && !(singleLine && !v.trim())) onSave(v);
  };

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={local}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        flush();
        if (singleLine && !local.trim()) setLocal(value);
      }}
      onChange={(e) => {
        const v = singleLine ? e.target.value.replace(/\n/g, ' ') : e.target.value;
        setLocal(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(v), 600);
      }}
      onKeyDown={(e) => {
        if (singleLine && e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={cx('block w-full overflow-hidden bg-transparent outline-none placeholder:text-faint', className)}
    />
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-3 py-1.5">
      <div className="pt-1.5 text-[12px] text-faint">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Section({ title, aside, children }) {
  return (
    <section className="px-6 py-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StatusPicker({ task }) {
  const columns = useBoard((s) => s.columns);
  const moveTask = useBoard((s) => s.moveTask);
  const current = columns.find((c) => c.id === task.columnId);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5 text-[13px] hover:bg-hover">
          <ColorDot color={current?.color} />
          {current?.name}
          {current?.hidden && <span className="text-faint">(hidden)</span>}
          <ChevronDown className="size-3.5 text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        {columns
          .filter((c) => !c.hidden)
          .map((c) => (
            <MenuItem key={c.id} onSelect={() => c.id !== task.columnId && moveTask(task.id, c.id, 0)}>
              <ColorDot color={c.color} /> <span className="flex-1">{c.name}</span>
              {c.id === task.columnId && <Check className="!text-accent" />}
            </MenuItem>
          ))}
      </MenuContent>
    </Menu>
  );
}

function PriorityPicker({ task }) {
  const updateTask = useBoard((s) => s.updateTask);
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5">
      {Object.entries(PRIORITY).map(([key, p]) => (
        <button
          key={key}
          type="button"
          title={p.label}
          onClick={() => updateTask(task.id, { priority: key })}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors',
            task.priority === key ? 'bg-accent-soft text-fg shadow-sm' : 'text-muted hover:text-fg'
          )}
        >
          {key === 'none' ? 'None' : <PriorityIcon priority={key} />}
          {key !== 'none' && <span className="hidden sm:inline">{p.label}</span>}
        </button>
      ))}
    </div>
  );
}

/** How often the task comes back. Finishing it adds the next one; the hint says when that will be due. */
function RepeatPicker({ task }) {
  const updateTask = useBoard((s) => s.updateTask);
  const next = task.repeat && nextDates(task, task.repeat);
  const nextDay = next && (next.dueAt || next.startAt);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className={cx('inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5 text-[13px] hover:bg-hover', !task.repeat && 'text-muted')}>
            <Repeat className="size-3.5 text-faint" />
            {task.repeat ? REPEATS[task.repeat].label : 'Doesn’t repeat'}
            <ChevronDown className="size-3.5 text-faint" />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          {[['', 'Doesn’t repeat'], ...Object.entries(REPEATS).map(([k, r]) => [k, r.label])].map(([key, label]) => (
            <MenuItem key={key || 'none'} onSelect={() => (task.repeat || '') !== key && updateTask(task.id, { repeat: key || null })}>
              <span className="flex-1">{label}</span>
              {(task.repeat || '') === key && <Check className="!text-accent" />}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {nextDay && (
        <span className="text-[12px] text-faint">
          Next one {next.dueAt ? 'due' : 'starts'} {new Date(nextDay.length > 10 ? nextDay : `${nextDay}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} when this is done
        </span>
      )}
    </div>
  );
}

function TimeTracker({ task }) {
  const { startTimer, stopTimer } = useBoard.getState();
  const running = !!task.timerStartedAt;
  const now = useNow(1000, running);
  const total = task.timeSpent + (running ? Math.max(0, (now - Date.parse(task.timerStartedAt)) / 1000) : 0);
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant={running ? 'primary' : 'outline'} onClick={() => (running ? stopTimer(task.id) : startTimer(task.id))}>
        {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        {running ? 'Pause' : total ? 'Resume' : 'Start timer'}
      </Button>
      <span className={cx('font-mono text-[13px] tabular-nums', running ? 'text-accent' : 'text-muted')}>{total ? formatDuration(total) : '—'}</span>
      {running && <span className="pulse size-1.5 rounded-full bg-accent" />}
    </div>
  );
}

/** One subtask; drag it by the grip (the title stays editable text). */
function SubtaskRow({ task, sub: s }) {
  const { updateSubtask, deleteSubtask } = useBoard.getState();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: s.id, disabled: typeof s.id === 'string' });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('group/sub relative flex items-start gap-2 rounded-lg px-2 py-1 hover:bg-hover/60', isDragging && 'z-10 bg-card shadow-lift')}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder “${s.title}”`}
        className="mt-1 shrink-0 cursor-grab touch-none rounded text-faint opacity-0 focus-visible:opacity-100 active:cursor-grabbing group-hover/sub:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={s.done ? 'Mark not done' : 'Mark done'}
        onClick={() => updateSubtask(task.id, s.id, { done: !s.done })}
        className={cx(
          'mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
          s.done ? 'border-ok bg-ok text-card' : 'border-line-strong hover:border-ok'
        )}
      >
        {s.done && <Check className="size-3" strokeWidth={3.5} />}
      </button>
      <AutoField
        singleLine
        value={s.title}
        onSave={(title) => updateSubtask(task.id, s.id, { title })}
        className={cx('text-[13.5px] leading-[22px]', s.done && 'text-muted line-through decoration-faint')}
      />
      <button
        type="button"
        aria-label="Delete subtask"
        onClick={() => deleteSubtask(task.id, s.id)}
        className="mt-0.5 rounded p-0.5 text-faint opacity-0 hover:text-danger group-hover/sub:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
}

function Subtasks({ task }) {
  const { addSubtask, reorderSubtask } = useBoard.getState();
  const [draft, setDraft] = useState('');
  const done = task.subtasks.filter((s) => s.done).length;
  const total = task.subtasks.length;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }) => {
    if (over && active.id !== over.id) reorderSubtask(task.id, active.id, task.subtasks.findIndex((s) => s.id === over.id));
  };

  return (
    <Section
      title="Subtasks"
      aside={
        total > 0 && (
          <span className="flex flex-1 items-center gap-2 text-[11px] tabular-nums text-faint">
            {done}/{total}
            <span className="h-1 max-w-[120px] flex-1 overflow-hidden rounded-full bg-hover">
              <span className="block h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${(done / total) * 100}%` }} />
            </span>
          </span>
        )
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={task.subtasks.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="-mx-2">
            {task.subtasks.map((s) => (
              <SubtaskRow key={s.id} task={task} sub={s} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="mt-1 flex items-center gap-2 rounded-lg px-0 py-1">
        <Plus className="ml-[22px] size-4 shrink-0 text-faint" />
        <input
          value={draft}
          placeholder="Add a subtask…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              addSubtask(task.id, draft.trim());
              setDraft('');
            }
          }}
          className="h-7 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
        />
      </div>
    </Section>
  );
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Submenu listing the other active projects; the task keeps its column name when the target has one. */
function MoveToProject({ task }) {
  const projectId = useBoard((s) => s.projectId);
  const projects = useBoard((s) => s.projects);
  const others = projects.filter((p) => !p.archived && p.id !== projectId);
  return (
    <MenuSub>
      <MenuSubTrigger disabled={!others.length}>
        <FolderInput /> Move to project
      </MenuSubTrigger>
      <MenuSubContent className="max-h-[50vh] min-w-[200px] overflow-y-auto">
        {others.map((p) => (
          <MenuItem key={p.id} onSelect={() => useBoard.getState().moveTaskToProject(task.id, p.id)}>
            <span className="w-4 text-center text-[14px] leading-none">{p.icon}</span>
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
          </MenuItem>
        ))}
      </MenuSubContent>
    </MenuSub>
  );
}

export function TaskSheet() {
  const selectedId = useBoard((s) => s.selectedId);
  const task = useBoard((s) => s.tasks.find((t) => t.id === s.selectedId));
  const project = useBoard((s) => s.project);
  const { select, updateTask, archiveTask, deleteTask } = useBoard.getState();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // keep showing the last task while the sheet animates closed
  const last = useRef(task);
  if (task) last.current = task;
  const t = task || last.current;

  useEffect(() => setConfirmDelete(false), [selectedId]);

  // the task disappeared (archived/deleted elsewhere) — close; wait for the board to load first
  const loaded = useBoard((s) => s.loaded);
  useEffect(() => {
    if (loaded && selectedId != null && !task) select(null);
  }, [loaded, selectedId, task, select]);

  return (
    <Sheet
      open={selectedId != null && !!task}
      onOpenChange={(o) => !o && select(null)}
      title={t ? `Task #${t.id}` : ''}
      header={
        t && (
          <>
            <Button size="sm" variant="ghost" onClick={() => archiveTask(t.id)}>
              <Archive className="size-3.5" /> Archive
            </Button>
            <Menu onOpenChange={(o) => o && useBoard.getState().loadHome()}>
              <MenuTrigger asChild>
                <IconButton label="More">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent>
                <MoveToProject task={t} />
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={(e) => {
                    if (!confirmDelete) {
                      e.preventDefault();
                      setConfirmDelete(true);
                    } else deleteTask(t.id);
                  }}
                >
                  <Trash2 /> {confirmDelete ? 'Click again to delete forever' : 'Delete permanently'}
                </MenuItem>
                <MenuSeparator />
                <div className="px-2.5 py-1.5 text-[11px] leading-relaxed text-faint">
                  Created {fmt(t.createdAt)}
                  <br />
                  Updated {fmt(t.updatedAt)}
                  {t.completedAt && (
                    <>
                      <br />
                      Completed {fmt(t.completedAt)}
                    </>
                  )}
                </div>
              </MenuContent>
            </Menu>
          </>
        )
      }
    >
      {t && (
        <div key={t.id} className="pb-10">
          <ClaimBanner task={t} />
          <div className="px-6 pb-2 pt-5">
            <AutoField singleLine value={t.title} onSave={(title) => updateTask(t.id, { title })} className="font-display text-[24px] leading-tight text-fg" placeholder="Task title" />
          </div>

          <div className="px-6 pb-2">
            <Row label="Status">
              <StatusPicker task={t} />
            </Row>
            <Row label="Priority">
              <PriorityPicker task={t} />
            </Row>
            <Row label="Deadline">
              <DuePicker
                dueAt={t.dueAt}
                hasTime={t.dueHasTime}
                onChange={(dueAt) => {
                  // a deadline moved before the start pulls the start along with it
                  const day = dueDay(dueAt);
                  const startAt = t.startAt && day && t.startAt > day ? day : undefined;
                  updateTask(t.id, { dueAt, dueHasTime: !!dueAt && dueAt.length > 10, ...(startAt && { startAt }) });
                }}
              />
            </Row>
            <Row label="Start">
              <StartPicker startAt={t.startAt} dueAt={t.dueAt} onChange={(startAt) => updateTask(t.id, { startAt })} />
            </Row>
            <Row label="Repeat">
              <RepeatPicker task={t} />
            </Row>
            <Row label="Estimate">
              <EstimatePicker task={t} project={project} onChange={(estimateMinutes) => updateTask(t.id, { estimateMinutes })} />
            </Row>
            <Row label="Time spent">
              <TimeTracker task={t} />
            </Row>
            <Row label="Tags">
              <TagEditor value={t.tags || []} onChange={(tags) => updateTask(t.id, { tags }).then(() => useBoard.getState().refreshTags(), () => {})} />
            </Row>
          </div>

          <div className="mx-6 h-px bg-line" />

          <Section title="Description">
            <AutoField value={t.description} onSave={(description) => updateTask(t.id, { description })} minRows={3} placeholder="Add details, context, links…" className="text-[14px] leading-relaxed" />
          </Section>

          <Subtasks task={t} />

          <Section title="Note">
            <NoteField value={t.note} onSave={(note) => updateTask(t.id, { note })} />
          </Section>
        </div>
      )}
    </Sheet>
  );
}
