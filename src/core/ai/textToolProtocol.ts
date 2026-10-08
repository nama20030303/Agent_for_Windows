import type { ChatMessage, ToolDefinition } from '../shared/types.js';

/**
 * Compatibility mode for endpoints that do not implement OpenAI function
 * calling. Some of them ignore the `tools` parameter; worse, several answer a
 * request containing `tools` with a completely empty completion (observed on
 * anymodel.org with nemotron-3-ultra). In that case the tools are described in
 * the prompt instead, and the model is asked to emit a fenced `tool_call`
 * block, which `extractTextToolCalls` turns back into a real call.
 *
 * The instructions are deliberately terse and example-driven: weaker models
 * follow a single concrete example far better than a specification.
 */

const MAX_DESCRIPTION = 240;

function describeParameters(tool: ToolDefinition): string {
  const schema = tool.parameters as { properties?: Record<string, any>; required?: string[] } | undefined;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const names = Object.keys(properties);
  if (!names.length) return 'no arguments';

  return names
    .map((name) => {
      const spec = properties[name] ?? {};
      const type = Array.isArray(spec.type) ? spec.type.join('|') : (spec.type ?? 'any');
      return `${name}: ${type}${required.has(name) ? '' : ' (optional)'}`;
    })
    .join(', ');
}

export function describeToolsAsText(tools: ToolDefinition[]): string {
  const lines = tools.map((tool) => {
    const description = tool.description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
    return `- ${tool.name}(${describeParameters(tool)}) — ${description}`;
  });

  return [
    'TOOL PROTOCOL (this endpoint does not support native function calls)',
    '',
    'You cannot touch the computer by writing text. To act, end your message with exactly one',
    'fenced block, and nothing after it:',
    '',
    '```tool_call',
    '{ "tool": "write_file", "arguments": { "path": "game/snake.py", "content": "import pygame\\n" } }',
    '```',
    '',
    'Rules:',
    '- The block must contain one JSON object with "tool" and "arguments". No comments, no trailing commas.',
    '- One call per message. Stop after the block and wait for its result; the result arrives as the next message.',
    '- Writing code in a normal answer changes nothing on disk. Only the block above does.',
    '- When the whole task is done, call the `finish` tool the same way.',
    '',
    'Available tools:',
    ...lines
  ].join('\n');
}

/**
 * Fold the protocol into the conversation. It is appended to the existing
 * system prompt when there is one, because several gateways silently drop
 * every system message after the first.
 */
export function withTextToolProtocol(messages: ChatMessage[], tools: ToolDefinition[]): ChatMessage[] {
  if (!tools.length) return messages;
  const protocol = describeToolsAsText(tools);
  const copy = [...messages];
  const firstSystem = copy.findIndex((m) => m.role === 'system');

  if (firstSystem >= 0) {
    copy[firstSystem] = { ...copy[firstSystem], content: `${copy[firstSystem].content}\n\n${protocol}` };
    return copy;
  }
  return [{ role: 'system', content: protocol }, ...copy];
}
