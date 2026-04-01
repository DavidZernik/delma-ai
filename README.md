# Delma

A memory layer for the Claude Agent SDK, built on the thesis that organizational structure is itself a form of intelligence.

Delma watches your Claude Code sessions and extracts institutional knowledge — who owns what, how things connect, why decisions were made. A team of AI agents with distinct roles processes what they see, challenges what's worth remembering, and writes it into structured memory files. The next session starts smarter.

The bet: borrowing patterns from high-functioning human teams (ownership, role discipline, opinion-first hierarchy, independent QA) and applying them to knowledge extraction produces better institutional memory than a flat approach.

[Ethan Mollick on why organizational theory should inform agentic AI](https://x.com/emollick/status/2020303173362012667)

## How it works

You use Claude Code normally. Delma runs alongside it.

1. **You talk to Claude Code** in the Agent SDK panel — same experience as the CLI
2. **Delma watches the session** — a lightweight watcher scores every few messages for extractable knowledge
3. **When something matters**, the 3D office activates — Delma spots the knowledge, briefs the team, they extract it
4. **Memory files update** in `.delma/` — structured knowledge organized by specialist domain
5. **CLAUDE.md composes** automatically — the Agent SDK reads it on the next session start
6. **Next session is smarter** — Claude already knows your org structure, architecture decisions, team preferences

The comparison panel runs vanilla Claude (no memory) side-by-side, so you can see what memory provides.

## The team

**Delma** owns the outcome. She watches the session stream, decides what's worth extracting, and composes the team per task. She coordinates — she never executes.

**Sarah** challenges what's worth remembering. Not everything in a session matters. She decides what's structural vs incidental, flags contradictions with existing knowledge, and frames how things should be remembered. A memory system that captures everything is as useless as one that captures nothing.

**Marcus** writes the actual memory docs. Specific beats generic. He produces clean, structured markdown that's useful to a future session — not prose, not filler, just knowledge.

**James** validates captures against the actual transcript. No hallucinated additions. No distorted context. He can reject inaccurate captures (Marcus revises once) or advise (notes attached, no revision).

## The watcher

Delma scores every transcript batch (every ~5 messages) for extractable knowledge:

- **High score** — user explains WHY, discovery happens, person mentioned, decision made, error reveals architecture
- **Low score** — routine file reads, generic coding, repetitive tool calls

Only high-scoring batches trigger the full extraction pipeline. Most of the session, the 3D office is quiet.

## Memory structure

```
.delma/
  environment.md      — tech stack, dependencies, infrastructure (Sarah's domain)
  logic.md            — business logic, patterns, decisions (Marcus's domain)
  people.md           — team, roles, preferences, org context (James's domain)
  session-log.md      — timestamped extraction summaries
  CLAUDE.md           — composed from all files, copied to project root
```

Each specialist maintains their own domain. Delma composes them into a single CLAUDE.md that the Agent SDK reads natively.

## Authority

Weight shifts by extraction type:

- **shapes_the_document** — this agent's judgment dominates the capture
- **supports** — contributes but follows another's lead
- **can_reject** — (James) captures are inaccurate, Marcus revises once
- **advisory** — (James) flags issues without blocking

Simple observation (a name) → Marcus alone. Architectural insight → Sarah then Marcus. High-stakes contradiction → Sarah, Marcus, James.

## Running locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. Enter a project directory path, click Connect. Start a Claude Code session.

Requires `claude` CLI installed and `ANTHROPIC_API_KEY` in `.env`.

## Future: self-improving orchestration

Delma logs every session — what was planned, what was executed, what failed, what the user corrected. A retrospective layer analyzes patterns across sessions and recommends changes to how the team is composed.

The learnings are structural, not domain-specific: pipeline order, agent selection, authority levels, input routing, when to challenge vs. proceed. They don't make prompts longer — they change the orchestration logic itself. Every user makes the system better for every other user.

Learning happens at two levels:

- **Global orchestration** — structural patterns from all sessions improve how the team works: pipeline composition, agent authority, when to challenge vs. proceed. These benefit every user.
- **Per-instance context** — each company reviews their own sessions and provides feedback: business rules, preferences, constraints. These are scoped to their instance, fed to agents as input, and never leak into the core or other customers' experiences.

The bet extends: not only is the org chart a form of intelligence, it can optimize itself — universally and per-customer.
