/**
 * Recovering a tool call from JSON a model got slightly wrong.
 *
 * Two mistakes dominate when a model writes source code into an argument, and
 * both make `JSON.parse` useless:
 *
 *   - the string value contains raw newlines and unescaped double quotes,
 *     because the model is pasting code rather than encoding a string;
 *   - the reply was cut off by the output limit, so the object never closes.
 *
 * A strict parser rejects both, and the user sees an agent that does nothing
 * while the model is in fact calling the right tool with the right arguments.
 * This parser walks the object key by key and, for a string value, tries every
 * plausible closing quote, keeping the one that lets the rest of the object
 * parse. It reports truncation instead of hiding it, because a half-written
 * file must never be written to disk.
 */

export interface SalvagedObject {
  value: Record<string, unknown>;
  /** The text ended in the middle of the object or one of its strings. */
  truncated: boolean;
}

const KEY = /^\s*"([^"\\]{1,64})"\s*:\s*/;

function decodeEscapes(raw: string): string {
  return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (match, code: string) => {
    switch (code[0]) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return String.fromCharCode(parseInt(code.slice(1), 16));
      default:
        return match;
    }
  });
}

/** Every position where a string value could plausibly end. */
function closingQuotes(text: string, from: number): number[] {
  const ends: number[] = [];
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] !== '"') continue;
    // A real closing quote is followed by a comma or the end of the object.
    const rest = text.slice(i + 1).match(/^\s*([,}])/);
    if (rest) ends.push(i);
  }
  return ends;
}

type Parsed = { value: Record<string, unknown>; end: number; truncated: boolean } | null;

/**
 * Parse the key/value pairs of an object, starting just after `{` or after a
 * comma. Positions are absolute, so a nested value always reports where it
 * really ended — getting that wrong is what made a complete call look
 * truncated.
 */
function parseRest(text: string, from: number, depth: number): Parsed {
  if (depth > 8) return null;
  const value: Record<string, unknown> = {};
  let i = from;

  for (;;) {
    const closing = text.slice(i).match(/^\s*}/);
    if (closing) return { value, end: i + closing[0].length, truncated: false };
    if (!text.slice(i).trim()) return { value, end: text.length, truncated: true };

    const key = text.slice(i).match(KEY);
    if (!key) return { value, end: text.length, truncated: true };
    i += key[0].length;
    const name = key[1];

    if (text[i] === '"') {
      // Unescaped quotes inside the value make the real end ambiguous, so try
      // every candidate and keep the one the rest of the object agrees with.
      let resolved: Parsed = null;
      let chosen = -1;
      for (const end of closingQuotes(text, i + 1)) {
        const after = continuation(text, end + 1, depth);
        if (after) {
          resolved = after;
          chosen = end;
          break;
        }
      }
      if (!resolved) {
        // The text stops inside this string: the reply was cut off.
        value[name] = decodeEscapes(text.slice(i + 1));
        return { value, end: text.length, truncated: true };
      }
      value[name] = decodeEscapes(text.slice(i + 1, chosen));
      return { value: { ...value, ...resolved.value }, end: resolved.end, truncated: resolved.truncated };
    }

    if (text[i] === '{') {
      const nested = parseObject(text, i, depth + 1);
      if (!nested) return { value, end: text.length, truncated: true };
      value[name] = nested.value;
      i = nested.end;
      if (nested.truncated) return { value, end: text.length, truncated: true };
    } else {
      const token = text.slice(i).match(/^(\[[\s\S]*?\]|-?\d+(?:\.\d+)?|true|false|null)/);
      if (!token) return { value, end: text.length, truncated: true };
      try {
        value[name] = JSON.parse(token[1]);
      } catch {
        return { value, end: text.length, truncated: true };
      }
      i += token[1].length;
    }

    const separator = text.slice(i).match(/^\s*(,|})/);
    if (!separator) return { value, end: text.length, truncated: true };
    i += separator[0].length;
    if (separator[1] === '}') return { value, end: i, truncated: false };
  }
}

/** What follows a value: either the object closes, or another pair begins. */
function continuation(text: string, from: number, depth: number): Parsed {
  const separator = text.slice(from).match(/^\s*(,|})/);
  if (!separator) return null;
  const next = from + separator[0].length;
  if (separator[1] === '}') return { value: {}, end: next, truncated: false };
  return parseRest(text, next, depth);
}

function parseObject(text: string, start: number, depth = 0): Parsed {
  if (text[start] !== '{') return null;
  return parseRest(text, start + 1, depth);
}

/**
 * Parse an object that `JSON.parse` refuses, starting at the first `{`.
 * Returns null when the text is not an object at all.
 */
export function salvageJsonObject(text: string): SalvagedObject | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const parsed = parseObject(text, start);
  if (!parsed || !Object.keys(parsed.value).length) return null;
  return { value: parsed.value, truncated: parsed.truncated };
}
