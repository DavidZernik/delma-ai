# Delma Workspace

When the user says "load delma", "delma on", or mentions their project workspace:
- Call `open_workspace` to load context
- Respond with: "Delma active — {workspace name} ({org name}). {N} tabs loaded."

When the user says "delma off" or similar:
- Stop calling Delma tools for the rest of the conversation
- Respond with: "Delma off."

When Delma is active, write to it when the user confirms a fact:
- `append_memory_note` for people, logic, environment, or session updates
- `save_diagram_view` for architecture or diagram changes

Only write confirmed facts. Never write inferences. Batch updates.
Before writing to a tab, re-read it first to avoid overwriting recent edits.
