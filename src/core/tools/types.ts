import type { JSONSchema, ToolDefinition, ToolResult } from '../shared/types.js';
import type { ProcessManager } from '../process/processManager.js';
import type { ShellKind } from '../process/shell.js';

export interface ToolContext {
  workspaceRoot: string;
  projectId: string;
  sessionId: string;
  shell: ShellKind;
  processManager: ProcessManager;
  signal?: AbortSignal;
  /** Called by mutating filesystem tools so the agent can track touched files. */
  onFileTouched?: (relativePath: string, kind: 'created' | 'modified' | 'deleted') => void;
}

export interface Tool {
  definition: ToolDefinition;
  /** Human-readable intent shown in approval cards and the activity log. */
  describe(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool(
  definition: ToolDefinition,
  execute: Tool['execute'],
  describe?: Tool['describe']
): Tool {
  return {
    definition,
    execute,
    describe: describe ?? (() => definition.description)
  };
}

export function schema(properties: Record<string, unknown>, required: string[] = []): JSONSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const str = (description: string) => ({ type: 'string', description });
export const num = (description: string) => ({ type: 'number', description });
export const bool = (description: string) => ({ type: 'boolean', description });

export function ok(tool: string, partial: Partial<ToolResult> = {}): ToolResult {
  return { success: true, tool, ...partial };
}

export function fail(tool: string, error: string, partial: Partial<ToolResult> = {}): ToolResult {
  return { success: false, tool, error, ...partial };
}
