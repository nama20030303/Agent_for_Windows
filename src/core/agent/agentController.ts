import path from 'node:path';
import type {
  AgentEvent,
  AgentMode,
  AgentQuestion,
  AgentState,
  ChatMessage,
  Plan,
  ProjectIndex,
  RequirementAnalysis,
  ToolCall,
  ToolResult,
  VerificationReport
} from '../shared/types.js';
import type { AIProvider } from '../ai/provider.js';
import { AIProviderError } from '../ai/provider.js';
import type { ToolManager } from '../tools/registry.js';
import { META_TOOL_NAMES } from '../tools/meta.js';
import type { PermissionManager } from '../permissions/permissionManager.js';
import type { ContextManager } from '../context/contextManager.js';
import { wrapUntrusted } from '../context/contextManager.js';
import type { ProjectIndexer } from '../indexer/projectIndexer.js';
import { detectEnvironment } from '../indexer/environment.js';
import type { VerificationEngine } from '../verification/verificationEngine.js';
import { summarizeReport } from '../verification/verificationEngine.js';
import { repairHint } from '../verification/errorClassifier.js';
import type { ProcessManager } from '../process/processManager.js';
import type { SessionManager } from '../session/sessionManager.js';
import type { CheckpointManager } from '../session/checkpointManager.js';
import { Emitter } from '../shared/emitter.js';
import { createLogger } from '../shared/logger.js';
import { nowIso, uid } from '../shared/ids.js';
import { redactSecrets } from '../shared/secrets.js';
import { AgentStateMachine } from './stateMachine.js';
import { TaskManager } from './taskManager.js';
import { extractTextToolCalls } from '../ai/toolCallFallback.js';
import { analyzeRequirements } from './requirementAnalyzer.js';
import { buildSystemPrompt } from './prompts.js';
import type { ShellKind } from '../process/shell.js';

const log = createLogger('agent');

export interface AgentDependencies {
  provider: AIProvider;
  tools: ToolManager;
  permissions: PermissionManager;
  context: ContextManager;
  indexer: ProjectIndexer;
  verification: VerificationEngine;
  processes: ProcessManager;
  sessions: SessionManager;
  checkpoints: CheckpointManager;
}

export interface AgentRunOptions {
  sessionId: string;
  projectId: string;
  workspaceRoot: string;
  mode: AgentMode;
  shell: ShellKind;
  userMessage: string;
  maxIterations?: number;
  maxRepairAttempts?: number;
  requirePlanApproval?: boolean;
}

interface SessionRuntime {
  history: ChatMessage[];
  /** Whether persisted turns from earlier runs have been replayed into history. */
  restored: boolean;
  tasks: TaskManager;
  state: AgentStateMachine;
  abort?: AbortController;
  repairAttempts: number;
  lastFailureSignature?: string;
  filesCreated: Set<string>;
  filesModified: Set<string>;
  filesDeleted: Set<string>;
  /** A tool that ran a command, a test or a process actually executed. */
  ranSomething: boolean;
  /** `finish` was already bounced back once for reporting work nobody did. */
  emptyFinishes: number;
  verified: boolean;
  lastReport?: VerificationReport;
  pendingPlan?: Plan;
  running: boolean;
}

/**
 * The agent loop. Every path from the model to the operating system goes
 * through the ToolManager, which enforces schema validation, security
 * validation and the permission system.
 */
/** How many stored turns are replayed when a session is resumed. */
const MAX_RECOVERED_TURNS = 40;
const MAX_RECOVERED_ACTIONS = 40;

const PROSE_ONLY_NUDGE =
  'You described the work but called no tool, so nothing changed on the computer. Perform the work now ' +
  'with tool calls. If your endpoint cannot emit native tool calls, reply with only a ```tool_call fenced ' +
  'JSON block: { "tool": "<name>", "arguments": { ... } }.';

const EMPTY_RESPONSE_NUDGE =
  'Your last reply contained no answer and no tool call. Put your answer in the normal response ' +
  'content (not in an internal reasoning field), or call a tool. Continue now.';

/**
 * A model that returns nothing is a configuration problem, not a finished task.
 * Turn the response shape into an explanation the user can act on.
 */
export function diagnoseEmptyResponse(
  response: { content: string; reasoning?: string; finishReason: string },
  provider: {
    model: string;
    baseUrl: string;
    nativeToolCalls?: 'unknown' | 'yes' | 'no';
    maxTokensOmitted?: boolean;
    payloadReduced?: boolean;
  }
): string {
  const where = `Model \`${provider.model}\` at \`${provider.baseUrl || '(no endpoint configured)'}\``;

  if (response.finishReason === 'length') {
    return (
      `${where} hit its output token limit before producing an answer. ` +
      'Raise "Max tokens" in Settings, or set it to 0 to remove the limit entirely.'
    );
  }
  if (response.reasoning) {
    return (
      `${where} replied with internal reasoning only and no answer or tool call. ` +
      'The model is thinking but never committing to an answer. Set "Max tokens" to 0 (no limit) so it ' +
      'can finish, and prefer a model that supports function calling.'
    );
  }

  // Everything the app already tried on its own, so the advice does not repeat it.
  const tried = [
    provider.nativeToolCalls === 'no' ? 'without the tools parameter' : null,
    provider.maxTokensOmitted ? 'without any max_tokens limit' : null,
    provider.payloadReduced ? 'with a reduced prompt and fewer tools' : null
  ].filter(Boolean) as string[];

  const already = tried.length ? ` The app already retried ${tried.join(', ')}, and the reply was still empty.` : '';

  return (
    `${where} returned an empty response (finish reason: ${response.finishReason}).${already} ` +
    'The endpoint answers but produces no text, which almost always means this model name is routed ' +
    'nowhere by the provider. Open Settings and press "Find a working model": the app will ask the ' +
    'provider which models it really hosts, try them, and switch to the first one that replies.'
  );
}

