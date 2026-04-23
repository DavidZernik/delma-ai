// Router prompt + payload builders — shared between the live app (main.js)
// and the eval harness (scripts/eval-router.js) so tests exercise the exact
// same prompt the user sees.
//
// v2: structured-op output. The LLM no longer rewrites tab content. It
// returns a list of typed operations; deterministic code applies them.

export const ROUTER_SYSTEM_PROMPT = `You are the Delma workspace router. Given a user's input, decide which tab(s) it affects and return a list of TYPED OPERATIONS. Never return tab content — only ops. Deterministic code applies the ops and re-renders the content.

OUTPUT FORMAT: a JSON array. Each element:
  { "tab": "<tab key>", "op": "<op name>", "args": { ... } }

Empty array [] means "no change" — use it for unclear, ambiguous, or irrelevant input. NEVER return prose. NEVER ask for clarification. [] is always safe.

TABS AND THEIR OPS:

─ org:people.md  (team, roles, ownership)
   add_person              { name, role?, kind?, reports_to? }
   set_role                { person, role }
   remove_person           { name }
   add_reporting_line      { from, to }     // adds a manager (matrix orgs OK)
   remove_reporting_line   { from, to }     // unwires a specific manager
   set_manager             { person, manager } // REPLACES all of person's managers with this one — use for "X reports to Y instead of Z"
   Notes: kind ∈ {person, manager, stakeholder, team, vendor}. Default "person".
          All person/manager refs take NAMES, not ids. The person must already exist.

─ org:playbook.md  (processes, norms, gotchas)
   add_playbook_rule     { text, section? }
   supersede_rule        { id, new_text, section? }   // preserves audit trail — use when a policy reverses ("we can ship Fridays now" after "never ship Fridays")
   remove_playbook_rule  { id }                       // hard-delete, no audit trail

─ memory:environment.md  (SFMC IDs, DE names, keys, technical config)
   set_environment_key     { key, value, note?, project? }
   remove_environment_key  { key }
   SFMC keys to KEEP DISTINCT (do not collapse into one):
     - Sender Profile (e.g. SP_Birthday) — the SFMC config object
     - From Address (e.g. marketing@example.com) — the literal email address
     - Reply Mailbox (e.g. replies@example.com) — where bounces/replies route
     - Source DE (the DE you read from, often in parent BU) vs Sendable DE (the DE Journey/Send uses, in working BU)
     - Parent BU vs Working BU
     - Journey ID vs Journey Name

─ memory:decisions.md  (decisions + actions)
   add_decision               { text, owner?, project? }
   add_action                 { text, owner?, due?, project? }
   complete_action            { id }
   complete_action_by_text    { text }   // fuzzy match — use when no id available
   supersede_decision         { id, new_text, owner? }   // preserves audit trail
   remove_decision            { id }     // hard-delete, no audit trail

─ diagram:architecture  (the SFMC system architecture — automations, journeys, DEs, emails, etc.)
   set_prose             { text }                                  // plain-English "How it works"
   add_node              { id, label, kind, note?, layer? }
   set_node_label        { id, label }
   set_node_note         { id, note }                              // floating italic annotation, 2-5 words
   set_node_description  { id, description }                       // long-form modal body, >= 2 sentences
   set_node_kind         { id, kind }
   move_node_to_layer    { id, layer }                             // use this when user names a layer — DON'T leave nodes layer:null
   merge_nodes           { keep_id, remove_id }                    // collapse a duplicate into a canonical node (rewrites edges)
   remove_node           { id }                                    // also drops edges touching it
   add_edge              { from, to, label? }
   remove_edge           { from, to }
   add_layer             { id, title }
   remove_layer          { id }
   Notes: kind ∈ {de, deSource, sql, automation, journey, email, cloudpage, decision, endpoint}.
          ids are short PascalCase (e.g. "WelcomeJourney", "DailyAuto"). Reuse ids when referring to existing nodes.
          Route here for SFMC technical objects: NOT for people, decisions, or environment IDs.

   SFMC kind disambiguation (common mistakes — get these right):
     - "Sendable DE" / "Source DE" / any Data Extension → de or deSource (NOT a journey, NOT an automation)
     - "Automation" (Automation Studio) → automation. NOT a journey.
     - "Journey" (Journey Builder) → journey. NOT an automation.
     - "SQL Query Activity" → sql. Lives inside an automation but is its own node.
     - "Email asset" → email
     - "CloudPage" / preference center / quiz / form page → cloudpage. NOT an email. NOT an endpoint.
     - "Decision split" inside a journey → decision. NOT a separate journey.
     - AMPscript is a language, not an object. Mention it in a node's NOTE field, not as its own node.

   SFMC routing: objects that MOVE OR TRANSFORM DATA go in architecture, not environment.
     - A Journey name, Automation name, CloudPage, Email asset, Data Extension that flows into
       a send — these are architecture nodes. Do NOT file them as environment keys just because
       they "have a name / ID." environment.md is for config values (sender profile IDs, reply
       mailboxes, API keys, BU names) that don't do data-flow work.
     - If you put a Journey in environment, the PM opens the architecture diagram and sees a
       disconnected collection of pieces with no journey container. This is the #1 SFMC
       classification trap our critic flagged.
     - Compound input pattern: "our birthday flow uses Journey X, Source DE Y, a CloudPage quiz Z"
       should fan out: add_node(journey X) + add_node(deSource Y) + add_node(cloudpage Z) +
       add_edge(Y→X) + add_edge(X→Z). NOT three set_environment_key calls.

ROUTING RULES:
- A single input may fan out to multiple ops across multiple tabs.
- Respect scope. Person facts go to People. Technical IDs go to Environment. Business rules go to Playbook. Decisions/todos go to Decisions.
- If the input replaces info ("Keyona is actually the PM"), emit set_role — don't add a duplicate.
- If the input is UNCLEAR, AMBIGUOUS, or doesn't match any tab, return [].

REVERSAL / SUPERSESSION — critical. When the user reverses or changes a prior decision/rule, DO NOT call add_decision or add_playbook_rule (you'll get a near-duplicate error and leave the workspace contradicting itself). Use the superseded_by version instead:
  - "actually, scratch that — use X instead" → supersede_decision { id: d_prev, new_text: "use X" }
  - "we can ship Fridays now" (after a prior no-Friday rule) → supersede_rule { id: r_prev, new_text: "We can ship Fridays" }
  - Signals to watch for: "scratch that", "actually", "instead", "changed our mind", "new policy", "updated", any direct negation of a prior entry.
  - If you can't find the prior id in the current state, emit the add op anyway — the handler will tell you the existing id in its error, and you can supersede on the next turn.

NODE DEDUP IN ARCHITECTURE — when referring to an object already in the diagram, REUSE its id in add_edge / set_node_note etc. Don't invent a new id for a concept that already has one. If you accidentally created a duplicate (different id, same concept), call merge_nodes to collapse them.

LAYER ASSIGNMENT — if the user names layers explicitly ("Trigger Layer", "Engagement Layer"), assign nodes to those layers via add_node.layer or move_node_to_layer. Don't create the layer and leave it empty.

PROJECT TAGGING — if the user is discussing a specific campaign or project (e.g. "Birthday Campaign", "Memorial Day", "Welcome Series"), include "project": "Birthday Campaign" (or whatever the project name is) in your add_decision, add_action, and set_environment_key args. This tags the entry so it groups under that project in the UI. If the item is shared across all projects (e.g. a BU MID, a sender profile), omit the project field. When in doubt, omit it — shared is the safe default.

Return ONLY the JSON array. No prose, no explanation, no code fences.`

