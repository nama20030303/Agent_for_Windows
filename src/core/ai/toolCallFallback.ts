import type { RawToolCall } from './provider.js';

/**
 * Not every OpenAI-compatible endpoint implements native function calling, and
 * some reasoning models describe the call in prose instead of emitting one.
 * When no native tool call arrives, look for an explicit textual call so the
 * agent can still act instead of chatting about acting.
 *
 * Accepted forms (the system prompt documents the first one):
 *
 *   ```tool_call
 *   { "tool": "write_file", "arguments": { "path": "a.py", "content": "..." } }
 *   ```
 *
 *   ```json
 *   { "name": "write_file", "arguments": { ... } }
 *   ```
 *
 * Only well-formed JSON objects naming a tool are accepted; anything else is
 * left alone, because misreading prose as a command would be worse than
 * reporting that no call was made.
 */

const FENCE = /```(?:tool_call|tool|json)?\s*\n([\s\S]*?)```/gi;

function readCall(raw: string, index: number): RawToolCall | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const name = parsed.tool ?? parsed.name ?? parsed.function?.name ?? parsed.tool_name;
  if (typeof name !== 'string' || !name) return null;

  const args = parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.function?.arguments ?? {};
  const serialised = typeof args === 'string' ? args : JSON.stringify(args ?? {});

  return { id: `text_call_${index}`, name, arguments: serialised };
}

export interface TextToolCallExtraction {
  calls: RawToolCall[];
  /** The message with the call blocks removed, so the user does not see raw JSON. */
  cleaned: string;
}

export function extractTextToolCalls(content: string): TextToolCallExtraction {
  if (!content || !content.includes('{')) return { calls: [], cleaned: content };

  const calls: RawToolCall[] = [];
  let cleaned = content;

  for (const match of content.matchAll(FENCE)) {
    const call = readCall(match[1], calls.length);
    if (call) {
      calls.push(call);
      cleaned = cleaned.replace(match[0], '');
    }
  }

  // A bare JSON object as the entire message is also a call.
  if (!calls.length) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const call = readCall(trimmed, 0);
      if (call) {
        calls.push(call);
        cleaned = '';
      }
    }
  }

  return { calls, cleaned: cleaned.trim() };
}