export class AgentController {
  readonly events = new Emitter<AgentEvent>();
  private runtimes = new Map<string, SessionRuntime>();

  constructor(private deps: AgentDependencies) {}

  getState(sessionId: string): AgentState {
    return this.runtimes.get(sessionId)?.state.current ?? 'IDLE';
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.running === true;
  }

  tasks(sessionId: string) {
    return this.runtimes.get(sessionId)?.tasks.list() ?? [];
  }

  stop(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.state.force('STOPPING');
    this.emitState(sessionId, 'STOPPING', 'Stop requested by the user.');
    rt.abort?.abort();
  }

  /** Discards in-memory runtime (used when a session is closed). */
  release(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }

  private runtime(options: AgentRunOptions): SessionRuntime {
    let rt = this.runtimes.get(options.sessionId);
    if (!rt) {
      const stored = this.deps.sessions.listTasks(options.sessionId);
      rt = {
        history: [],
        restored: false,
        tasks: new TaskManager(options.sessionId, stored),
        state: new AgentStateMachine(this.deps.sessions.getAgentState(options.sessionId)?.state ?? 'IDLE'),
        repairAttempts: 0,
        filesCreated: new Set(),
        filesModified: new Set(),
        filesDeleted: new Set(),
        ranSomething: false,
        emptyFinishes: 0,
        verified: false,
        running: false
      };
      this.runtimes.set(options.sessionId, rt);
    }
    return rt;
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
  }

  private emitState(sessionId: string, state: AgentState, detail?: string): void {
    const rt = this.runtimes.get(sessionId);
    if (rt && rt.state.current !== state) rt.state.transition(state) || rt.state.force(state);
    this.deps.sessions.saveAgentState(sessionId, state, detail ? { detail } : undefined);
    this.emit({ type: 'agent_state_change', sessionId, state, detail });
  }

  private timeline(sessionId: string, message: string): void {
    this.emit({ type: 'timeline', sessionId, at: nowIso(), message });
  }

  /* ------------------------------------------------------------------ run */