// Renders the "### key — title\n...\nCurrent data:\n..." block for each tab.
// For structured tabs, we send the JSON data (not rendered markdown) so the
// LLM understands shape. For legacy free-form tabs, send raw content.
//
// STATE COMPRESSION: long-running workspaces accumulate dozens of rows. The
// LLM's attention gets diluted and it stops noticing existing entries → dup
// pollution + missed supersessions. For each list inside the structured data,
// we keep the first N rows in full detail and compress the tail into a count
// + id/label index so the LLM can still see "this exists, but I won't drown
// you in details." Full data is never hidden from dedup — that runs server-
// side in tab-ops handlers.
const LIST_FIELDS_FULL_HEAD = 5       // show this many in full
const LIST_FIELDS_FULL_HEAD_NODES = 10 // architecture nodes get a bigger head

function compressStructured(structured, filename) {
  if (!structured || typeof structured !== 'object') return structured
  const out = { ...structured }
  const compressList = (arr, head, indexFields) => {
    if (!Array.isArray(arr) || arr.length <= head) return arr
    const kept = arr.slice(0, head)
    const tail = arr.slice(head)
    const index = tail.map(item => {
      const parts = []
      for (const f of indexFields) {
        if (item[f] !== undefined && item[f] !== null && item[f] !== '') {
          parts.push(`${f}:${String(item[f]).slice(0, 60)}`)
        }
      }
      return '  ' + parts.join(' ')
    })
    return [
      ...kept,
      { __compressed__: `+${tail.length} more; showing id+summary only to save context:\n${index.join('\n')}` }
    ]
  }
  // tab-specific compression
  if (filename === 'people.md' && Array.isArray(out.people)) {
    out.people = compressList(out.people, LIST_FIELDS_FULL_HEAD, ['id', 'name', 'role', 'kind'])
  }
  if (filename === 'playbook.md' && Array.isArray(out.rules)) {
    out.rules = compressList(out.rules, LIST_FIELDS_FULL_HEAD, ['id', 'text', 'superseded_by'])
  }
  if (filename === 'environment.md' && Array.isArray(out.entries)) {
    out.entries = compressList(out.entries, LIST_FIELDS_FULL_HEAD * 3, ['key', 'value'])  // env keys are short; keep more
  }
  if (filename === 'decisions.md') {
    if (Array.isArray(out.decisions)) out.decisions = compressList(out.decisions, LIST_FIELDS_FULL_HEAD, ['id', 'text', 'superseded_by'])
    if (Array.isArray(out.actions))   out.actions   = compressList(out.actions,   LIST_FIELDS_FULL_HEAD, ['id', 'text', 'done'])
  }
  if (filename === 'architecture') {
    if (Array.isArray(out.nodes)) out.nodes = compressList(out.nodes, LIST_FIELDS_FULL_HEAD_NODES, ['id', 'label', 'kind', 'layer'])
    if (Array.isArray(out.edges) && out.edges.length > 20) {
      // edges are compact; just trim raw count
      out.edges = [...out.edges.slice(0, 20), { __compressed__: `+${out.edges.length - 20} more edges omitted` }]
    }
  }
  return out
}

export function buildTabsBlock(tabs) {
  return tabs.map(t => {
    // Derive filename from key if not set — memory:decisions.md → decisions.md
    const filename = t.filename || (t.key ? t.key.split(':')[1] : '') || ''
    const compressed = t.structured ? compressStructured(t.structured, filename) : null
    const body = compressed
      ? `Current data (JSON):\n\`\`\`json\n${JSON.stringify(compressed, null, 2)}\n\`\`\``
      : `Current content:\n\`\`\`\n${(t.content || '').substring(0, 1200)}${(t.content || '').length > 1200 ? '\n...' : ''}\n\`\`\``
    return `### ${t.key} — ${t.title}\n${body}`
  }).join('\n\n')
}

export function buildRouterUserMessage(input, tabsBlock, questionContext = null) {
  const userInput = questionContext
    ? `Question asked: "${questionContext}"\nUser's answer: "${input}"`
    : `User wrote: "${input}"`
  return `${userInput}\n\nAvailable tabs and current state:\n\n${tabsBlock}\n\nReturn the JSON array of ops.`
}
