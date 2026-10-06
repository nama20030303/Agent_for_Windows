import type { AgentQuestion, ProjectIndex, Requirement, RequirementAnalysis } from '../shared/types.js';
import { uid } from '../shared/ids.js';

/**
 * Deterministic pre-analysis that runs locally before the model is called.
 * It never replaces the model's judgement — it gives the model (and the UI) a
 * concrete, inspectable starting point: which architectural decisions are
 * typically required for this kind of request and which the project already answers.
 */

interface TopicRule {
  topic: string;
  triggers: RegExp;
  implies: string[];
  decision: {
    question: string;
    importance: 'critical' | 'high' | 'medium' | 'low';
    options: { id: string; label: string; description?: string }[];
    recommended: string;
    reason: string;
    /** If the project index already shows this, the decision is considered answered. */
    satisfiedBy?: (index: ProjectIndex | null) => boolean;
  };
}

const has = (index: ProjectIndex | null, ...names: string[]) =>
  !!index && names.some((n) => index.frameworks.includes(n) || index.packageManagers.includes(n));

const RULES: TopicRule[] = [
  {
    topic: 'persistence',
    triggers: /\b(store|database|db|persist|users?|products?|orders?|crud|marketplace|shop|inventory|blog|accounts?)\b/i,
    implies: ['data model', 'migrations'],
    decision: {
      question: 'Which database should the application use?',
      importance: 'critical',
      options: [
        { id: 'sqlite', label: 'SQLite', description: 'Zero-configuration local file database. Great for prototypes and single-node apps.' },
        { id: 'postgres', label: 'PostgreSQL', description: 'Production-grade relational database for concurrent multi-user workloads.' },
        { id: 'mysql', label: 'MySQL/MariaDB' }
      ],
      recommended: 'postgres',
      reason: 'Multi-user production workloads need concurrent writes, migrations and real constraints.',
      satisfiedBy: (i) => has(i, 'SQLAlchemy', 'Django') || !!i?.files.some((f) => /\.(db|sqlite3?)$/.test(f.path) || /alembic|migrations/.test(f.path))
    }
  },
  {
    topic: 'authentication',
    triggers: /\b(auth|login|sign ?in|sign ?up|users?|accounts?|session|jwt|oauth|permissions?|roles?)\b/i,
    implies: ['password hashing', 'session or token lifetime', 'authorization rules'],
    decision: {
      question: 'How should users authenticate?',
      importance: 'high',
      options: [
        { id: 'jwt', label: 'JWT access + refresh tokens', description: 'Stateless API authentication, works well for SPA/mobile clients.' },
        { id: 'session', label: 'Server-side sessions with cookies', description: 'Simpler to revoke, best for classic server-rendered apps.' },
        { id: 'oauth', label: 'External identity provider (OAuth/OIDC)' }
      ],
      recommended: 'jwt',
      reason: 'An API-first backend with separate frontend clients is best served by short-lived access tokens plus refresh tokens.'
    }
  },
  {
    topic: 'payments',
    triggers: /\b(payment|checkout|billing|subscription|stripe|paypal|marketplace|escrow)\b/i,
    implies: ['order lifecycle', 'refunds', 'webhooks'],
    decision: {
      question: 'Which payment provider should be integrated?',
      importance: 'critical',
      options: [
        { id: 'stripe', label: 'Stripe' },
        { id: 'paypal', label: 'PayPal' },
        { id: 'mock', label: 'Mock provider for now', description: 'Implement the domain model and a stub provider; integrate later.' }
      ],
      recommended: 'mock',
      reason: 'Real payment credentials are not available yet; a clean provider interface with a stub keeps the architecture correct and avoids blocking.'
    }
  },
  {
    topic: 'file storage',
    triggers: /\b(image|photo|upload|avatar|attachment|media|file storage)\b/i,
    implies: ['upload limits', 'content validation'],
    decision: {
      question: 'Where should uploaded files be stored?',
      importance: 'high',
      options: [
        { id: 'local', label: 'Local filesystem' },
        { id: 's3', label: 'S3-compatible object storage' }
      ],
      recommended: 's3',
      reason: 'Object storage survives redeploys and scales horizontally; a local adapter can be kept for development.'
    }
  },
  {
    topic: 'frontend',
    triggers: /\b(frontend|ui|web ?app|dashboard|page|react|vue|spa|site)\b/i,
    implies: ['routing', 'API client'],
    decision: {
      question: 'What should the frontend be built with?',
      importance: 'high',
      options: [
        { id: 'react', label: 'React + TypeScript (Vite)' },
        { id: 'server', label: 'Server-rendered templates' },
        { id: 'none', label: 'API only for now' }
      ],
      recommended: 'react',
      reason: 'A typed SPA matches an API-first backend and is the most common stack for this kind of product.',
      satisfiedBy: (i) => has(i, 'React', 'Vue', 'Svelte', 'Next.js')
    }
  },
  {
    topic: 'deployment',
    triggers: /\b(deploy|production|docker|kubernetes|hosting|server|cloud)\b/i,
    implies: ['configuration management', 'secrets handling'],
    decision: {
      question: 'How will the application be deployed?',
      importance: 'medium',
      options: [
        { id: 'docker', label: 'Docker / docker-compose' },
        { id: 'manual', label: 'Run directly on the host' },
        { id: 'later', label: 'Decide later' }
      ],
      recommended: 'docker',
      reason: 'Containers make the runtime reproducible across machines.',
      satisfiedBy: (i) => has(i, 'Docker')
    }
  },
  {
    topic: 'testing',
    triggers: /\b(test|tests|pytest|jest|vitest|coverage|quality)\b/i,
    implies: ['test framework', 'CI'],
    decision: {
      question: 'How much automated testing is expected?',
      importance: 'medium',
      options: [
        { id: 'core', label: 'Tests for core logic and endpoints' },
        { id: 'full', label: 'Full unit + integration coverage' },
        { id: 'none', label: 'No tests for now' }
      ],
      recommended: 'core',
      reason: 'Covering the critical paths gives real verification without slowing delivery.'
    }
  }
];

