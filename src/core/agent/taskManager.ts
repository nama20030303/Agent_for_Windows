import type { Task, TaskStep, TaskStatus, StepStatus } from '../shared/types.js';
import { nowIso, uid } from '../shared/ids.js';

const STEP_STATUSES: StepStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];

export interface TaskUpdateInput {
  title: string;
  goal?: string;
  status?: TaskStatus;
  steps: { id?: string; description: string; status?: string; detail?: string }[];
}

/** Builds and maintains the visible task breakdown for a session. */
export class TaskManager {
  private tasks = new Map<string, Task>();

  constructor(private sessionId: string, initial: Task[] = []) {
    for (const t of initial) this.tasks.set(t.id, t);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  current(): Task | undefined {
    return this.list().find((t) => !['completed', 'failed', 'stopped'].includes(t.status)) ?? this.list().at(-1);
  }

  apply(input: TaskUpdateInput): Task {
    const existing = this.list().find((t) => t.title === input.title) ?? this.current();
    const steps: TaskStep[] = (input.steps ?? []).map((s, i) => ({
      id: s.id ?? existing?.steps[i]?.id ?? uid('step'),
      description: String(s.description ?? `Step ${i + 1}`),
      status: (STEP_STATUSES.includes(s.status as StepStatus) ? s.status : 'pending') as StepStatus,
      detail: s.detail
    }));

    if (existing && existing.title === input.title) {
      const updated: Task = {
        ...existing,
        goal: input.goal ?? existing.goal,
        status: (input.status as TaskStatus) ?? existing.status,
        steps,
        updatedAt: nowIso()
      };
      this.tasks.set(updated.id, updated);
      return updated;
    }

    const task: Task = {
      id: uid('task'),
      sessionId: this.sessionId,
      title: input.title,
      goal: input.goal ?? input.title,
      status: (input.status as TaskStatus) ?? 'executing',
      priority: 'high',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      steps
    };
    this.tasks.set(task.id, task);
    return task;
  }

  setStatus(taskId: string, status: TaskStatus): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const updated = { ...task, status, updatedAt: nowIso() };
    this.tasks.set(taskId, updated);
    return updated;
  }

  progress(): { done: number; total: number; percent: number } {
    const task = this.current();
    if (!task || task.steps.length === 0) return { done: 0, total: 0, percent: 0 };
    const done = task.steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
    return { done, total: task.steps.length, percent: Math.round((done / task.steps.length) * 100) };
  }
}
