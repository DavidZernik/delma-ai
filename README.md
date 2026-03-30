# Delma

**A multi-agent AI system modeled on how high-performing human organizations actually work.**

## Thesis

AI agents produce better outputs when they operate like a high-functioning small team — not because of specialization, but because of organizational design.

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

## The Team

- **Delma** — Coordinator. Scopes the request, sets the execution plan, routes to the right lead, owns the outcome.
- **Sarah** — Architect. Designs structure and leads judgment-heavy tasks. Forms the strategic opinion before Marcus produces.
- **Marcus** — Producer. Writes sections, assembles the document, revises based on feedback.
- **James** — Validator. Independent check. No stake in defending Marcus's work. Rejects on real quality failures, not noise.

## How It Works

Every request runs the same coordination pattern:

1. Delma decomposes the request and routes it
2. Sarah or Marcus leads based on whether the task needs judgment or production
3. The team runs in parallel — Marcus writes sections, Sarah improves, James validates per section
4. Marcus assembles a coherent document
5. James runs a final release check
6. Delma delivers

The 3D office makes the coordination visible. You can watch who is working, who is waiting, and what is being handed off.

## Why This Beats a Single Call

A single large model call tries to scope, produce, and validate simultaneously. It can't give independent validation because the same weights that produced the answer are checking it. It has no memory of prior handoff patterns. It optimizes for a plausible-sounding answer, not a correct one.

Delma separates these concerns. James doesn't know what Marcus wrote until he receives it. Sarah's architectural judgment is formed before Marcus starts writing. Delma's final check compares the output against the original intent without having produced it.

That separation is the product.
