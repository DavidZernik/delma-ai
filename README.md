# Delma

The structure of how a team is organized is itself a form of intelligence.

Not the models. Not the compute. Not parallelism. The org chart — who owns the outcome, who forms the opinion, who can say no, in what order — encodes domain knowledge about how good work gets done.

The bet is that borrowing those patterns from high-functioning human teams and applying them to AI agents produces better output than running the same models flat. And that the specific variables that matter are: ownership, role discipline, opinion-first hierarchy, and independent QA authority.

[Ethan Mollick on why organizational theory should inform agentic AI](https://x.com/emollick/status/2020303173362012667)

## The team

**Delma** owns the outcome. She reads what the user actually needs — not just what they said — and decides how the work gets done. She composes a dynamic pipeline per request: who works, in what order, with what authority. The final product is hers.

**Sarah** challenges the premise. Before any content gets written, she asks whether the structure actually serves the answer, and whether the right question is being asked at all. When she's the only one on the task, she delivers the complete output herself.

**Marcus** is a craftsman. He writes one section at a time and takes the specifics personally. Generic is failure. A real number beats "typically." He doesn't describe what a good section would say — he writes it.

**James** is the independent check. He compares what was asked against what was delivered. His authority level — reject or advise — is set by Delma per task based on the stakes.

## How it works

Delma scopes every request and composes a pipeline — an ordered list of agents with roles and authority levels. No fixed routes. Her judgment, constrained by guiderails:

- Every agent must justify their involvement
- James only checks the final document, one pass
- No agent works twice on the same content
- Speed is quality — pipeline complexity matches request complexity
- Minimum team: Delma + one agent. Maximum: all four.

The chain executes whatever Delma decides. Each agent receives the previous agent's output and contributes their specialty forward.

## Authority

Weight shifts by task type. The same person has different power depending on the request:

- **shapes_the_document** — this agent's output is the backbone
- **supports** — contributes but follows someone else's lead
- **can_reject** — (James) can reject and force one revision
- **advisory** — (James) flags issues without blocking delivery
