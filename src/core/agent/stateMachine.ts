import type { AgentState } from '../shared/types.js';

/** Allowed transitions of the agent state machine. */
export const TRANSITIONS: Record<AgentState, AgentState[]> = {
  IDLE: ['ANALYZING', 'INSPECTING_PROJECT', 'STOPPED', 'FAILED'],
  ANALYZING: ['INSPECTING_PROJECT', 'ANALYZING_REQUIREMENTS', 'PLANNING', 'EXECUTING', 'WAITING_FOR_USER', 'STOPPING', 'FAILED', 'COMPLETED'],
  INSPECTING_PROJECT: ['ANALYZING_REQUIREMENTS', 'PLANNING', 'EXECUTING', 'WAITING_FOR_USER', 'STOPPING', 'FAILED'],
  ANALYZING_REQUIREMENTS: ['WAITING_FOR_USER', 'PLANNING', 'EXECUTING', 'STOPPING', 'FAILED', 'BLOCKED'],
  WAITING_FOR_USER: ['ANALYZING', 'ANALYZING_REQUIREMENTS', 'PLANNING', 'EXECUTING', 'STOPPING', 'STOPPED', 'FAILED', 'COMPLETED'],
  PLANNING: ['WAITING_FOR_APPROVAL', 'EXECUTING', 'WAITING_FOR_USER', 'STOPPING', 'FAILED', 'COMPLETED'],
  WAITING_FOR_APPROVAL: ['EXECUTING', 'PLANNING', 'STOPPED', 'STOPPING', 'FAILED', 'WAITING_FOR_USER'],
  EXECUTING: ['RUNNING_TOOL', 'VERIFYING', 'WAITING_FOR_USER', 'WAITING_FOR_APPROVAL', 'PLANNING', 'REPAIRING', 'STOPPING', 'BLOCKED', 'COMPLETED', 'FAILED'],
  RUNNING_TOOL: ['EXECUTING', 'VERIFYING', 'REPAIRING', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_USER', 'STOPPING', 'BLOCKED', 'FAILED', 'COMPLETED'],
  VERIFYING: ['EXECUTING', 'REPAIRING', 'COMPLETED', 'FAILED', 'STOPPING', 'BLOCKED', 'WAITING_FOR_USER', 'RUNNING_TOOL'],
  REPAIRING: ['EXECUTING', 'RUNNING_TOOL', 'VERIFYING', 'BLOCKED', 'FAILED', 'STOPPING', 'WAITING_FOR_USER'],
  BLOCKED: ['WAITING_FOR_USER', 'EXECUTING', 'STOPPED', 'FAILED', 'ANALYZING'],
  STOPPING: ['STOPPED', 'FAILED'],
  STOPPED: ['IDLE', 'ANALYZING'],
  COMPLETED: ['IDLE', 'ANALYZING'],
  FAILED: ['IDLE', 'ANALYZING']
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class AgentStateMachine {
  constructor(private state: AgentState = 'IDLE') {}

  get current(): AgentState {
    return this.state;
  }

  /** Returns true when the transition was applied. Invalid transitions are refused, never thrown. */
  transition(to: AgentState): boolean {
    if (!canTransition(this.state, to)) return false;
    this.state = to;
    return true;
  }

  /** Forced transition, used by stop() and crash recovery. */
  force(to: AgentState): void {
    this.state = to;
  }

  isTerminal(): boolean {
    return ['COMPLETED', 'FAILED', 'STOPPED', 'IDLE'].includes(this.state);
  }

  isWaiting(): boolean {
    return ['WAITING_FOR_USER', 'WAITING_FOR_APPROVAL', 'BLOCKED'].includes(this.state);
  }
}
