import type { RawToolCall } from './provider.js';
import { salvageJsonObject } from './salvageJson.js';

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

/**
 * Names models reach for instead of the real ones. Accepted only when the
 * alias is not itself a tool and the target is.
 */
const ALIASES: Record<string, string> = {
  create_file: 'write_file',
  new_file: 'write_file',
  save_file: 'write_file',
  writefile: 'write_file',
  write: 'write_file',
  update_file: 'edit_file',
  modify_file: 'edit_file',
  apply_patch: 'edit_file',
  patch_file: 'edit_file',
  open_file: 'read_file',
  view_file: 'read_file',
  cat: 'read_file',
  readfile: 'read_file',
  run_command: 'execute_command',
  shell: 'execute_command',
  bash: 'execute_command',
  powershell: 'execute_command',
  terminal: 'execute_command',
  command: 'execute_command',
  run: 'execute_command',
  list_files: 'list_directory',
  ls: 'list_directory',
  dir: 'list_directory',
  mkdir: 'create_directory',
  create_folder: 'create_directory',
  remove_file: 'delete_file',
  rm: 'delete_file',
  grep: 'search_text',
  search: 'search_text',
  test: 'run_tests',
  run_test: 'run_tests',
  build: 'run_build',
  ask: 'ask_user',
  question: 'ask_user',
  done: 'finish',
  complete: 'finish',
  finish_task: 'finish'
};

function canonicalName(name: string, known?: Set<string>): string | null {
  if (!known) return name;
  if (known.has(name)) return name;
  const alias = ALIASES[name.toLowerCase()];
  return alias && known.has(alias) ? alias : null;
}

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

interface LooseParse {
  value: any;
  /** The text ran out mid-object: the model's reply was cut off. */
  truncated: boolean;
}

function parseLoosely(raw: string): LooseParse | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return { value: JSON.parse(text), truncated: false };
  } catch {
    /* fall through */
  }
  try {
    return { value: JSON.parse(repairJson(text)), truncated: false };
  } catch {
    /* fall through */
  }
  // Last resort: a key-by-key walk that tolerates unescaped quotes inside a
  // string value and an object that never closes.
  const salvaged = salvageJsonObject(text);
  return salvaged ? { value: salvaged.value, truncated: salvaged.truncated } : null;
}

/** A parsed block that names a tool nobody has, so the model can be told. */
export interface UnknownToolCall {
  unknown: string;
}

function isUnknown(value: unknown): value is UnknownToolCall {
  return !!value && typeof value === 'object' && 'unknown' in (value as object);
}

function isTruncated(value: unknown): value is TruncatedToolCall {
  return !!value && typeof value === 'object' && 'truncated' in (value as object);
}

export interface TruncatedToolCall {
  truncated: string;
}

function readCall(
  raw: string,
  index: number,
  known?: Set<string>
): RawToolCall | UnknownToolCall | TruncatedToolCall | null {
  const loose = parseLoosely(raw);
  if (!loose) return null;
  let parsed = loose.value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Some models wrap the call: { "tool_call": { ... } }.
  for (const wrapper of ['tool_call', 'function_call', 'action', 'call']) {
    const inner = parsed[wrapper];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      parsed = inner;
      break;
    }
  }

  const raw_name = parsed.tool ?? parsed.name ?? parsed.function?.name ?? parsed.tool_name ?? parsed.action;
  if (typeof raw_name !== 'string' || !TOOL_NAME.test(raw_name)) return null;
  const name = canonicalName(raw_name, known);
  if (!name) return { unknown: raw_name };

  // A call cut off mid-JSON must never run: half a file is worse than none.
  if (loose.truncated) return { truncated: name };

  const args =
    parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.params ?? parsed.input ?? parsed.function?.arguments ?? {};
  // Arguments given as a JSON string must survive as a valid JSON string.
  let serialised: string;
  if (typeof args === 'string') {
    const reparsed = parseLoosely(args);
    serialised = reparsed && typeof reparsed.value === 'object' ? JSON.stringify(reparsed.value) : args;
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
  /** Tool names the model invented. Reported back so it can correct itself. */
  unknownTools: string[];
  /** Calls whose JSON was cut off, so they were not run. */
  truncatedCalls: string[];
}

/**
 * @param knownTools when supplied, only calls naming a real tool are accepted.
 *        This is what makes scanning unfenced text safe.
 */
export function extractTextToolCalls(content: string, knownTools?: Iterable<string>): TextToolCallExtraction {
  if (!content || !content.includes('{')) return { calls: [], cleaned: content ?? '', unknownTools: [], truncatedCalls: [] };

  const known = knownTools ? new Set(knownTools) : undefined;
  const calls: RawToolCall[] = [];
  const unknownTools: string[] = [];
  const truncatedCalls: string[] = [];
  const remove: string[] = [];

  const accept = (result: RawToolCall | UnknownToolCall | TruncatedToolCall | null, block: string): boolean => {
    if (!result) return false;
    if (isTruncated(result)) {
      if (!truncatedCalls.includes(result.truncated)) truncatedCalls.push(result.truncated);
      return false;
    }
    if (isUnknown(result)) {
      if (!unknownTools.includes(result.unknown)) unknownTools.push(result.unknown);
      return false;
    }
    calls.push(result);
    remove.push(block);
    return true;
  };

  // 1. Fenced blocks, skipping anything that is plainly source code.
  let outsideFences = '';
  let cursor = 0;
  for (const match of content.matchAll(FENCE)) {
    outsideFences += content.slice(cursor, match.index);
    cursor = (match.index ?? 0) + match[0].length;

    const language = match[1].toLowerCase();
    if (CODE_LANGUAGES.has(language)) continue;

    accept(readCall(match[2], calls.length, known), match[0]);
  }
  outsideFences += content.slice(cursor);

  // A block the model never closed, because it ran out of tokens or simply
  // forgot the closing fence.
  if (!calls.length) {
    const open = content.match(/```(?:tool_call|tool|json)?[ \t]*\r?\n([\s\S]*)$/);
    if (open && !open[1].includes('```')) accept(readCall(open[1], 0, known), open[0]);
  }

  // 2. A JSON object written without a fence, anywhere in the message. Only
  //    accepted when the tool name is known, so prose can never be mistaken
  //    for a command.
  if (!calls.length && known) {
    for (const span of jsonSpans(outsideFences)) {
      const text = outsideFences.slice(span.start, span.end);
      accept(readCall(text, calls.length, known), text);
    }
  }

  // 3. The whole message is one JSON object (no fence, no tool list).
  if (!calls.length && !known) {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) accept(readCall(trimmed, 0, known), trimmed);
  }

  // 4. A call the model never finished writing: no balanced braces at all, so
  //    the scanner above cannot see it. Look for the start of one.
  if (!calls.length && !truncatedCalls.length) {
    // Only outside code fences: a JSON-looking line inside a ```python block
    // is part of the program, not an instruction.
    const start = outsideFences.search(/\{\s*"(?:tool|name|tool_name|function)"/);
    if (start >= 0) accept(readCall(outsideFences.slice(start), 0, known), outsideFences.slice(start));
  }

  let cleaned = content;
  for (const block of remove) cleaned = cleaned.replace(block, '');
  return { calls, cleaned: cleaned.trim(), unknownTools, truncatedCalls };
}
