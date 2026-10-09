/**
 * The two ways a model mangles JSON when it writes source code into an
 * argument. Both were silently discarding correct tool calls.
 */
import { describe, it, expect } from 'vitest';
import { salvageJsonObject } from '../src/core/ai/salvageJson.js';
import { extractTextToolCalls } from '../src/core/ai/toolCallFallback.js';

describe('salvaging a model\'s JSON', () => {
  it('reads a string value holding raw newlines and unescaped quotes', () => {
    const text = '{"tool": "write_file", "arguments": {"path": "a.rs", "content": "//! Nexus\n#![cfg_attr(x)]\nfn main() { println!("hi"); }\n"}}';
    const result = salvageJsonObject(text)!;
    expect(result.truncated).toBe(false);
    const args = (result.value as any).arguments;
    expect(args.path).toBe('a.rs');
    expect(args.content).toContain('println!("hi");');
    expect(args.content.split('\n')).toHaveLength(4);
  });

  it('keeps escapes that were written correctly', () => {
    const result = salvageJsonObject('{"a": "line1\\nline2", "b": "say \\"hi\\""}')!;
    expect(result.value.a).toBe('line1\nline2');
    expect(result.value.b).toBe('say "hi"');
  });

  it('reads numbers, booleans and nested objects', () => {
    const result = salvageJsonObject('{"n": 12, "ok": true, "deep": {"x": "y"}, "s": "z"}')!;
    expect(result.value).toEqual({ n: 12, ok: true, deep: { x: 'y' }, s: 'z' });
    expect(result.truncated).toBe(false);
  });

  it('reports an object that stops mid-string', () => {
    const result = salvageJsonObject('{"tool": "write_file", "arguments": {"path": "a.rs", "content": "fn main() {')!;
    expect(result.truncated).toBe(true);
    expect((result.value as any).tool).toBe('write_file');
  });

  it('reports an object that stops between keys', () => {
    expect(salvageJsonObject('{"tool": "write_file", ')!.truncated).toBe(true);
  });

  it('refuses text that is not an object', () => {
    expect(salvageJsonObject('just prose')).toBeNull();
    expect(salvageJsonObject('')).toBeNull();
  });
});

describe('what the agent does with those calls', () => {
  const tools = ['write_file', 'finish'];

  it('runs a call whose code contains unescaped quotes', () => {
    const text = '{"tool": "write_file", "arguments": {"path": "main.rs", "content": "fn main() { println!("hi"); }"}}';
    const { calls, truncatedCalls } = extractTextToolCalls(text, tools);
    expect(truncatedCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].arguments).content).toContain('println!("hi")');
  });

  it('never runs a call that was cut off, and names it', () => {
    const text = '{"tool": "write_file", "arguments": {"path": "main.rs", "content": "//! a very long file';
    const result = extractTextToolCalls(text, tools);
    expect(result.calls).toHaveLength(0);
    expect(result.truncatedCalls).toEqual(['write_file']);
  });

  it('detects truncation inside an unfinished fenced block too', () => {
    const text = 'Writing it.\n```tool_call\n{"tool": "write_file", "arguments": {"path": "a.rs", "content": "fn main() {';
    expect(extractTextToolCalls(text, tools).truncatedCalls).toEqual(['write_file']);
  });
});

describe('the Rust file from the report', () => {
  const rust = [
    '//! AI Provider abstraction layer',
    '',
    'use async_trait::async_trait;',
    'use serde::{Deserialize, Serialize};',
    '',
    '#[derive(Debug, Clone, Serialize, Deserialize)]',
    'pub struct ChatMessage {',
    '    #[serde(rename = "role")]',
    '    pub role: String,',
    '}',
    '',
    'impl Provider {',
    '    pub fn describe(&self) -> String {',
    '        format!("{} at {}", self.model, self.base_url)',
    '    }',
    '}',
    ''
  ].join('\n');

  it('recovers the file byte for byte despite quote-comma pairs in the code', () => {
    // `format!("{}", x)` ends a quote with a comma, which looks exactly like
    // the end of a JSON string. Picking that spot lost the call entirely.
    const text = `{"tool": "write_file", "arguments": {"path": "src/ai_provider.rs", "content": "${rust}"}}`;
    const { calls, truncatedCalls } = extractTextToolCalls(text, ['write_file']);
    expect(truncatedCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].arguments);
    expect(args.path).toBe('src/ai_provider.rs');
    expect(args.content).toBe(rust);
  });

  it('does not lose a key that follows the code', () => {
    const text = `{"tool": "write_file", "arguments": {"content": "${rust}", "path": "a.rs"}}`;
    const args = JSON.parse(extractTextToolCalls(text, ['write_file']).calls[0].arguments);
    expect(args.path).toBe('a.rs');
    expect(args.content).toBe(rust);
  });

  it('refuses a salvaged call whose arguments do not match the tool', () => {
    // Ambiguous input: raw JSON written into a .json file. The split cannot be
    // trusted, so the call must not run with mangled content.
    const text = '{"tool":"write_file","arguments":{"path":"p.json","content":"{"a": "b", "c": "d"}"}}';
    const result = extractTextToolCalls(text, ['write_file'], { write_file: ['path', 'content'] });
    expect(result.calls).toHaveLength(0);
    expect(result.truncatedCalls).toEqual(['write_file']);
  });

  it('flags a block that is shaped like a call but will not parse', () => {
    const result = extractTextToolCalls('```tool_call\n{"tool": write_file, path: a.rs}\n```', ['write_file']);
    expect(result.calls).toHaveLength(0);
    expect(result.malformed).toBe(true);
  });
});