  async run(options: AgentRunOptions): Promise<void> {
    const rt = this.runtime(options);
    if (rt.running) throw new Error('The agent is already working in this session.');

    const abort = new AbortController();
    rt.abort = abort;
    rt.running = true;
    rt.repairAttempts = 0;
    rt.state.force(rt.state.current === 'IDLE' ? 'ANALYZING' : rt.state.current);
    this.emitState(options.sessionId, 'ANALYZING', 'Understanding the request');

    const maxIterations = options.maxIterations ?? 40;
    const maxRepairAttempts = options.maxRepairAttempts ?? 5;
    let emptyResponses = 0;
    let proseOnlyReplies = 0;
    let invented = 0;
    let cutOff = 0;
    let malformedReplies = 0;
    /** The last reply carried a tool call the app could not read. */
    let brokenCall = false;

    try {
      const endpoint = this.deps.provider.describe();
      if (!endpoint.baseUrl.trim()) {
        const message =
          'No AI endpoint is configured. Open Settings, enter the OpenAI-compatible base URL of the ' +
          `host that serves \`${endpoint.model}\` (it ends in /v1), add the API key and use "Test connection".`;
        this.emit({ type: 'error', sessionId: options.sessionId, message });
        this.emitState(options.sessionId, 'FAILED', 'No AI endpoint configured.');
        return;
      }

      await this.prepareContext(options, rt);

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (abort.signal.aborted) break;

        const response = await this.callModel(options, rt, abort.signal);
        if (abort.signal.aborted) break;

        // Endpoints without native function calling: accept an explicit textual
        // call so the agent can still act. Thinking models sometimes put it in
        // the reasoning channel, so that is checked too.
        if (response.toolCalls.length === 0) {
          const definitions = this.deps.tools.definitions();
          const names = definitions.map((d) => d.name);
          // The declared argument names let a salvaged parse be sanity-checked.
          const schemas: Record<string, string[]> = {};
          for (const definition of definitions) {
            const properties = (definition.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
            schemas[definition.name] = properties ? Object.keys(properties) : [];
          }
          const fromText = extractTextToolCalls(response.content, names, schemas);
          const fromReasoning = fromText.calls.length ? null : extractTextToolCalls(response.reasoning ?? '', names, schemas);
          const found = fromReasoning?.calls.length ? fromReasoning : fromText;
          // Invented names from either channel: losing them would turn a
          // correctable mistake into a dead run.
          const unknownTools = [...new Set([...fromText.unknownTools, ...(fromReasoning?.unknownTools ?? [])])];
          const truncated = [...new Set([...fromText.truncatedCalls, ...(fromReasoning?.truncatedCalls ?? [])])];
          // The call text itself is never shown to the user, whether or not it
          // could be run: the chat shows what happened, the activity feed
          // shows the call.
          response.content = fromText.cleaned;
          brokenCall = fromText.malformed || truncated.length > 0 || unknownTools.length > 0;

          if (found.calls.length) {
            response.toolCalls = found.calls;
            this.timeline(options.sessionId, `Interpreted ${found.calls.length} textual tool call(s) from the model`);
          } else if (fromText.malformed && malformedReplies < 2) {
            // It used the protocol, but the JSON would not parse — almost
            // always an unescaped quote or newline in a file's content.
            malformedReplies += 1;
            rt.history.push({
              role: 'user',
              content:
                'Your tool_call block was not valid JSON, so nothing ran. Inside a JSON string every double ' +
                'quote must be written as \\" and every line break as \\n. Send the call again, correctly ' +
                'escaped, and keep the content short enough to finish in one reply.'
            });
            this.timeline(options.sessionId, 'Model sent a malformed tool call; asking it to escape the JSON');
            continue;
          } else if (truncated.length && cutOff < 2) {
            // The call was cut off mid-JSON. Running it would write half a
            // file, so ask for it again in pieces the model can finish.
            cutOff += 1;
            rt.history.push({
              role: 'user',
              content:
                `Your \`${truncated[0]}\` call was cut off in the middle of the JSON, so nothing was run. ` +
                'The content was too long for one reply. Build the file in pieces instead: call `write_file` ' +
                'with the first part, then `append_file` with each following part. Keep every call under ' +
                'about 150 lines.'
            });
            this.timeline(options.sessionId, `Model's ${truncated[0]} call was truncated; asking for smaller pieces`);
            continue;
          } else if (unknownTools.length && invented < 2) {
            // It used the protocol correctly but invented a tool. Name the real
            // ones and let it try again instead of failing the run.
            invented += 1;
            rt.history.push({
              role: 'user',
              content:
                `There is no tool called ${unknownTools.map((n) => `\`${n}\``).join(', ')}. ` +
                `The tools you can use are: ${names.join(', ')}. Repeat the call with the correct name.`
            });
            this.timeline(options.sessionId, `Model called an unknown tool (${unknownTools.join(', ')}); correcting it`);
            continue;
          }
        }

        const content = response.content.trim();
        if (content) {
          this.emit({ type: 'assistant_message', sessionId: options.sessionId, content, final: response.toolCalls.length === 0 });
          this.deps.sessions.appendMessage({ sessionId: options.sessionId, role: 'assistant', content });
        }

        rt.history.push({
          role: 'assistant',
          content,
          toolCalls: response.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }))
        });

        this.emit({ type: 'usage', sessionId: options.sessionId, usage: this.deps.provider.usage() });

        if (response.toolCalls.length === 0) {
          if (content) {
            const executing = options.mode === 'agent' || options.mode === 'auto';
            const asksSomething = /\?\s*$/.test(content);

            // In an executing mode a prose answer means nothing was done. Saying
            // "completed" there is exactly the fake success this agent must not
            // produce. Nudge once, then stop and say plainly that it is stuck.
            if (executing && !asksSomething && !rt.verified) {
              if (proseOnlyReplies === 0) {
                proseOnlyReplies += 1;
                rt.history.push({ role: 'user', content: PROSE_ONLY_NUDGE });
                this.timeline(options.sessionId, 'Model answered without acting; asking it to use tools');
                continue;
              }
              const sample = content.replace(/\s+/g, ' ').slice(0, 300);
              this.emit({
                type: 'error',
                sessionId: options.sessionId,
                message:
                  `The model answered with text again ("${sample}${content.length > 300 ? '…' : ''}"), so nothing ` +
                  'was changed on disk. ' +
                  'The app had already retried in compatibility mode: tools described in the prompt, a worked ' +
                  'example, and the block opened for it. The model still would not use it. This model is ' +
                  'too weak or too chatty to drive the agent: pick one advertised with "Function Calling" ' +
                  '/ "Tools", or raise "Max tokens" if its replies are being cut short. Chat and Plan ' +
                  'modes still work with it.'
              });
              this.emitState(options.sessionId, 'BLOCKED', 'The model is not calling tools.');
              break;
            }

            // Chat, Plan, a question to the user, or work already verified.
            this.emitState(options.sessionId, 'COMPLETED', 'Response delivered');
            break;
          }

          // Nothing at all came back. Never report this as a finished turn:
          // nudge the model once, then explain the problem to the user.
          if (emptyResponses === 0) {
            emptyResponses += 1;
            rt.history.push({ role: 'user', content: EMPTY_RESPONSE_NUDGE });
            this.timeline(options.sessionId, 'Model returned an empty response; retrying once');
            continue;
          }

          // The reply was not empty: it was a tool call the app could not read
          // and therefore removed from the message. Saying "the endpoint
          // returned nothing" would send the user hunting the wrong problem.
          if (brokenCall) {
            this.emit({
              type: 'error',
              sessionId: options.sessionId,
              message:
                'The model kept sending tool calls this app could not read, so nothing was run. Its last ' +
                'replies contained a call whose JSON was broken — usually an unescaped quote, line break or ' +
                'backslash inside file content. The full text is in the activity timeline. Try a model ' +
                'advertised with "Function Calling" / "Tools", or ask for a smaller change so the call fits ' +
                'in one reply.'
            });
            this.emitState(options.sessionId, 'BLOCKED', 'The model\'s tool calls could not be read.');
            break;
          }

          const diagnosis = diagnoseEmptyResponse(response, this.deps.provider.describe());
          this.emit({ type: 'error', sessionId: options.sessionId, message: diagnosis });
          this.emitState(options.sessionId, 'FAILED', 'The model returned no usable response.');
          break;
        }
        emptyResponses = 0;
        proseOnlyReplies = 0;

        let shouldPause = false;
        let finished = false;

        for (const raw of response.toolCalls) {
          if (abort.signal.aborted) break;
          const call: ToolCall = { id: raw.id, name: raw.name, arguments: safeParseArgs(raw.arguments) };
          const outcome = await this.dispatch(call, options, rt, abort.signal, maxRepairAttempts);
          rt.history.push({
            role: 'tool',
            name: call.name,
            toolCallId: call.id,
            content: this.deps.context.truncateToolResult(renderToolResult(outcome.result))
          });
          this.persistAction(options.sessionId, call, outcome.result);
          if (outcome.pause) shouldPause = true;
          if (outcome.finish) finished = true;
        }

        if (finished || shouldPause) break;
      }

      if (abort.signal.aborted) {
        this.emitState(options.sessionId, 'STOPPED', 'Stopped by the user. The session can be resumed.');
        this.timeline(options.sessionId, 'Agent stopped by the user');
      } else if (this.getState(options.sessionId) === 'EXECUTING' || this.getState(options.sessionId) === 'RUNNING_TOOL') {
        this.emitState(options.sessionId, 'BLOCKED', 'Iteration limit reached before the agent reported completion.');
        this.emit({
          type: 'assistant_message',
          sessionId: options.sessionId,
          content:
            'I reached the iteration limit for this turn without finishing. The work done so far is saved — tell me to continue and I will resume from the current state.',
          final: true
        });
      }
    } catch (err) {
      const message = err instanceof AIProviderError ? err.message : (err as Error).message;
      log.error('Agent run failed', { reason: message });

      // An overloaded or rate-limited provider is not a failed task. The work
      // already done is on disk and in the session, so the run is reported as
      // blocked and the user is told it can simply be continued. Calling this
      // FAILED threw away a long run over a passing 503.
      const transient = err instanceof AIProviderError && (err.kind === 'server' || err.kind === 'rate_limit' || err.kind === 'timeout');
      if (transient) {
        const done = rt.filesCreated.size + rt.filesModified.size + rt.filesDeleted.size;
        this.emit({
          type: 'error',
          sessionId: options.sessionId,
          message:
            `${message} The provider is busy or unreachable right now, so the agent stopped between steps. ` +
            `Nothing was lost${done ? ` — ${done} file(s) already changed are saved` : ''}: say "continue" to ` +
            'resume from where it stopped.'
        });
        this.emitState(options.sessionId, 'BLOCKED', 'The provider is unavailable. The session can be resumed.');
      } else {
        this.emit({ type: 'error', sessionId: options.sessionId, message });
        this.emitState(options.sessionId, 'FAILED', message);
      }
    } finally {
      rt.running = false;
      rt.abort = undefined;
      for (const task of rt.tasks.list()) this.deps.sessions.upsertTask(task);
    }
  }

  /* -------------------------------------------------------------- context */

  private async prepareContext(options: AgentRunOptions, rt: SessionRuntime): Promise<void> {
    const first = rt.history.length === 0;

    let index: ProjectIndex | null = null;
    if (options.workspaceRoot) {
      this.emitState(options.sessionId, 'INSPECTING_PROJECT', 'Indexing the project');
      index = first
        ? await this.deps.indexer.index(options.workspaceRoot)
        : await this.deps.indexer.refresh(options.workspaceRoot);
      this.timeline(options.sessionId, `Project indexed: ${index.fileCount} files`);
    }

    const memory = this.deps.sessions.getMemory(options.projectId);
    const projectContext = this.deps.context.buildProjectContext(index, memory, rt.tasks.list());
    const environment = first ? formatEnvironment(await detectEnvironment(options.workspaceRoot)) : '';

    const systemPrompt = buildSystemPrompt({
      mode: options.mode,
      workspaceRoot: options.workspaceRoot,
      shell: options.shell,
      permissionMode: this.deps.permissions.getMode(),
      environment,
      projectContext,
      maxRepairAttempts: options.maxRepairAttempts ?? 5,
      requirePlanApproval: options.requirePlanApproval ?? true
    });

    if (first) {
      rt.history.push({ role: 'system', content: systemPrompt });
    } else {
      rt.history[0] = { role: 'system', content: systemPrompt };
    }

    // A runtime is created fresh after a restart, after release(), or when the
    // user returns to an earlier session. Without this the model would answer
    // with no memory of what was already said or done in that session.
    if (!rt.restored) {
      rt.restored = true;
      for (const message of this.recoverTurns(options.sessionId)) rt.history.push(message);
    }

    // Deterministic requirement pre-analysis (visible to the user and to the model).
    this.emitState(options.sessionId, 'ANALYZING_REQUIREMENTS', 'Analysing requirements');
    const analysis: RequirementAnalysis = analyzeRequirements({
      request: options.userMessage,
      index,
      decided: [...memory.stack, ...memory.decisions.map((d) => d.decision)]
    });
    this.emit({ type: 'requirements', sessionId: options.sessionId, analysis });

    const preAnalysis = [
      'REQUIREMENT PRE-ANALYSIS (deterministic, produced by the application):',
      analysis.summary,
      ...analysis.requirements.map((r) => `- [${r.kind}/${r.importance}] ${r.topic}: ${r.statement} (confidence ${r.confidence})`),
      ...(analysis.questions.length
        ? ['Unresolved high-impact decisions:', ...analysis.questions.map((q) => `- ${q.topic}: ${q.question}`)]
        : []),
      ...(analysis.assumptions.length ? ['Safe defaults available:', ...analysis.assumptions.map((a) => `- ${a}`)] : [])
    ].join('\n');

    rt.history.push({ role: 'user', content: `${options.userMessage}\n\n${preAnalysis}` });
    this.deps.sessions.appendMessage({ sessionId: options.sessionId, role: 'user', content: options.userMessage });
  }

  /**
   * Rebuild conversational context from the session store.
   *
   * User and assistant turns are replayed with their real roles. Tool results
   * are not replayed as tool messages — their call ids no longer exist, and the
   * provider would reject them — so they are folded into one compact note of
   * what has already been done.
   */
  /** One durable line per tool call, so a resumed session knows what was already done. */
  private persistAction(sessionId: string, call: ToolCall, result: ToolResult): void {
    const target =
      (typeof call.arguments.path === 'string' && call.arguments.path) ||
      (typeof call.arguments.command === 'string' && call.arguments.command) ||
      (typeof call.arguments.name === 'string' && call.arguments.name) ||
      '';
    const line = `${call.name}${target ? ` ${target}` : ''} → ${result.success ? 'ok' : `failed (${result.errorType ?? 'error'})`}`;
    this.deps.sessions.appendMessage({ sessionId, role: 'tool', content: line.slice(0, 300) });
  }

  private recoverTurns(sessionId: string): ChatMessage[] {
    const stored = this.deps.sessions.listMessages(sessionId);
    if (!stored.length) return [];

    const recent = stored.slice(-MAX_RECOVERED_TURNS);
    const conversation: ChatMessage[] = [];
    const actions: string[] = [];

    for (const message of recent) {
      if (message.role === 'user' || message.role === 'assistant') {
        if (message.content.trim()) conversation.push({ role: message.role, content: message.content });
      } else if (message.role === 'tool' || message.role === 'event') {
        actions.push(message.content);
      }
    }

    if (!conversation.length && !actions.length) return [];

    const header: ChatMessage = {
      role: 'system',
      content:
        'EARLIER TURNS IN THIS SESSION (recovered from storage). Treat them as what you and the user ' +
        'already said. Verify the current state of the filesystem before relying on any of it.' +
        (actions.length
          ? `\n\nActions already performed:\n${actions.slice(-MAX_RECOVERED_ACTIONS).join('\n')}`
          : '')
    };

    log.info('Recovered conversation context', { sessionId, turns: conversation.length, actions: actions.length });
    return [header, ...conversation];
  }

  private async callModel(options: AgentRunOptions, rt: SessionRuntime, signal: AbortSignal) {
    const readOnly = options.mode === 'chat' || options.mode === 'plan';
    const tools = readOnly
      ? this.deps.tools.definitions((d) => !d.mutating || d.category === 'meta')
      : this.deps.tools.definitions();

    rt.history = this.deps.context.compress(rt.history, options.sessionId);
    // In an executing mode a reply without a tool call is useless, and that
    // fact is what lets the provider detect an endpoint without function
    // calling and fall back to its textual protocol.
    const request = { messages: rt.history, tools, signal, requireToolCall: !readOnly };

    if (this.deps.provider.settings.streaming) {
      return this.deps.provider.streamMessage(request, {
        onDelta: (delta) => this.emit({ type: 'assistant_delta', sessionId: options.sessionId, delta }),
        onRestart: () => this.emit({ type: 'assistant_restart', sessionId: options.sessionId })
      });
    }
    return this.deps.provider.sendMessage(request);
  }

  /* --------------------------------------------------------------- tools */

  private async dispatch(
    call: ToolCall,
    options: AgentRunOptions,
    rt: SessionRuntime,
    signal: AbortSignal,
    maxRepairAttempts: number
  ): Promise<{ result: ToolResult; pause: boolean; finish: boolean }> {
    if (META_TOOL_NAMES.has(call.name)) {
      // Planning, analysis and reporting are work the user should see too: a
      // run that only analysed requirements used to look like a dead app.
      this.emit({ type: 'tool_call', sessionId: options.sessionId, call, risk: 'SAFE' });
      const outcome = await this.handleMetaTool(call, options, rt, signal, maxRepairAttempts);
      // And it has to be closed off, or the line sits at "still running" for
      // the rest of the session.
      this.emit({ type: 'tool_result', sessionId: options.sessionId, callId: call.id, result: outcome.result });
      return outcome;
    }

    this.emitState(options.sessionId, 'RUNNING_TOOL', call.name);
    const definition = this.deps.tools.get(call.name)?.definition;
    this.emit({ type: 'tool_call', sessionId: options.sessionId, call, risk: definition?.risk ?? 'MEDIUM' });

    if ((options.mode === 'chat' || options.mode === 'plan') && definition?.mutating) {
      const result: ToolResult = {
        success: false,
        tool: call.name,
        callId: call.id,
        denied: true,
        error: `${options.mode === 'plan' ? 'Plan' : 'Chat'} mode is read-only: ${call.name} cannot modify the project. Describe the change instead.`,
        errorType: 'PERMISSION_ERROR'
      };
      this.emit({ type: 'tool_result', sessionId: options.sessionId, callId: call.id, result });
      return { result, pause: false, finish: false };
    }

    const result = await this.deps.tools.execute(
      call,
      {
        workspaceRoot: options.workspaceRoot,
        projectId: options.projectId,
        sessionId: options.sessionId,
        shell: options.shell,
        processManager: this.deps.processes,
        signal,
        onFileTouched: (rel, kind) => {
          if (kind === 'created') rt.filesCreated.add(rel);
          else if (kind === 'modified') rt.filesModified.add(rel);
          else rt.filesDeleted.add(rel);
        }
      },
      this.deps.permissions
    );

    if (result.success && definition && ['terminal', 'testing', 'process'].includes(definition.category)) {
      rt.ranSomething = true;
    }

    this.emit({ type: 'tool_result', sessionId: options.sessionId, callId: call.id, result });
    this.timeline(options.sessionId, `${call.name}: ${result.summary ?? (result.success ? 'ok' : result.error ?? 'failed')}`);
    this.emitState(options.sessionId, 'EXECUTING', 'Working');
    return { result, pause: false, finish: false };
  }

  private async handleMetaTool(
    call: ToolCall,
    options: AgentRunOptions,
    rt: SessionRuntime,
    signal: AbortSignal,
    maxRepairAttempts: number
  ): Promise<{ result: ToolResult; pause: boolean; finish: boolean }> {
    const args = call.arguments;
    const sessionId = options.sessionId;

    switch (call.name) {
      case 'record_requirements': {
        const analysis: RequirementAnalysis = {
          summary: String(args.summary ?? ''),
          // Models name these fields after the specification they were given
          // rather than after our schema, so both spellings are accepted.
          // Dropping a requirement because it said "description" left the
          // analysis panel blank.
          requirements: (args.requirements as any[] ?? []).map((r) => ({
            id: uid('req'),
            kind: r.kind ?? r.type ?? 'implicit',
            topic: r.topic ?? r.category ?? 'general',
            statement: String(r.statement ?? r.description ?? r.requirement ?? r.text ?? ''),
            confidence: typeof r.confidence === 'number' ? r.confidence : 0.6,
            importance: r.importance ?? r.priority ?? 'medium'
          })),
          questions: [],
          assumptions: (args.assumptions as string[]) ?? []
        };
        this.emit({ type: 'requirements', sessionId, analysis });
        this.timeline(sessionId, 'Requirements analysed');
        return { result: { success: true, tool: call.name, callId: call.id, summary: 'Requirement analysis recorded.' }, pause: false, finish: false };
      }

      case 'ask_user': {
        const questions: AgentQuestion[] = ((args.questions as any[]) ?? []).slice(0, 4).map((q) => ({
          id: uid('q'),
          topic: q.topic ?? 'decision',
          question: String(q.question ?? ''),
          priority: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(q.priority) ? q.priority : 'HIGH',
          options: ((q.options as any[]) ?? []).map((o, i) => ({
            id: String(o.id ?? `opt_${i}`),
            label: String(o.label ?? o.id ?? `Option ${i + 1}`),
            description: o.description ? String(o.description) : undefined
          })),
          recommendedOptionId: q.recommended_option_id ? String(q.recommended_option_id) : undefined,
          recommendationReason: q.recommendation_reason ? String(q.recommendation_reason) : undefined
        }));
        if (!questions.length) {
          return { result: { success: false, tool: call.name, callId: call.id, error: 'No questions provided.' }, pause: false, finish: false };
        }
        this.emit({ type: 'question', sessionId, questions });
        this.emitState(sessionId, 'WAITING_FOR_USER', 'Waiting for the user to answer questions');
        this.timeline(sessionId, `Asked ${questions.length} question(s)`);
        return { result: { success: true, tool: call.name, callId: call.id, summary: 'Questions delivered; waiting for the user.' }, pause: true, finish: false };
      }

      case 'present_plan': {
        const plan: Plan = {
          id: uid('plan'),
          title: String(args.title ?? 'Implementation plan'),
          technology: (args.technology as string[]) ?? [],
          steps: ((args.steps as any[]) ?? []).map((s, i) => ({
            id: uid('pstep'),
            title: String(s.title ?? s.description ?? `Step ${i + 1}`),
            detail: s.detail ? String(s.detail) : undefined
          })),
          estimatedFiles: typeof args.estimated_files === 'number' ? args.estimated_files : undefined,
          includesTests: args.includes_tests !== false,
          requiresApproval: options.mode === 'plan' ? false : options.requirePlanApproval ?? true,
          notes: args.notes ? String(args.notes) : undefined
        };
        rt.pendingPlan = plan;
        this.emit({ type: 'plan', sessionId, plan });
        this.timeline(sessionId, `Plan created: ${plan.steps.length} steps`);

        if (options.mode === 'plan') {
          this.emitState(sessionId, 'COMPLETED', 'Plan ready (plan mode makes no changes)');
          return { result: { success: true, tool: call.name, callId: call.id, summary: 'Plan presented. Plan mode makes no changes.' }, pause: true, finish: true };
        }
        if (plan.requiresApproval) {
          this.emitState(sessionId, 'WAITING_FOR_APPROVAL', 'Waiting for plan approval');
          return { result: { success: true, tool: call.name, callId: call.id, summary: 'Plan presented; waiting for approval.' }, pause: true, finish: false };
        }
        this.emitState(sessionId, 'EXECUTING', 'Executing the plan');
        return { result: { success: true, tool: call.name, callId: call.id, summary: 'Plan recorded; continue executing.' }, pause: false, finish: false };
      }

      case 'update_task': {
        const task = rt.tasks.apply({
          title: String(args.title ?? 'Task'),
          goal: args.goal ? String(args.goal) : undefined,
          status: args.status as any,
          steps: (args.steps as any[]) ?? []
        });
        this.deps.sessions.upsertTask(task);
        this.emit({ type: 'task_update', sessionId, task });
        return { result: { success: true, tool: call.name, callId: call.id, summary: `Task "${task.title}" updated (${rt.tasks.progress().percent}%).` }, pause: false, finish: false };
      }

      case 'create_checkpoint': {
        try {
          const checkpoint = await this.deps.checkpoints.create({
            projectId: options.projectId,
            sessionId,
            workspaceRoot: options.workspaceRoot,
            label: String(args.label ?? 'Checkpoint')
          });
          this.timeline(sessionId, `Checkpoint created: ${checkpoint.label}`);
          return {
            result: { success: true, tool: call.name, callId: call.id, summary: `Checkpoint ${checkpoint.id} created (${checkpoint.fileCount} files).`, data: checkpoint },
            pause: false,
            finish: false
          };
        } catch (err) {
          return { result: { success: false, tool: call.name, callId: call.id, error: (err as Error).message }, pause: false, finish: false };
        }
      }

      case 'remember': {
        const memory = this.deps.sessions.addMemoryFact(options.projectId, String(args.kind), String(args.value), args.rationale ? String(args.rationale) : undefined);
        return { result: { success: true, tool: call.name, callId: call.id, summary: `Remembered (${args.kind}).`, data: { decisions: memory.decisions.length } }, pause: false, finish: false };
      }

      case 'verify_work': {
        this.emitState(sessionId, 'VERIFYING', 'Running verification');
        const report = await this.deps.verification.run({
          workspaceRoot: options.workspaceRoot,
          shell: options.shell,
          levels: (args.levels as any) ?? undefined,
          signal
        });
        rt.lastReport = report;
        rt.verified = report.passed;
        this.emit({ type: 'verification', sessionId, report });
        const summary = summarizeReport(report);
        this.timeline(sessionId, report.passed ? 'Verification passed' : 'Verification failed');

        if (report.passed) {
          rt.repairAttempts = 0;
          this.emitState(sessionId, 'EXECUTING', 'Verification passed');
          return { result: { success: true, tool: call.name, callId: call.id, summary: 'All executed verification checks passed.', stdout: summary, data: report }, pause: false, finish: false };
        }

        const signature = report.checks
          .filter((c) => c.outcome === 'failed')
          .map((c) => `${c.command}:${c.errorType}`)
          .join('|');
        if (signature && signature === rt.lastFailureSignature) rt.repairAttempts += 1;
        else {
          rt.lastFailureSignature = signature;
          rt.repairAttempts = 1;
        }

        if (rt.repairAttempts > maxRepairAttempts) {
          this.emitState(sessionId, 'BLOCKED', 'Automatic repair limit reached');
          this.emit({
            type: 'assistant_message',
            sessionId,
            content: `Automatic repair limit reached (${maxRepairAttempts} attempts on the same failure).\n\nThe remaining problem appears to need a decision:\n\n\`\`\`\n${summary.slice(0, 2000)}\n\`\`\`\n\nTell me how you want to proceed (analyse again, change approach, or stop).`,
            final: true
          });
          return {
            result: { success: false, tool: call.name, callId: call.id, error: 'Repair limit reached. Stop and ask the user.', stdout: summary, errorType: 'ARCHITECTURE_ERROR' },
            pause: true,
            finish: false
          };
        }

        this.emitState(sessionId, 'REPAIRING', `Repair attempt ${rt.repairAttempts}/${maxRepairAttempts}`);
        const hints = [...new Set(report.checks.filter((c) => c.outcome === 'failed' && c.errorType).map((c) => repairHint(c.errorType!)))];
        return {
          result: {
            success: false,
            tool: call.name,
            callId: call.id,
            error: `Verification failed (repair attempt ${rt.repairAttempts}/${maxRepairAttempts}). Inspect the real cause and fix it, then verify again.`,
            stdout: `${summary}\n\nREPAIR GUIDANCE\n${hints.map((h) => `- ${h}`).join('\n')}`,
            data: report
          },
          pause: false,
          finish: false
        };
      }

      case 'finish': {
        const claimedVerified = args.verified === true;
        const actuallyVerified = rt.verified && rt.lastReport?.passed === true;
        const success = args.success !== false;
        let report = String(args.report ?? '');

        // Nothing was written, deleted or executed, yet the model wants to
        // report a finished job. That is exactly the fake success this agent
        // exists to prevent, so the call is refused once and the model is told
        // to either do the work or admit that it did not.
        const touchedNothing =
          rt.filesCreated.size === 0 && rt.filesModified.size === 0 && rt.filesDeleted.size === 0 && !rt.ranSomething;
        const executing = options.mode === 'agent' || options.mode === 'auto';
        if (success && touchedNothing && executing && rt.emptyFinishes === 0) {
          rt.emptyFinishes += 1;
          this.timeline(sessionId, 'Model reported success without doing anything; refused');
          const refusal: ToolResult = {
            success: false,
            tool: call.name,
            callId: call.id,
            error:
              'You cannot finish yet: this session has not created, modified or deleted a single file and has ' +
              'not run a single command, so there is nothing to report as done. Planning and recording ' +
              'requirements are not the work. Start building now, one tool call per message: create the ' +
              'directory layout, then write the files with `write_file` and `append_file`. If the task really ' +
              'needs no changes, call `finish` again with success=false and say plainly what is missing.',
            errorType: 'UNKNOWN_ERROR'
          };
          return { result: refusal, pause: false, finish: false };
        }
        if (touchedNothing) {
          report +=
            '\n\n---\n**Notice from Nexus Code:** no file was created, modified or deleted and no command was run ' +
            'in this session. Nothing on disk has changed.';
        }

        if (claimedVerified && !actuallyVerified) {
          report +=
            '\n\n---\n**Verification notice from Nexus Code:** the agent reported verified results, but no passing verification run was recorded in this session. Treat the results above as *unverified*.';
        }
        const stats = `\n\n---\nFiles created: ${rt.filesCreated.size} · modified: ${rt.filesModified.size} · deleted: ${rt.filesDeleted.size}`;
        const verificationBlock = rt.lastReport
          ? `\n\nVerification:\n\`\`\`\n${summarizeReport(rt.lastReport).slice(0, 3000)}\n\`\`\``
          : '\n\nVerification: no verification command was executed in this session.';

        this.emit({ type: 'completion', sessionId, report: report + stats + verificationBlock, verified: actuallyVerified });
        this.emitState(sessionId, success ? 'COMPLETED' : 'FAILED', success ? 'Task completed' : 'Task failed');
        this.timeline(sessionId, success ? 'Completed' : 'Failed');
        for (const task of rt.tasks.list()) {
          const updated = rt.tasks.setStatus(task.id, success ? 'completed' : 'failed');
          if (updated) {
            this.deps.sessions.upsertTask(updated);
            this.emit({ type: 'task_update', sessionId, task: updated });
          }
        }
        return { result: { success: true, tool: call.name, callId: call.id, summary: 'Final report delivered.' }, pause: true, finish: true };
      }

      default:
        return { result: { success: false, tool: call.name, callId: call.id, error: `Unhandled meta tool ${call.name}.` }, pause: false, finish: false };
    }
  }

  /* --------------------------------------------------------- user replies */

  /** Resume after questions, plan approval or a repair-limit stop. */
  async continueWith(options: AgentRunOptions): Promise<void> {
    const rt = this.runtime(options);
    if (rt.history.length === 0) return this.run(options);

    const abort = new AbortController();
    rt.abort = abort;
    rt.running = true;
    rt.history.push({ role: 'user', content: options.userMessage });
    this.deps.sessions.appendMessage({ sessionId: options.sessionId, role: 'user', content: options.userMessage });
    rt.running = false;
    return this.resumeLoop(options, rt);
  }

  private async resumeLoop(options: AgentRunOptions, rt: SessionRuntime): Promise<void> {
    // Re-enter the main loop without re-building the first-turn context.
    const abort = new AbortController();
    rt.abort = abort;
    rt.running = true;
    this.emitState(options.sessionId, 'EXECUTING', 'Continuing');
    const maxIterations = options.maxIterations ?? 40;
    const maxRepairAttempts = options.maxRepairAttempts ?? 5;
    let emptyResponses = 0;
    let proseOnlyReplies = 0;
    let invented = 0;
    let cutOff = 0;
    let malformedReplies = 0;
    try {
      for (let i = 0; i < maxIterations; i++) {
        if (abort.signal.aborted) break;
        const response = await this.callModel(options, rt, abort.signal);
        const content = response.content.trim();
        if (content) {
          this.emit({ type: 'assistant_message', sessionId: options.sessionId, content, final: response.toolCalls.length === 0 });
          this.deps.sessions.appendMessage({ sessionId: options.sessionId, role: 'assistant', content });
        }
        rt.history.push({ role: 'assistant', content, toolCalls: response.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })) });
        if (response.toolCalls.length === 0) {
          this.emitState(options.sessionId, 'COMPLETED', 'Response delivered');
          break;
        }
        let pause = false;
        let finished = false;
        for (const raw of response.toolCalls) {
          if (abort.signal.aborted) break;
          const call: ToolCall = { id: raw.id, name: raw.name, arguments: safeParseArgs(raw.arguments) };
          const outcome = await this.dispatch(call, options, rt, abort.signal, maxRepairAttempts);
          rt.history.push({ role: 'tool', name: call.name, toolCallId: call.id, content: this.deps.context.truncateToolResult(renderToolResult(outcome.result)) });
          this.persistAction(options.sessionId, call, outcome.result);
          if (outcome.pause) pause = true;
          if (outcome.finish) finished = true;
        }
        if (pause || finished) break;
      }
      if (abort.signal.aborted) this.emitState(options.sessionId, 'STOPPED', 'Stopped by the user.');
    } catch (err) {
      const message = err instanceof AIProviderError ? err.message : (err as Error).message;
      this.emit({ type: 'error', sessionId: options.sessionId, message });
      this.emitState(options.sessionId, 'FAILED', message);
    } finally {
      rt.running = false;
      rt.abort = undefined;
    }
  }

  /** Injects an instruction while the agent is working (live task modification). */
  injectInstruction(sessionId: string, instruction: string): boolean {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return false;
    rt.history.push({
      role: 'user',
      content: `USER INTERRUPTION (apply from now on, reconcile with the current state): ${instruction}`
    });
    this.timeline(sessionId, 'User updated the instructions mid-task');
    return true;
  }
}

