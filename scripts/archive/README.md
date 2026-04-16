# Archived scripts

Historical one-shot scripts. Not part of the live system. Kept here for
reference. **Do not run unless you know what you're doing.**

| File | What it did | When |
|------|-------------|------|
| `upgrade-org-tabs.js` | One-time LLM upgrade of People + Playbook Mermaid blocks to the typed visual vocabulary. | Pre-structured-ops architecture. |
| `migrate-decisions.js` | Renamed `session-log.md` rows to `decisions.md`. | When the schema was rationalized. |
| `add-floating-labels.js` | One-shot Mermaid label upgrade for Architecture diagrams. | Visual refresh. |
| `test-router.js` | Old free-form router test runner. | Superseded by `scripts/eval-router.js`. |

The current eval harness lives at `scripts/eval-router.js`.
The current backfill (legacy markdown → structured JSON) lives at `scripts/backfill-structured.js`.
