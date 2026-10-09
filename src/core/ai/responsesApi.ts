import type { ChatMessage, ToolDefinition } from '../shared/types.js';
import type { RawToolCall } from './provider.js';

/**
 * The second request shape an OpenAI-compatible gateway may speak.
 *
 * Some providers (AnyModel among them) expose both `/v1/chat/completions` and
 * the newer `/v1/responses`, and route a given model to only one of them. When
 * the chat endpoint accepts a request and answers with an empty completion,
 * trying this shape is the difference between a working app and a dead one.
 *
 * Only the subset the agent needs is implemented: a conversation in, text and
 * function calls out.
 */

export function buildResponsesBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  maxTokens: number | undefined,
  temperature: number | undefined
): Record<string, unknown> {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        // A tool result has no first-class role here; carry it as user text.
        return { role: 'user', content: `Tool result (${m.name ?? 'tool'}): ${m.content}` };
      }
      return { role: m.role, content: m.content };
    });

  const body: Record<string, unknown> = { model, input };
  if (instructions) body.instructions = instructions;
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
  if (temperature !== undefined) body.temperature = temperature;
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }
  return body;
}

function textFromContent(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');
}

export interface ParsedResponse {
  content: string;
  reasoning?: string;
  toolCalls: RawToolCall[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export function parseResponsesJson(json: any): ParsedResponse {
  let content = typeof json?.output_text === 'string' ? json.output_text : '';
  let reasoning = '';
  const toolCalls: RawToolCall[] = [];

  for (const item of json?.output ?? []) {
    if (item?.type === 'message') content += textFromContent(item.content);
    else if (item?.type === 'reasoning') reasoning += textFromContent(item.content ?? item.summary);
    else if (item?.type === 'function_call' && item.name) {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
      });
    }
  }

  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls,
    finishReason: json?.status === 'incomplete' ? 'length' : 'stop',
    usage: { inputTokens: json?.usage?.input_tokens ?? 0, outputTokens: json?.usage?.output_tokens ?? 0 }
  };
}