/* ------------------------------------------------------------- utilities */

export function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    // Tolerate common model mistakes: trailing commas, single quotes, markdown fences.
    const cleaned = raw
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return { __malformed__: raw.slice(0, 500) };
    }
  }
}

export function renderToolResult(result: ToolResult): string {
  const parts: string[] = [`tool=${result.tool}`, `success=${result.success}`];
  if (result.exitCode !== undefined) parts.push(`exit_code=${result.exitCode}`);
  if (result.errorType) parts.push(`error_type=${result.errorType}`);
  if (result.summary) parts.push(`summary=${result.summary}`);
  if (result.error) parts.push(`error=${result.error}`);
  const body: string[] = [];
  if (result.stdout) body.push(wrapUntrusted(`${result.tool}:stdout`, result.stdout));
  if (result.stderr) body.push(wrapUntrusted(`${result.tool}:stderr`, result.stderr));
  if (result.data !== undefined && !result.stdout) {
    try {
      body.push(wrapUntrusted(`${result.tool}:data`, JSON.stringify(result.data).slice(0, 12_000)));
    } catch {
      /* non-serialisable */
    }
  }
  return redactSecrets([parts.join(' '), ...body].join('\n'));
}

function formatEnvironment(env: Awaited<ReturnType<typeof detectEnvironment>>): string {
  const tools = Object.entries(env.tools)
    .map(([name, version]) => `${name}: ${version ?? 'not installed'}`)
    .join('\n');
  return [
    `platform: ${env.platform} (${env.arch}, ${env.cpus} cpus, ${env.memoryGb} GB RAM)`,
    env.virtualEnvs.length ? `detected environments: ${env.virtualEnvs.join(', ')}` : 'detected environments: none',
    'installed tools:',
    tools
  ].join('\n');
}
