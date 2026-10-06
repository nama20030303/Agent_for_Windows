import type { RiskLevel, ToolCall, ToolDefinition, ToolResult } from '../shared/types.js';
import type { PermissionManager } from '../permissions/permissionManager.js';
import { validateArgs } from './validate.js';
import { createLogger } from '../shared/logger.js';
import type { Tool, ToolContext } from './types.js';
import { fail } from './types.js';

const log = createLogger('tools');

export interface ToolExecutionHooks {
  onBeforeExecute?: (call: ToolCall, risk: RiskLevel, intent: string) => void;
  onAfterExecute?: (call: ToolCall, result: ToolResult) => void;
}

/**
 * The only path from model output to the operating system.
 *
 *   model → tool call → schema validation → security validation
 *         → permission check → execution → structured result → model
 */
export class ToolManager {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(filter?: (d: ToolDefinition) => boolean): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition).filter((d) => (filter ? filter(d) : true));
  }

  /** Read-only tool set used in Chat/Plan modes. */
  readOnlyDefinitions(): ToolDefinition[] {
    return this.definitions((d) => !d.mutating);
  }

  async execute(
    call: ToolCall,
    ctx: ToolContext,
    permissions: PermissionManager,
    hooks: ToolExecutionHooks = {}
  ): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.tools.get(call.name);
    if (!tool) {
      return fail(call.name, `Unknown tool "${call.name}". Use only the provided tools.`, { callId: call.id });
    }

    const validation = validateArgs(tool.definition.parameters, call.arguments ?? {});
    if (!validation.valid) {
      return fail(call.name, `Invalid arguments: ${validation.errors.join(' ')}`, { callId: call.id });
    }
    const args = validation.value;
    const intent = tool.describe(args);

    const verdict = await permissions.check(
      {
        tool: tool.definition,
        args,
        workspaceRoot: ctx.workspaceRoot,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId
      },
      intent
    );

    if (!verdict.allowed) {
      log.warn('Tool blocked', { tool: call.name, risk: verdict.risk, reason: verdict.reason });
      return {
        success: false,
        tool: call.name,
        callId: call.id,
        denied: true,
        error: verdict.blocked
          ? `Operation blocked by the security policy: ${verdict.reason}`
          : `Operation not permitted: ${verdict.reason}`,
        errorType: 'PERMISSION_ERROR',
        summary: verdict.blocked ? 'Blocked by security policy' : 'Denied',
        durationMs: Date.now() - started
      };
    }

    hooks.onBeforeExecute?.(call, verdict.risk, intent);

    let result: ToolResult;
    try {
      result = await tool.execute(args, ctx);
    } catch (err) {
      result = fail(call.name, `Tool threw an exception: ${(err as Error).message}`, { errorType: 'RUNTIME_ERROR' });
    }
    result.callId = call.id;
    result.durationMs = result.durationMs ?? Date.now() - started;
    hooks.onAfterExecute?.(call, result);
    log.info('Tool executed', { tool: call.name, success: result.success, ms: result.durationMs });
    return result;
  }
}
