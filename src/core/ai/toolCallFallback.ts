import type { RawToolCall } from './provider.js';

/**
 * Recovering a tool call from plain text.
 *
 * Not every OpenAI-compatible endpoint implements native function calling, so
 * the agent asks such models to emit the call as a fenced block instead (see
 * textToolProtocol.ts). Models are sloppy about it: they add prose around the
 * block, forget the language tag, wrap the call in another object, and — most
 * often — put raw newlines inside a JSON string when writing file contents.
 * All of that is recovered here, because a near-miss that gets rejected looks
 * to the user exactly like the agent doing nothing.
 *
 * The one thing never done is guessing: a candidate is only accepted if it is
 * a JSON object that names a tool. Misreading prose as a command would be far
 * worse than reporting that no call was made.
 */

/** Fences whose body is source code, never a call. */
const CODE_LANGUAGES = new Set([
  'python',
  'py',
  'javascript',
  'js',
  'typescript',
  'ts',
  'tsx',
  'jsx',
  'bash',
  'sh',
  'shell',
  'powershell',
  'ps1',
  'cmd',
  'html',
  'css',
  'sql',
  'yaml',
  'yml',
  'toml',
  'ini',
  'diff',
  'text',
  'xml',
  'java',
  'go',
  'rust',
  'rs',
  'c',
  'cpp',
  'csharp',
  'cs',
  'php',
  'ruby',
  'rb'
]);

const FENCE = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/**
 * Make a model's near-JSON parseable: strip trailing commas and escape the raw
 * control characters it leaves inside strings when emitting file contents.
 */
function repairJson(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        out += char;
        escaped = true;
      } else if (char === '"') {
        inString = false;
        out += char;
      } else if (char === '\n') {
        out += '\\n';
      } else if (char === '\r') {
        out += '\\r';
      } else if (char === '\t') {
        out += '\\t';
      } else {
        out += char;
      }
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }

  // Trailing commas before a closing brace or bracket.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseLoosely(raw: string): any {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the repaired parse */
  }
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return null;
  }
}

function readCall(raw: string, index: number, known?: Set<string>): RawToolCall | null {
  let parsed = parseLoosely(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Some models wrap the call: { "tool_call": { ... } }.
  for (const wrapper of ['tool_call', 'function_call', 'action', 'call']) {
    const inner = parsed[wrapper];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      parsed = inner;
      break;
    }
  }

  const name = parsed.tool ?? parsed.name ?? parsed.function?.name ?? parsed.tool_name ?? parsed.action;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) return null;
  if (known && !known.has(name)) return null;

  const args =
    parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.params ?? parsed.input ?? parsed.function?.arguments ?? {};
  // Arguments given as a JSON string must survive as a valid JSON string.
  let serialised: string;
  if (typeof args === 'string') {
    const reparsed = parseLoosely(args);
    serialised = reparsed && typeof reparsed === 'object' ? JSON.stringify(reparsed) : args;
  } else {
    serialised = JSON.stringify(args ?? {});
  }

  return { id: `text_call_${index}`, name, arguments: serialised };
}

/** Every balanced `{...}` span in the text, outermost first. */
function jsonSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push({ start, end: i + 1 });
        start = -1;
      } else if (depth < 0) {
        depth = 0;
      }
    }
  }
  return spans;
}

export interface TextToolCallExtraction {
  calls: RawToolCall[];
  /** The message with the call blocks removed, so the user does not see raw JSON. */
  cleaned: string;
}

/**
 * @param knownTools when supplied, only calls naming a real tool are accepted.
 *        This is what makes scanning unfenced text safe.
 */
export function extractTextToolCalls(content: string, knownTools?: Iterable<string>): TextToolCallExtraction {
  if (!content || !content.includes('{')) return { calls: [], cleaned: content ?? '' };

  const known = knownTools ? new Set(knownTools) : undefined;
  const calls: RawToolCall[] = [];
  const remove: string[] = [];

  // 1. Fenced blocks, skipping anything that is plainly source code.
  let outsideFences = '';
  let cursor = 0;
  for (const match of content.matchAll(FENCE)) {
    outsideFences += content.slice(cursor, match.index);
    cursor = (match.index ?? 0) + match[0].length;

    const language = match[1].toLowerCase();
    if (CODE_LANGUAGES.has(language)) continue;

    const call = readCall(match[2], calls.length, known);
    if (call) {
      calls.push(call);
      remove.push(match[0]);
    }
  }
  outsideFences += content.slice(cursor);

  // 2. A JSON object written without a fence, anywhere in the message. Only
  //    accepted when the tool name is known, so prose can never be mistaken
  //    for a command.
  if (!calls.length && known) {
    for (const span of jsonSpans(outsideFences)) {
      const text = outsideFences.slice(span.start, span.end);
      const call = readCall(text, calls.length, known);
      if (call) {
        calls.push(call);
        remove.push(text);
      }
    }
  }

  // 3. The whole message is one JSON object (no fence, no tool list).
  if (!calls.length && !known) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const call = readCall(trimmed, 0, known);
      if (call) {
        calls.push(call);
        remove.push(trimmed);
      }
    }
  }

  let cleaned = content;
  for (const block of remove) cleaned = cleaned.replace(block, '');
  return { calls, cleaned: cleaned.trim() };
}
