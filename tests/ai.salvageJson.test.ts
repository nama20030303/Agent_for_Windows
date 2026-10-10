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


describe('Windows paths inside the JSON', () => {
  // Reported from a real session: the model recorded its requirements and the
  // call vanished, because `\N` in `%APPDATA%\NexusCode\` is not a legal JSON
  // escape. The whole reply was discarded and the agent appeared to idle.
  it('accepts a call whose string holds an unescaped Windows path', () => {
    const raw =
      '{"tool": "record_requirements", "arguments": {"summary": "s", "assumptions": ' +
      '["Configuration via %APPDATA%\\NexusCode\\ with secure API key storage"]}}';
    const result = extractTextToolCalls(raw, ['record_requirements'], { record_requirements: ['summary', 'assumptions'] });
    expect(result.malformed).toBe(false);
    expect(result.calls).toHaveLength(1);
    const args = JSON.parse(result.calls[0].arguments);
    expect(args.assumptions[0]).toBe('Configuration via %APPDATA%\\NexusCode\\ with secure API key storage');
  });

  it('writes a file to a literal Windows path without mangling it', () => {
    const raw = '```tool_call\n{"tool": "write_file", "arguments": {"path": "C:\\Users\\me\\app\\main.py", "content": "x = 1\n"}}\n```';
    const result = extractTextToolCalls(raw, ['write_file'], { write_file: ['path', 'content'] });
    expect(result.calls).toHaveLength(1);
    const args = JSON.parse(result.calls[0].arguments);
    expect(args.path).toBe('C:\\Users\\me\\app\\main.py');
    expect(args.content).toBe('x = 1\n');
  });

  it('still honours the escapes a careful model does write', () => {
    const raw = '{"tool": "write_file", "arguments": {"path": "a.txt", "content": "line\\none\\t\\"quoted\\"\\u0041"}}';
    const result = extractTextToolCalls(raw, ['write_file'], { write_file: ['path', 'content'] });
    expect(result.calls).toHaveLength(1);
    expect(JSON.parse(result.calls[0].arguments).content).toBe('line\none\t"quoted"A');
  });
});

describe('the XML dialect', () => {
  const known = ['write_file', 'read_file', 'finish'];
  const schemas = { write_file: ['path', 'content'], read_file: ['path', 'startLine'], finish: ['report', 'success'] };

  // Taken from a real session: the model switched to this syntax and the app
  // understood none of it, so two long replies produced nothing at all.
  it('reads a call written as tags, keeping the content byte for byte', () => {
    const content = ['# Tool System', '', '```typescript', 'interface X { "a": \'b\\\\c\' }', '```'].join('\n');
    const raw = [
      "I'll write the spec.",
      '',
      '<tool_call>',
      '<function=write_file>',
      '<parameter=path>',
      'docs/tool-system.md',
      '</parameter>',
      '<parameter=content>',
      content,
      '</parameter>',
      '</function>',
      '</tool_call>'
    ].join('\n');

    const result = extractTextToolCalls(raw, known, schemas);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('write_file');
    const args = JSON.parse(result.calls[0].arguments);
    expect(args.path).toBe('docs/tool-system.md');
    // Nothing in this form needs escaping, so nothing may be altered.
    expect(args.content).toBe(content);
    // And the sentence the model wrote is what the user sees.
    expect(result.cleaned).toBe("I'll write the spec.");
    expect(result.malformed).toBe(false);
  });

  it('accepts the attribute spelling and converts obvious scalars', () => {
    const raw =
      '<tool_call>\n<function name="finish">\n<parameter name="report">All done</parameter>\n' +
      '<parameter name="success">true</parameter>\n</function>\n</tool_call>';
    const result = extractTextToolCalls(raw, known, schemas);
    expect(result.calls).toHaveLength(1);
    const args = JSON.parse(result.calls[0].arguments);
    expect(args).toEqual({ report: 'All done', success: true });
  });

  it('reports an invented tool name in this form too', () => {
    const raw = '<tool_call>\n<function=summon_dragon>\n<parameter=size>large</parameter>\n</function>\n</tool_call>';
    const result = extractTextToolCalls(raw, known, schemas);
    expect(result.calls).toHaveLength(0);
    expect(result.unknownTools).toEqual(['summon_dragon']);
  });
});

describe('documentation is not a command', () => {
  // A real session wrote a specification that *described* the tools, and the
  // app executed the description: read_file was called with the keys of a
  // JSON schema. Text is data until it fits the tool it names.
  it('ignores a JSON schema in prose that merely names a tool', () => {
    const raw = [
      'Here is the schema I will implement:',
      '',
      '{"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}',
      '',
      'I will write it to the docs next.'
    ].join('\n');

    const result = extractTextToolCalls(raw, ['read_file', 'write_file'], { read_file: ['path', 'startLine', 'endLine'] });
    expect(result.calls).toHaveLength(0);
  });

  it('still runs the same tool when the arguments really are its own', () => {
    const raw = 'Reading it.\n\n{"name": "read_file", "arguments": {"path": "src/app.ts"}}';
    const result = extractTextToolCalls(raw, ['read_file'], { read_file: ['path', 'startLine', 'endLine'] });
    expect(result.calls).toHaveLength(1);
    expect(JSON.parse(result.calls[0].arguments).path).toBe('src/app.ts');
  });
});
