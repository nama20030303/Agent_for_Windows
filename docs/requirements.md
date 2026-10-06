# Requirement analyst

Two layers cooperate.

## 1. Deterministic pre-analysis (application)

`src/core/agent/requirementAnalyzer.ts` runs locally before the model is called. It classifies
requirements as **explicit / implicit / missing / optional / conflicting**, each with a confidence
score (0–1) and an importance level, using topic rules for persistence, authentication, payments,
file storage, frontend, deployment and testing.

It also:

- marks a decision **answered** when the project index already shows it (e.g. SQLAlchemy present → the
  database question is not asked);
- detects **conflicts** with the existing project (e.g. "use React" in a Vue project, "use PostgreSQL"
  where a SQLite file already exists);
- turns only CRITICAL/HIGH gaps into questions (maximum four, always bundled);
- converts MEDIUM/LOW gaps into **assumed defaults** listed to the user instead of questions.

The result is shown in the UI and injected into the prompt, so the model starts from a concrete,
inspectable analysis rather than from scratch.

## 2. Model judgement

The model records its own analysis with `record_requirements` and asks with `ask_user`. Each question
must contain 2–4 options, a recommendation and the reason for it. The UI pre-selects the
recommendation and offers **Use recommended defaults** as a one-click answer.

## Rules

- Never ask about something the project already answers.
- Never ask about low-impact details — choose a professional default and state it.
- Never ask one question at a time when several are known.
- Low confidence + high importance ⇒ ask. Otherwise ⇒ decide and document.
