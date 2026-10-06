import { defineTool, ok, schema, str, bool, type Tool } from './types.js';

/**
 * Meta tools are intercepted by the AgentController: they do not touch the
 * operating system, they drive the agent protocol (questions, plans, tasks,
 * completion). They are declared here so the model sees one consistent
 * tool interface and so their arguments are schema-validated like any other tool.
 */

export const askUser = defineTool(
  {
    name: 'ask_user',
    description:
      'Ask the user a bundled set of high-impact questions when critical requirements are missing. Each question must include options and a recommendation. Ask once, bundled — never one question at a time.',
    category: 'meta',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        questions: {
          type: 'array',
          description:
            'Array of {topic, question, priority (CRITICAL|HIGH|MEDIUM|LOW), options:[{id,label,description}], recommended_option_id, recommendation_reason}.',
          items: { type: 'object' }
        }
      },
      ['questions']
    )
  },
  async () => ok('ask_user', { summary: 'Questions sent to the user.' }),
  () => 'Ask the user for missing requirements'
);

export const recordRequirements = defineTool(
  {
    name: 'record_requirements',
    description: 'Record the requirement analysis: explicit, implicit, missing, optional and conflicting requirements with confidence.',
    category: 'meta',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        summary: str('One-paragraph restatement of what the user wants.'),
        requirements: {
          type: 'array',
          description: 'Array of {kind (explicit|implicit|missing|optional|conflicting), topic, statement, confidence (0..1), importance (critical|high|medium|low)}.',
          items: { type: 'object' }
        },
        assumptions: { type: 'array', description: 'Defaults chosen without asking.', items: { type: 'string' } }
      },
      ['summary', 'requirements']
    )
  },
  async () => ok('record_requirements', { summary: 'Requirement analysis recorded.' }),
  () => 'Record requirement analysis'
);

export const presentPlan = defineTool(
  {
    name: 'present_plan',
    description: 'Present the implementation plan. In Plan mode, or when approval is required, execution pauses until the user approves.',
    category: 'meta',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        title: str('Plan title.'),
        technology: { type: 'array', description: 'Technology stack.', items: { type: 'string' } },
        steps: { type: 'array', description: 'Array of {title, detail}.', items: { type: 'object' } },
        estimated_files: { type: 'number', description: 'Estimated number of files touched.' },
        includes_tests: bool('Whether the plan includes automated tests.'),
        notes: str('Risks, trade-offs or constraints.')
      },
      ['title', 'steps']
    )
  },
  async () => ok('present_plan', { summary: 'Plan presented.' }),
  (a) => `Present plan: ${a.title}`
);

export const updateTask = defineTool(
  {
    name: 'update_task',
    description: 'Create or update the task breakdown and mark step progress so the user can follow along.',
    category: 'meta',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        title: str('Task title.'),
        goal: str('Task goal.'),
        status: { type: 'string', enum: ['pending', 'planning', 'awaiting_user', 'executing', 'verifying', 'repairing', 'completed', 'failed', 'stopped'], description: 'Task status.' },
        steps: { type: 'array', description: 'Array of {id?, description, status (pending|in_progress|completed|failed|skipped), detail?}.', items: { type: 'object' } }
      },
      ['title', 'steps']
    )
  },
  async () => ok('update_task', { summary: 'Task updated.' }),
  (a) => `Update task: ${a.title}`
);

export const verifyWork = defineTool(
  {
    name: 'verify_work',
    description:
      'Run the verification ladder (syntax, static analysis, build, tests) using the real project commands and return the real results.',
    category: 'meta',
    risk: 'LOW',
    mutating: true,
    parameters: schema({
      levels: { type: 'array', description: 'Subset of syntax|static|build|tests. Default: all available.', items: { type: 'string' } }
    })
  },
  async () => ok('verify_work', { summary: 'Verification requested.' }),
  () => 'Run verification'
);

export const createCheckpoint = defineTool(
  {
    name: 'create_checkpoint',
    description: 'Create a restore point of the workspace before a destructive or large change.',
    category: 'meta',
    risk: 'LOW',
    mutating: false,
    parameters: schema({ label: str('What this checkpoint protects against.') }, ['label'])
  },
  async () => ok('create_checkpoint', { summary: 'Checkpoint requested.' }),
  (a) => `Create checkpoint: ${a.label}`
);

export const rememberProjectFact = defineTool(
  {
    name: 'remember',
    description: 'Persist a durable project fact: architecture decision, constraint, user preference or known problem.',
    category: 'meta',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        kind: { type: 'string', enum: ['decision', 'preference', 'constraint', 'known_problem', 'important_file', 'stack', 'goal', 'architecture'], description: 'Memory category.' },
        value: str('The fact to remember.'),
        rationale: str('Why.')
      },
      ['kind', 'value']
    )
  },
  async () => ok('remember', { summary: 'Memory stored.' }),
  (a) => `Remember (${a.kind}): ${a.value}`
);

export const finishTask = defineTool(
  {
    name: 'finish',
    description:
      'End the task with a final report. Only claim something works if a tool actually verified it; list everything that could not be verified and why.',
    category: 'meta',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        report: str('Final report in Markdown: what was done, files created/modified, verified results, unverified items, next steps.'),
        verified: bool('True only if build/tests/runtime checks actually ran and passed.'),
        success: bool('Whether the request was fulfilled.')
      },
      ['report', 'verified', 'success']
    )
  },
  async () => ok('finish', { summary: 'Task finished.' }),
  () => 'Finish and report'
);

export const metaTools: Tool[] = [
  askUser,
  recordRequirements,
  presentPlan,
  updateTask,
  verifyWork,
  createCheckpoint,
  rememberProjectFact,
  finishTask
];

export const META_TOOL_NAMES = new Set(metaTools.map((t) => t.definition.name));
