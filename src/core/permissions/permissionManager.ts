import type {
  ApprovalDecision,
  CustomPermissionRules,
  PermissionMode,
  PermissionRequest,
  PermissionVerdict,
  RiskLevel,
  ToolDefinition
} from '../shared/types.js';
import { classifyCommand, maxRisk, riskAtLeast } from './riskClassifier.js';
import { resolveWorkspacePath } from './pathGuard.js';
import { createLogger } from '../shared/logger.js';
import { uid } from '../shared/ids.js';

const log = createLogger('permissions');

export type ApprovalHandler = (request: PermissionRequest) => Promise<ApprovalDecision>;

export interface PermissionContext {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  workspaceRoot: string;
  projectId: string;
  sessionId: string;
}

/** Highest risk auto-allowed per mode (no approval prompt). */
const MODE_AUTO_ALLOW: Record<Exclude<PermissionMode, 'custom'>, RiskLevel> = {
  safe: 'SAFE',
  balanced: 'LOW',
  autonomous: 'MEDIUM'
};

export const DEFAULT_CUSTOM_RULES: CustomPermissionRules = {
  autoAllowUpTo: 'LOW',
  allowNetwork: true,
  allowOutsideWorkspaceRead: false,
  allowDelete: false,
  allowGitRemote: false
};

export class PermissionManager {
  private sessionGrants = new Set<string>();
  private projectGrants = new Map<string, Set<string>>();
  private approvalHandler: ApprovalHandler | null = null;

  constructor(
    private mode: PermissionMode = 'balanced',
    private custom: CustomPermissionRules = { ...DEFAULT_CUSTOM_RULES }
  ) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    log.info('Permission mode changed', { mode });
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setCustomRules(rules: CustomPermissionRules): void {
    this.custom = rules;
  }

  setApprovalHandler(handler: ApprovalHandler | null): void {
    this.approvalHandler = handler;
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  private autoAllowCeiling(): RiskLevel {
    return this.mode === 'custom' ? this.custom.autoAllowUpTo : MODE_AUTO_ALLOW[this.mode];
  }

  private grantKey(ctx: PermissionContext, risk: RiskLevel): string {
    const command = typeof ctx.args.command === 'string' ? ctx.args.command.trim().split(/\s+/)[0] : '';
    return `${ctx.tool.name}:${command}:${risk}`;
  }

  /**
   * Static evaluation: no prompts, no side effects.
   * Returns whether the operation is allowed outright, blocked, or needs approval.
   */
  evaluate(ctx: PermissionContext): PermissionVerdict {
    const { tool, args, workspaceRoot } = ctx;
    let risk: RiskLevel = tool.risk;
    let reason = tool.description;

    // 1. Path containment for every path-like argument.
    for (const key of ['path', 'source', 'destination', 'cwd', 'directory', 'dir']) {
      const value = args[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      const check = resolveWorkspacePath(workspaceRoot, value);
      if (!check.ok) {
        const readOnly = !tool.mutating;
        if (readOnly && check.inside === false && this.custom.allowOutsideWorkspaceRead && this.mode === 'custom') {
          risk = maxRisk(risk, 'HIGH');
          reason = 'Read outside the workspace (allowed by custom rules, requires approval).';
        } else {
          return {
            allowed: false,
            requiresApproval: false,
            blocked: true,
            risk: 'CRITICAL',
            reason: check.reason ?? 'Invalid path.'
          };
        }
      }
    }

    // 2. Command classification.
    if (typeof args.command === 'string') {
      const classification = classifyCommand(args.command);
      if (classification.blocked) {
        return {
          allowed: false,
          requiresApproval: false,
          blocked: true,
          risk: 'CRITICAL',
          reason: `Blocked dangerous command: ${classification.reason}`
        };
      }
      risk = maxRisk(risk, classification.risk);
      reason = classification.reason;
    }

    // 3. Custom rule gates.
    if (this.mode === 'custom') {
      if (!this.custom.allowDelete && /delete|remove/.test(tool.name)) {
        return { allowed: false, requiresApproval: true, blocked: false, risk: maxRisk(risk, 'HIGH'), reason: 'Deletion requires approval (custom rules).' };
      }
      if (!this.custom.allowGitRemote && /^git_(push|pull|fetch|clone)$/.test(tool.name)) {
        return { allowed: false, requiresApproval: true, blocked: false, risk: maxRisk(risk, 'HIGH'), reason: 'Remote Git operation requires approval (custom rules).' };
      }
    }

    // 4. Safe mode never mutates.
    if (this.mode === 'safe' && tool.mutating) {
      return {
        allowed: false,
        requiresApproval: true,
        blocked: false,
        risk,
        reason: 'Safe mode: modifying operations require explicit approval.'
      };
    }

    // 5. Remote git always requires approval outside custom mode.
    if (/^git_(push|pull|clone)$/.test(tool.name) && this.mode !== 'custom') {
      return { allowed: false, requiresApproval: true, blocked: false, risk: maxRisk(risk, 'MEDIUM'), reason: 'Remote Git operations always require explicit approval.' };
    }

    // 6. CRITICAL always requires approval, never auto-allowed.
    if (risk === 'CRITICAL') {
      return { allowed: false, requiresApproval: true, blocked: false, risk, reason };
    }

    const ceiling = this.autoAllowCeiling();
    if (riskAtLeast(ceiling, risk)) {
      return { allowed: true, requiresApproval: false, blocked: false, risk, reason };
    }
    return { allowed: false, requiresApproval: true, blocked: false, risk, reason };
  }

  /**
   * Full check including persisted grants and the interactive approval prompt.
   */
  async check(ctx: PermissionContext, intent: string): Promise<PermissionVerdict> {
    const verdict = this.evaluate(ctx);
    if (verdict.blocked || verdict.allowed) return verdict;

    const key = this.grantKey(ctx, verdict.risk);
    if (this.sessionGrants.has(key) || this.projectGrants.get(ctx.projectId)?.has(key)) {
      return { ...verdict, allowed: true, requiresApproval: false, reason: `${verdict.reason} (previously approved)` };
    }

    if (!this.approvalHandler) {
      return { ...verdict, allowed: false, reason: `${verdict.reason} — no approval channel available.` };
    }

    const request: PermissionRequest = {
      id: uid('appr'),
      tool: ctx.tool.name,
      operation: ctx.tool.name,
      target: String(ctx.args.path ?? ctx.args.cwd ?? ctx.workspaceRoot),
      command: typeof ctx.args.command === 'string' ? ctx.args.command : undefined,
      reason: intent || verdict.reason,
      risk: verdict.risk
    };

    const decision = await this.approvalHandler(request);
    log.info('Approval decision', { tool: ctx.tool.name, risk: verdict.risk, decision });

    if (decision === 'deny') {
      return { ...verdict, allowed: false, reason: 'Denied by the user.' };
    }
    if (decision === 'allow_session') this.sessionGrants.add(key);
    if (decision === 'allow_project') {
      const set = this.projectGrants.get(ctx.projectId) ?? new Set<string>();
      set.add(key);
      this.projectGrants.set(ctx.projectId, set);
    }
    return { ...verdict, allowed: true, requiresApproval: false, reason: `Approved by the user (${decision}).` };
  }
}