export interface PreAnalysisOptions {
  request: string;
  index: ProjectIndex | null;
  /** Topics already decided (from project memory or earlier answers). */
  decided?: string[];
}

export function analyzeRequirements(options: PreAnalysisOptions): RequirementAnalysis {
  const { request, index } = options;
  const decided = new Set((options.decided ?? []).map((d) => d.toLowerCase()));
  const requirements: Requirement[] = [];
  const questions: AgentQuestion[] = [];
  const assumptions: string[] = [];

  const sentences = request
    .split(/[.;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, 12);
  for (const sentence of sentences) {
    requirements.push({
      id: uid('req'),
      kind: 'explicit',
      topic: 'request',
      statement: sentence,
      confidence: 0.95,
      importance: 'high'
    });
  }

  for (const rule of RULES) {
    if (!rule.triggers.test(request)) continue;
    const satisfied = decided.has(rule.topic) || rule.decision.satisfiedBy?.(index) === true;

    for (const implied of rule.implies) {
      requirements.push({
        id: uid('req'),
        kind: 'implicit',
        topic: rule.topic,
        statement: implied,
        confidence: 0.7,
        importance: 'medium'
      });
    }

    if (satisfied) {
      requirements.push({
        id: uid('req'),
        kind: 'implicit',
        topic: rule.topic,
        statement: `${rule.topic}: an existing solution was detected in the project and should be reused.`,
        confidence: 0.85,
        importance: rule.decision.importance
      });
      continue;
    }

    const confidence = rule.decision.importance === 'critical' ? 0.35 : 0.55;
    requirements.push({
      id: uid('req'),
      kind: 'missing',
      topic: rule.topic,
      statement: rule.decision.question,
      confidence,
      importance: rule.decision.importance
    });

    const priority = rule.decision.importance === 'critical' ? 'CRITICAL' : rule.decision.importance === 'high' ? 'HIGH' : rule.decision.importance === 'medium' ? 'MEDIUM' : 'LOW';
    if (priority === 'CRITICAL' || priority === 'HIGH') {
      questions.push({
        id: uid('q'),
        topic: rule.topic,
        question: rule.decision.question,
        priority,
        options: rule.decision.options,
        recommendedOptionId: rule.decision.recommended,
        recommendationReason: rule.decision.reason
      });
    } else {
      const option = rule.decision.options.find((o) => o.id === rule.decision.recommended);
      assumptions.push(`${rule.topic}: defaulting to ${option?.label ?? rule.decision.recommended} — ${rule.decision.reason}`);
    }
  }

  // Conflicting requirement detection against the existing project.
  if (index) {
    if (/\breact\b/i.test(request) && (index.frameworks.includes('Vue') || index.frameworks.includes('Svelte'))) {
      requirements.push({
        id: uid('req'),
        kind: 'conflicting',
        topic: 'frontend',
        statement: `The request mentions React but the project already uses ${index.frameworks.filter((f) => ['Vue', 'Svelte'].includes(f)).join('/')}.`,
        confidence: 0.9,
        importance: 'high'
      });
    }
    if (/\bpostgres/i.test(request) && index.files.some((f) => /\.sqlite3?$|\.db$/.test(f.path))) {
      requirements.push({
        id: uid('req'),
        kind: 'conflicting',
        topic: 'persistence',
        statement: 'The request asks for PostgreSQL but an SQLite database already exists in the project; migration impact must be considered.',
        confidence: 0.8,
        importance: 'high'
      });
    }
  }

  const summary = [
    `Request: ${request.slice(0, 400)}`,
    index
      ? `Project: ${index.fileCount} files, ${Object.keys(index.languages).join('/') || 'unknown languages'}${index.frameworks.length ? `, frameworks: ${index.frameworks.join(', ')}` : ''}.`
      : 'No project context available.',
    questions.length
      ? `${questions.length} architectural decision(s) are unresolved.`
      : 'No blocking architectural decisions were detected.'
  ].join(' ');

  return { summary, requirements, questions: questions.slice(0, 4), assumptions };
}

/** Average confidence per topic; used to decide whether to ask or to default. */
export function confidenceByTopic(analysis: RequirementAnalysis): Record<string, number> {
  const sums: Record<string, { total: number; n: number }> = {};
  for (const r of analysis.requirements) {
    sums[r.topic] ??= { total: 0, n: 0 };
    sums[r.topic].total += r.confidence;
    sums[r.topic].n += 1;
  }
  return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round((v.total / v.n) * 100) / 100]));
}
