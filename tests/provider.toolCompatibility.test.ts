/**
 * Endpoints that accept the `tools` parameter and then answer with nothing at
 * all (observed on anymodel.org). The provider must notice, drop `tools`, and
 * drive the model through the textual protocol instead.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/core/ai/openaiCompatible.js';
import { describeToolsAsText, withTextToolProtocol } from '../src/core/ai/textToolProtocol.js';
import { extractTextToolCalls } from '../src/core/ai/toolCallFallback.js';
import type { ToolDefinition } from '../src/core/shared/types.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function provider() {
  return new OpenAICompatibleProvider({
    provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: 'am/nemotron-3-ultra-550b-a55b',
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 5000,
    streaming: false,
    apiKey: 'sk-test'
  } as any);
}

const writeFile: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content']
  },
  category: 'filesystem',
  risk: 'MEDIUM',
  mutating: true
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const EMPTY = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
const TEXT_CALL = {
  choices: [
    {
      message: {
        content: 'Creating it.\n\n```tool_call\n{"tool":"write_file","arguments":{"path":"a.py","content":"x"}}\n```'
      },
      finish_reason: 'stop'
    }
  ]
};

describe('textual tool protocol prompt', () => {
  it('lists each tool with its arguments and marks the optional ones', () => {
    const text = describeToolsAsText([
      writeFile,
      { ...writeFile, name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'number' } }, required: ['path'] } }
    ]);
    expect(text).toContain('- write_file(path: string, content: string) — Create or overwrite a file.');
    expect(text).toContain('maxBytes: number (optional)');
    expect(text).toContain('```tool_call');
  });

  it('extends the existing system prompt rather than adding a second one', () => {
    const messages = withTextToolProtocol(
      [{ role: 'system', content: 'You are Nexus Code.' }, { role: 'user', content: 'hi' }],
      [writeFile]
    );
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(messages[0].content).toContain('You are Nexus Code.');
    expect(messages[0].content).toContain('TOOL PROTOCOL');
  });
});

describe('endpoint that returns nothing for a tools request', () => {
  it('retries without tools and recovers the call from the text', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(bodies.length === 1 ? EMPTY : TEXT_CALL);
    }) as any;

    const p = provider();
    const response = await p.sendMessage({
      messages: [{ role: 'system', content: 'You are Nexus Code.' }, { role: 'user', content: 'make a file' }],
      tools: [writeFile]
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools, 'the first attempt uses native function calling').toHaveLength(1);
    expect(bodies[1].tools, 'the retry must not send tools at all').toBeUndefined();
    expect(bodies[1].tool_choice).toBeUndefined();
    expect(bodies[1].messages[0].content).toContain('write_file(path: string, content: string)');

    // The caller still gets usable content; agentController turns it into a call.
    expect(response.content).toContain('tool_call');
    expect(p.usesTextToolProtocol).toBe(true);
    expect(p.describe().nativeToolCalls).toBe('no');
  });

  it('remembers the endpoint cannot do it and stops paying for the failed attempt', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      calls += 1;
      const body = JSON.parse(init.body);
      // After the first discovery, tools must never be sent again.
      if (calls > 2) expect(body.tools).toBeUndefined();
      return jsonResponse(calls === 1 ? EMPTY : TEXT_CALL);
    }) as any;

    const p = provider();
    const request = { messages: [{ role: 'user' as const, content: 'go' }], tools: [writeFile] };
    await p.sendMessage(request);
    await p.sendMessage(request);
    await p.sendMessage(request);

    expect(calls).toBe(4); // 2 for discovery, then 1 each
  });

  it('leaves a working endpoint alone', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }]
            },
            finish_reason: 'tool_calls'
          }
        ]
      });
    }) as any;

    const p = provider();
    const response = await p.sendMessage({ messages: [{ role: 'user', content: 'go' }], tools: [writeFile] });

    expect(bodies).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe('write_file');
    expect(p.describe().nativeToolCalls).toBe('yes');
  });

  it('does not switch when the reply was merely cut short by the token limit', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    }) as any;

    const p = provider();
    await p.sendMessage({ messages: [{ role: 'user', content: 'go' }], tools: [writeFile] });
    expect(bodies).toHaveLength(1);
    expect(p.usesTextToolProtocol).toBe(false);
  });
});

describe('tolerant reading of the reply', () => {
  it('accepts content sent as an array of parts', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        choices: [{ message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] }, finish_reason: 'stop' }]
      })) as any;

    const response = await provider().sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('Hello world');
  });

  it('accepts a completion-style reply that puts the answer in choice.text', async () => {
    globalThis.fetch = (async () => jsonResponse({ choices: [{ text: 'Hello', finish_reason: 'stop' }] })) as any;
    const response = await provider().sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('Hello');
  });
});

describe('streaming in compatibility mode', () => {
  it('types out the prose but never the raw tool_call block', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Creating the file. "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"```tool_call\\n{\\"tool\\":\\"write_file\\","}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\"arguments\\":{}}\\n```"}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse(EMPTY) as any;
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
            controller.close();
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }) as any;

    const seen: string[] = [];
    const p = provider();
    const response = await p.streamMessage(
      { messages: [{ role: 'user', content: 'go' }], tools: [writeFile] },
      { onDelta: (t) => seen.push(t) }
    );

    expect(seen.join('')).toBe('Creating the file. ');
    expect(seen.join('')).not.toContain('tool_call');
    // The full text is still returned, so the call can be parsed from it.
    expect(response.content).toContain('"tool":"write_file"');
  });
});

describe('endpoint that answers in prose instead of calling a tool', () => {
  const PROSE = {
    choices: [
      {
        message: { content: 'Sure! Here is a snake game:\n\n```python\nimport pygame\n```\nSave it as snake.py.' },
        finish_reason: 'stop'
      }
    ]
  };

  it('switches to the textual protocol and shows the model its failed attempt', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(bodies.length === 1 ? PROSE : TEXT_CALL);
    }) as any;

    const p = provider();
    const response = await p.sendMessage({
      messages: [{ role: 'system', content: 'You are Nexus Code.' }, { role: 'user', content: 'make snake' }],
      tools: [writeFile],
      requireToolCall: true
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1].tools).toBeUndefined();
    expect(bodies[1].messages[0].content).toContain('TOOL PROTOCOL');
    const last = bodies[1].messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.content).toContain('changed nothing on the computer');
    expect(response.content).toContain('"tool":"write_file"');
  });

  it('leaves Chat mode alone: prose is a valid answer when no action was required', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(PROSE);
    }) as any;

    const p = provider();
    await p.sendMessage({ messages: [{ role: 'user', content: 'how do I write snake?' }], tools: [writeFile] });

    expect(bodies).toHaveLength(1);
    expect(p.usesTextToolProtocol).toBe(false);
  });

  it('does not retry when the prose already contains a usable call', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(TEXT_CALL);
    }) as any;

    const p = provider();
    await p.sendMessage({ messages: [{ role: 'user', content: 'go' }], tools: [writeFile], requireToolCall: true });
    expect(bodies).toHaveLength(1);
  });
});

describe('the escalation ladder', () => {
  const PROSE = { choices: [{ message: { content: 'I would write snake.py like this...' }, finish_reason: 'stop' }] };

  it('adds a worked example in compatibility mode', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(bodies.length === 1 ? PROSE : TEXT_CALL);
    }) as any;

    await provider().sendMessage({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      tools: [writeFile],
      requireToolCall: true
    });

    const roles = bodies[1].messages.map((m: any) => m.role);
    expect(roles.slice(0, 5)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(bodies[1].messages[2].content).toContain('```tool_call');
  });

  it('forces the block open when even the example is ignored, and repairs the prefill', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length < 3) return jsonResponse(PROSE);
      // Prefilled with '{', so the model continues the object.
      return jsonResponse({
        choices: [{ message: { content: '"tool": "write_file", "arguments": {"path": "a.py", "content": "x"}}' }, finish_reason: 'stop' }]
      });
    }) as any;

    const p = provider();
    const response = await p.sendMessage({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      tools: [writeFile],
      requireToolCall: true
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[2].messages.at(-1)).toEqual({ role: 'assistant', content: '```tool_call\n{' });
    // The caller can parse it: the opening brace is back.
    expect(response.content.startsWith('{')).toBe(true);
    expect(extractTextToolCalls(response.content, ['write_file']).calls[0].name).toBe('write_file');
  });

  it('reads the legacy function_call shape as a real tool call', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        choices: [
          { message: { content: '', function_call: { name: 'write_file', arguments: '{"path":"a.py"}' } }, finish_reason: 'function_call' }
        ]
      })) as any;

    const response = await provider().sendMessage({ messages: [{ role: 'user', content: 'go' }], tools: [writeFile] });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe('write_file');
  });
});

describe('endpoints that reject a trailing assistant message', () => {
  it('keeps the run alive instead of failing the request', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      n += 1;
      const body = JSON.parse(init.body);
      if (body.messages.at(-1).role === 'assistant') return new Response('prefill not allowed', { status: 400 });
      return jsonResponse({ choices: [{ message: { content: 'I would write the file.' }, finish_reason: 'stop' }] });
    }) as any;

    const response = await provider().sendMessage({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeFile],
      requireToolCall: true
    });

    expect(n).toBe(3);
    expect(response.content).toContain('I would write the file.');
  });
});

describe('an endpoint that answers with silence', () => {
  const SILENT = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
  const OK = { choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] };

  it('omits max_tokens entirely when the setting is 0', async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(OK);
    }) as any;

    const p = new OpenAICompatibleProvider({
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      model: 'm',
      temperature: 0.2,
      maxTokens: 0,
      timeoutMs: 5000,
      streaming: false,
      apiKey: 'sk'
    } as any);
    await p.sendMessage({ messages: [{ role: 'user', content: 'hi' }] });

    expect('max_tokens' in bodies[0]).toBe(false);
  });

  it('retries without the token limit, then with a smaller payload', async () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `message ${i}` }));
    const bodies: any[] = [];
    let attempts = 0; // not reset below, unlike `bodies`
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      attempts += 1;
      return jsonResponse(attempts < 3 ? SILENT : OK);
    }) as any;

    const p = provider();
    const response = await p.sendMessage({ messages: [{ role: 'system', content: 'sys' }, ...history] });

    expect(bodies).toHaveLength(3);
    expect(bodies[0].max_tokens).toBe(1024);
    expect('max_tokens' in bodies[1], 'second attempt drops the limit').toBe(false);
    expect(bodies[2].messages.length).toBeLessThan(bodies[1].messages.length);
    expect(bodies[2].messages[0].role).toBe('system');
    expect(response.content).toBe('ready');

    // Both discoveries stick, so the next turn is answered first time.
    bodies.length = 0;
    await p.sendMessage({ messages: [{ role: 'user', content: 'again' }] });
    expect(bodies).toHaveLength(1);
    expect('max_tokens' in bodies[0]).toBe(false);
    expect(p.describe().maxTokensOmitted).toBe(true);
    expect(p.describe().payloadReduced).toBe(true);
  });

  it('keeps only the essential tools when it shrinks the request', async () => {
    const extras = Array.from({ length: 12 }, (_, i) => ({ ...writeFile, name: `obscure_tool_${i}` }));
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(bodies.length < 4 ? SILENT : OK);
    }) as any;

    const p = provider();
    await p.sendMessage({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      tools: [writeFile, ...extras],
      requireToolCall: true
    });

    // With tools in play the cheaper fix comes first: the textual protocol.
    expect(bodies[0].tools).toBeTruthy();
    expect(bodies[1].tools).toBeUndefined();
    // Then the token limit, then the reduced payload.
    expect('max_tokens' in bodies[2]).toBe(false);
    expect(bodies[3].messages.length).toBeLessThanOrEqual(bodies[2].messages.length);
  });
});
