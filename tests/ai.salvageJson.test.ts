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
