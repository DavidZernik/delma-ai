# Delma Workspace

When the user says "load delma", "delma on", or mentions their project workspace:
- Call `open_workspace` to load context
- Respond with: "Delma active — {workspace name} ({org name}). {N} tabs loaded."

When the user says "delma off" or similar:
- Stop calling Delma tools for the rest of the conversation
- Respond with: "Delma off."

## Keeping Delma in sync

Call `sync_conversation_summary` regularly to keep the workspace up to date:
- After a decision is confirmed or a question is resolved
- When a new person, role, or system is mentioned
- After working out technical details (IDs, timing, configuration)
- When finishing a task or switching topics
- If you haven't synced in the last 5 exchanges and the conversation contains project-relevant facts

Pass a plain-English summary of what was discussed. Be specific — include names, IDs, roles, system details. The tool handles routing to the right tabs and patching.

Example:
```
sync_conversation_summary({
  summary: "Birthday campaign go-live approved. Seed list goes to stakeholders first. Wait step between emails is 48 hours. Using All_Patients_Opted_In as source DE. Keyona handling creative assets."
})
```

## Direct writes

For targeted updates, use the specific tools:
- `append_memory_note` for people, logic, environment, or session updates
- `save_diagram_view` for architecture or diagram changes

Only write confirmed facts. Never write inferences. Batch updates.
Before writing to a tab, re-read it first to avoid overwriting recent edits.

## Diagram guidelines

- Use `flowchart TD` (top-down) for flows longer than 5-6 nodes
- Use `flowchart LR` (left-right) only for short, wide diagrams
- Keep diagrams under 5-6 nodes wide to avoid horizontal scrolling
- Include key details in node labels (IDs, timing, status)
