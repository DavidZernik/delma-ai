# Delma

**A multi-agent AI system built on organizational theory, not prompt engineering.**

## Thesis

AI agents produce better outputs when they operate like a high-functioning small team — not because of specialization, but because of organizational design.

Ethan Mollick put it well: ["agentic AI would work much better if people took lessons from organizational theory, which has actually spent a lot of time understanding how to deal with complex hierarchies, information limits, and spans of control."](https://x.com/emollick/status/2020303173362012667) Most agentic systems ignore this entirely. Delma is an attempt to take it seriously.

The hypothesis: role discipline, ownership culture, opinion-first hierarchy, and independent QA authority are the variables that determine output quality. Not the number of agents. Not parallelism. The structure of how the team works.

**What this means concretely:**

A coordinator who owns the outcome and never abdicates — Delma doesn't write, doesn't fact-check, but she sets the plan, validates the structure, and delivers. That's not a prompt trick. That's what a good project lead does.

An architect who takes positions — Sarah is banned from hedging. She has to form an opinion and structure the work around it. Committees hedge. Senior people with accountability don't.

A producer with lane discipline — Marcus doesn't form strategic opinions when Sarah leads. He supports her argument with specifics. The failure mode in real teams is everyone having opinions about everything; the prompt enforces against it.

A validator with real authority — James can block delivery. One retry, then it ships with his concerns noted. He's not advisory. Real QA that can't block isn't QA.

**The deeper claim:**

The same four LLM calls, given the same prompts, running flat in parallel with no hierarchy — would produce worse output. Not because of capability, but because organizational structure is itself a form of intelligence. How a team is arranged, who can say no to whom, who briefs whom and in what order — that encodes domain knowledge about how good work actually gets done.

**What we're actually testing:**

Not "does more compute produce better output." That's boring.

The question is: does organizational design — borrowed from how small high-performing human teams actually work — transfer meaningfully to AI agent systems? And if yes, which parts carry the most weight: ownership, role discipline, opinion-first culture, independent QA?

That's the experiment.

## Organizational Design Choices

Mollick identifies three under-studied problems in agentic AI. Delma addresses all three directly:

**Spans of control.** A human manager tops out at fewer than 10 direct reports. Delma has four. The coordinator never writes — she only coordinates. The team is small enough that every handoff is intentional and every role is accountable.

**Boundary objects.** When agents pass raw text back and forth, meaning degrades. Delma uses structured handoffs: Delma briefs Sarah with a scoping summary, Sarah passes a structured architecture to Marcus, Marcus delivers a versioned document to James, James returns a structured quality assessment. Each boundary object is readable by the next agent in the chain without requiring the full prior context.

**Coupling.** Most agentic systems are either too tightly coupled (every step needs approval, bottlenecked on orchestrator) or too loosely coupled (agents run in parallel with no shared context). Delma uses moderate coupling by design: sequential phases where judgment is needed (scoping, architecture, final check), parallel execution where production scales (section writing, per-section validation). The coupling loosens and tightens based on what the task actually requires.

## Fixed Structure, Adaptive Execution

The org chart doesn't change per request. James always validates. Delma always owns the outcome. Those are guardrails — the structure that makes the system trustworthy.

What adapts is the sequence Delma assembles based on what the task actually needs. Delma reads the request and composes a pipeline from the team. Three sequences exist today:

**Direct** — Simple production where the structure is obvious. Delma scopes it, Marcus writes the sections, James validates. Sarah doesn't enter. No coordination overhead when none is needed.
> Delma → Marcus → James → Delma delivers

**Strategic** — Tasks that need a judgment call before production starts. Sarah reads the full request, forms an opinion, and briefs Marcus on what to argue. Marcus supports her thesis; he doesn't form his own.
> Delma → Sarah leads → Marcus + James in parallel → Delma delivers

**Full** — Complex production where structure is genuinely ambiguous. Sarah designs the architecture before Marcus writes a word. Delma checks that Sarah's structure maps to what the user asked. Then Marcus writes, Sarah improves, and James validates — all per section, in parallel.
> Delma → Sarah architects → (Delma validates) → Marcus + Sarah + James in parallel → Delma validates → James final → Delma delivers

Two overlays apply to any sequence:
- Web search runs after Delma's scoping when the task needs current data
- If James rejects, Marcus revises and James re-checks — once, then it ships with concerns noted

This is how real organizations work. The hierarchy is stable. Which team members touch a given project, and in what order, is a decision made in context — not a schedule set in advance.

## The Team

- **Delma** — Coordinator. Scopes the request, sets the execution plan, routes to the right lead, owns the outcome.
- **Sarah** — Architect. Designs structure and leads judgment-heavy tasks. Forms the strategic opinion before Marcus produces.
- **Marcus** — Producer. Writes sections, assembles the document, revises based on feedback.
- **James** — Validator. Independent check. No stake in defending Marcus's work. Rejects on real quality failures, not noise.

## How It Works

Delma reads the request and decides which sequence the team runs:

1. Delma decomposes the request, sets the word budget, picks the sequence, and assigns models per agent
2. If the task needs current data, web search runs before anyone else starts
3. Sarah or Marcus leads depending on the sequence — or Sarah skips entirely on direct tasks
4. The team runs in parallel where it can — Marcus writes sections, Sarah improves (where involved), James validates per section
5. Marcus assembles the sections into one coherent document
6. James runs a final release check; if he rejects, Marcus revises and James re-checks once
7. Delma delivers

The 3D office makes the coordination visible. You can watch who is working, who is waiting, and what is being handed off.

## Why This Beats a Single Call

A single large model call tries to scope, produce, and validate simultaneously. It can't give independent validation because the same weights that produced the answer are checking it. It has no memory of prior handoff patterns. It optimizes for a plausible-sounding answer, not a correct one.

Delma separates these concerns. James doesn't know what Marcus wrote until he receives it. Sarah's architectural judgment is formed before Marcus starts writing. Delma's final check compares the output against the original intent without having produced it.

That separation is the product.
