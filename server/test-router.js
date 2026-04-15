// Test harness for the fact router.
// Simulates the routeAndPatchFact flow using real tab content + real LLM calls.
// Scores each test case on: correct tab(s) chosen, correct structural changes, no scope leaks.
//
// Run with: node server/test-router.js

import { config } from 'dotenv'
config({ override: true })

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set. Aborting.')
  process.exit(1)
}

// ── Fixture tabs ─────────────────────────────────────────────────────────────
// Mirrors the shape of a real Emory workspace.

const TABS = [
  {
    key: 'diagram:architecture',
    type: 'mermaid',
    title: 'Architecture',
    scope: 'System architecture — automations, DEs, SQL, journeys, emails, cloudpages, decision splits. NOT people or roles.',
    content: `flowchart TD
  Auto["Automation\\nBirthday_Daily_Send_Refresh\\n5 AM CT daily"] --> Query
  Source["ENT.All_Patients_Opted_In"] --> Query["SQL: Birthday_Daily_Filter"]
  Query -->|overwrites| SendDE["Birthday_Daily_Send\\nSendable DE"]
  SendDE --> Journey["Birthday Daily Email Journey"]
  Journey --> Email["brand_all_hbd_2026"]
  Email --> CloudPage["Birthday Quiz CloudPage\\nPage 8085"]
  CloudPage -->|writes row| ResponseDE["birthday_quiz_responses"]
  ResponseDE --> Split{"ResultPath decision split"}
  Split -->|heart| HV["Heart & Vascular\\n3 emails, 48h waits"]
  Split -->|womens| WS["Women's Services\\n3 emails, 48h waits"]
  Split -->|general| GH["General Health\\n3 emails, 48h waits"]`
  },
  {
    key: 'org:people.md',
    type: 'markdown',
    title: 'People',
    scope: 'Team members, roles, ownership. NOT system architecture or IDs.',
    content: `# People

## Team

- **David Zernik** — SFMC Architect. Builds automations, DEs, journeys.
- **Keyona Abbott** — Manager, David's boss. Handles creative and PM duties.

## Stakeholders

- PM / Stakeholders (unknown) — who approves go-live`
  },
  {
    key: 'memory:environment.md',
    type: 'markdown',
    title: 'Environment',
    scope: 'SFMC IDs, DE names, journey/automation keys, technical config. NOT people or business rules.',
    content: `# Environment

## Business Unit
- Emory Healthcare MID: 514005945
- Working BU: Marketing

## Data Extensions
- birthday_quiz_responses (ResponseDE)
- Birthday_Daily_Send
- ENT.All_Patients_Opted_In (source)

## CloudPages
- Birthday Quiz: Page 8085`
  },
  {
    key: 'memory:session-log.md',
    type: 'markdown',
    title: 'Session Log',
    scope: 'Session log — status, decisions, pending items. Narrative history.',
    content: `# Session Log

## Pending
- Confirm re-entry settings on follow-up journey
- Test Birthday Quiz CloudPage end-to-end`
  }
]

// ── Test cases ───────────────────────────────────────────────────────────────
// Each case: input + (optional) question + expected tab(s) + validation rules.

const TEST_CASES = [
  {
    name: 'People info on Architecture answer',
    question: 'Who approves content for follow-up emails?',
    input: 'only 2 people: David and his boss Keyona. delete the rest',
    expectedTabs: ['org:people.md'],
    mustNotUpdate: ['diagram:architecture'],
    validate: (updates) => {
      const people = updates.find(u => u.tab === 'org:people.md')
      if (!people) return { pass: false, why: 'People tab not updated' }
      const c = people.newContent.toLowerCase()
      if (!c.includes('david') || !c.includes('keyona')) return { pass: false, why: 'missing David or Keyona' }
      if (c.includes('pm / stakeholders') || c.includes('stakeholder')) return { pass: false, why: 'stale PM/Stakeholders row still present' }
      return { pass: true }
    }
  },
  {
    name: 'DE name update belongs on Environment',
    question: null,
    input: 'the response DE is actually called quiz_answers_v2, not birthday_quiz_responses',
    expectedTabs: ['memory:environment.md', 'diagram:architecture'],
    mustNotUpdate: ['org:people.md'],
    validate: (updates) => {
      const env = updates.find(u => u.tab === 'memory:environment.md')
      if (!env) return { pass: false, why: 'Environment not updated' }
      if (!env.newContent.includes('quiz_answers_v2')) return { pass: false, why: 'new DE name missing' }
      return { pass: true }
    }
  },
  {
    name: 'Pure session note goes to session log',
    question: null,
    input: 'tested the quiz page end-to-end and it works correctly',
    expectedTabs: ['memory:session-log.md'],
    mustNotUpdate: ['diagram:architecture', 'org:people.md'],
    validate: (updates) => {
      const log = updates.find(u => u.tab === 'memory:session-log.md')
      if (!log) return { pass: false, why: 'Session log not updated' }
      const c = log.newContent.toLowerCase()
      if (!c.includes('tested') && !c.includes('quiz')) return { pass: false, why: 'test note missing' }
      return { pass: true }
    }
  },
  {
    name: 'Irrelevant input results in no updates',
    question: null,
    input: 'the weather is nice today',
    expectedTabs: [],
    mustNotUpdate: ['diagram:architecture', 'org:people.md', 'memory:environment.md', 'memory:session-log.md'],
    validate: (updates) => {
      if (updates.length > 0) return { pass: false, why: `expected empty array, got ${updates.length} updates` }
      return { pass: true }
    }
  },
  {
    name: 'Multi-tab fact (journey timing + ownership)',
    question: null,
    input: 'Keyona owns creative for the quiz. Wait step between follow-ups is 48 hours.',
    expectedTabs: ['org:people.md'],
    mayUpdate: ['diagram:architecture', 'memory:environment.md'],
    mustNotUpdate: [],
    validate: (updates) => {
      const hasPeople = updates.some(u => u.tab === 'org:people.md')
      if (!hasPeople) return { pass: false, why: 'People tab should capture Keyona as creative owner' }
      return { pass: true }
    }
  },
  {
    name: 'Ambiguous pronoun — context matters',
    question: null,
    input: 'he approved the go-live yesterday',
    expectedTabs: [],
    mustNotUpdate: ['org:people.md'],
    validate: (updates) => {
      // "he" is ambiguous without a name. Router should not invent one.
      // Acceptable: either [] or session-log only.
      for (const u of updates) {
        if (u.tab === 'org:people.md') {
          const added = u.newContent.toLowerCase()
          if (added.includes('david') || added.includes('keyona')) {
            return { pass: false, why: 'invented a name for ambiguous pronoun' }
          }
        }
      }
      return { pass: true }
    }
  },
  {
    name: 'Structural diagram change — remove node + edges',
    question: null,
    input: 'the quiz is discontinued. remove the CloudPage and the response DE and all the downstream follow-up journeys.',
    expectedTabs: ['diagram:architecture'],
    mustNotUpdate: ['org:people.md'],
    validate: (updates) => {
      const arch = updates.find(u => u.tab === 'diagram:architecture')
      if (!arch) return { pass: false, why: 'Architecture not updated' }
      const c = arch.newContent
      if (c.includes('CloudPage') && c.includes('Page 8085')) return { pass: false, why: 'CloudPage still present' }
      if (c.includes('ResponseDE') || c.includes('birthday_quiz_responses')) return { pass: false, why: 'ResponseDE still present' }
      if (c.includes('Heart & Vascular') || c.includes('Women\'s Services')) return { pass: false, why: 'downstream journeys still present' }
      return { pass: true }
    }
  },
  {
    name: 'Correction replacing stale info on People',
    question: 'Who is the PM?',
    input: 'Keyona is the PM. there is no separate PM/stakeholder role.',
    expectedTabs: ['org:people.md'],
    mustNotUpdate: ['diagram:architecture'],
    validate: (updates) => {
      const people = updates.find(u => u.tab === 'org:people.md')
      if (!people) return { pass: false, why: 'People not updated' }
      const c = people.newContent.toLowerCase()
      if (!c.includes('keyona')) return { pass: false, why: 'Keyona not mentioned as PM' }
      // The "(unknown)" placeholder must be gone — that's the actual stale data.
      if (c.includes('(unknown)') || c.includes('tbd')) {
        return { pass: false, why: 'stale placeholder "(unknown)" not removed' }
      }
      // Must mention Keyona as PM specifically
      if (!/keyona[^\n]*pm|pm[^\n]*keyona/i.test(people.newContent)) {
        return { pass: false, why: 'Keyona not linked to PM role' }
      }
      return { pass: true }
    }
  },
  {
    name: 'Adding a new team member',
    question: null,
    input: 'Maya just joined as the QA lead for the birthday campaign',
    expectedTabs: ['org:people.md'],
    mustNotUpdate: ['diagram:architecture', 'memory:environment.md'],
    validate: (updates) => {
      const p = updates.find(u => u.tab === 'org:people.md')
      if (!p) return { pass: false, why: 'People tab not updated' }
      if (!p.newContent.toLowerCase().includes('maya')) return { pass: false, why: 'Maya not added' }
      return { pass: true }
    }
  },
  {
    name: 'Decision note → session log',
    question: null,
    input: 'decided to use 72-hour wait steps instead of 48h for the Heart & Vascular path based on last week\'s performance data',
    expectedTabs: ['memory:session-log.md', 'diagram:architecture'],
    mustNotUpdate: ['org:people.md'],
    validate: (updates) => {
      const log = updates.find(u => u.tab === 'memory:session-log.md')
      if (!log) return { pass: false, why: 'Session log should capture the decision' }
      return { pass: true }
    }
  },
  {
    name: 'Adding a new DE → Environment + Architecture',
    question: null,
    input: 'new Data Extension called quiz_attempts_log now captures every submission attempt before dedup',
    expectedTabs: ['memory:environment.md'],
    mayUpdate: ['diagram:architecture'],
    mustNotUpdate: ['org:people.md'],
    validate: (updates) => {
      const env = updates.find(u => u.tab === 'memory:environment.md')
      if (!env) return { pass: false, why: 'Environment not updated' }
      if (!env.newContent.toLowerCase().includes('quiz_attempts_log')) return { pass: false, why: 'new DE not added' }
      return { pass: true }
    }
  },
  {
    name: 'Typo / very short input → no update',
    question: null,
    input: 'asdf',
    expectedTabs: [],
    mustNotUpdate: ['diagram:architecture', 'org:people.md', 'memory:environment.md', 'memory:session-log.md'],
    validate: (updates) => {
      if (updates.length > 0) return { pass: false, why: 'nonsense input should not update anything' }
      return { pass: true }
    }
  },
  {
    name: 'Role change — remove old + add new',
    question: null,
    input: 'David is moving to a Data Engineering role. He will no longer be the SFMC Architect.',
    expectedTabs: ['org:people.md'],
    mustNotUpdate: ['diagram:architecture'],
    validate: (updates) => {
      const p = updates.find(u => u.tab === 'org:people.md')
      if (!p) return { pass: false, why: 'People not updated' }
      const c = p.newContent
      // Must reflect the new role (accept any "data eng" form)
      if (!/data eng/i.test(c)) return { pass: false, why: 'new role not added' }
      // Should not still list David as SFMC Architect
      if (/david[^\n]*sfmc architect/i.test(c)) return { pass: false, why: 'old role still listed' }
      return { pass: true }
    }
  },
  {
    name: 'Question/answer about env data stays out of diagram',
    question: 'What is the Journey ID for the Birthday Daily Email Journey?',
    input: 'The journey ID is 4c2a5e1b-9876-43ef-8d21-112233445566',
    expectedTabs: ['memory:environment.md'],
    mustNotUpdate: ['diagram:architecture', 'org:people.md'],
    validate: (updates) => {
      const env = updates.find(u => u.tab === 'memory:environment.md')
      if (!env) return { pass: false, why: 'Environment not updated' }
      if (!env.newContent.includes('4c2a5e1b')) return { pass: false, why: 'journey ID not stored' }
      return { pass: true }
    }
  }
]

// ── Router call (same logic as main.js) ─────────────────────────────────────

async function runRouter(input, questionContext) {
  const tabsBlock = TABS.map(t =>
    `### ${t.key} — ${t.title}\nScope: ${t.scope}\nContent:\n\`\`\`\n${t.content.substring(0, 1500)}${t.content.length > 1500 ? '\n...' : ''}\n\`\`\``
  ).join('\n\n')

  const userInput = questionContext
    ? `Question asked: "${questionContext}"\nUser's answer: "${input}"`
    : `User wrote: "${input}"`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      system: `You are a workspace router. Given a user's input, decide which workspace tab(s) the information belongs on, then return the updates.

Rules:
- An input may update 0, 1, or multiple tabs.
- Respect each tab's scope. Never put people info on an architecture diagram. Never put technical IDs on a People tab.

CORRECTIONS — when the user is CORRECTING or REPLACING existing info:
- Identify the stale entry and REMOVE it. Do not leave it in the document.
- Examples: "X is the PM, there is no separate PM" → delete any existing PM/stakeholder placeholder row.
- "Y is actually called Z" → delete the Y entry and replace with Z.
- Stale rows, placeholders like "(unknown)", "TBD", or "Stakeholders — who approves" should be removed when the user provides the answer.

AMBIGUOUS REFERENCES:
- If the input uses pronouns ("he", "she", "they") or unnamed references without enough context, DO NOT invent a name. Do not add to People.
- If you can't attribute a fact to a specific named person/system, either skip it or add it as a narrative note to session-log.md without inventing details.

DIAGRAMS:
- When you remove a node, also remove ALL edges to and from it.
- If downstream nodes are now orphaned, remove them too unless they're still referenced elsewhere.
- Reroute edges to consolidated nodes when merging roles.

OUT OF SCOPE:
- If the input doesn't belong on any tab, return [].

Return JSON array of updates. For each updated tab, return the COMPLETE new content:
[
  { "tab": "memory:environment.md", "newContent": "...full updated markdown..." },
  { "tab": "diagram:architecture", "newContent": "flowchart TD\\n  ..." }
]

Return ONLY valid JSON. No prose, no code fences.`,
      messages: [{
        role: 'user',
        content: `${userInput}\n\nAvailable tabs:\n\n${tabsBlock}\n\nReturn the JSON array of updates.`
      }]
    })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  const data = await res.json()
  let raw = data.content?.[0]?.text?.trim() || ''
  raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`invalid JSON: ${raw.substring(0, 200)}`)
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreCase(tc, updates) {
  const actualTabs = updates.map(u => u.tab)
  const results = []
  let score = 100

  // Expected tabs must be updated
  for (const t of tc.expectedTabs) {
    if (!actualTabs.includes(t)) {
      results.push(`missing expected tab: ${t}`)
      score -= 40
    }
  }

  // Must-not-update must be absent
  for (const t of tc.mustNotUpdate || []) {
    if (actualTabs.includes(t)) {
      results.push(`scope leak — updated ${t} but shouldn't have`)
      score -= 40
    }
  }

  // Custom validator
  if (tc.validate) {
    const v = tc.validate(updates)
    if (!v.pass) {
      results.push(`validation: ${v.why}`)
      score -= 30
    }
  }

  return { score: Math.max(0, score), issues: results, actualTabs }
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log('Running', TEST_CASES.length, 'test cases against Claude Haiku 4.5...\n')

  const results = []
  for (const tc of TEST_CASES) {
    process.stdout.write(`→ ${tc.name} ... `)
    try {
      const updates = await runRouter(tc.input, tc.question)
      const score = scoreCase(tc, updates)
      results.push({ name: tc.name, ...score, updates })
      console.log(`score: ${score.score}/100`)
      if (score.issues.length) {
        for (const issue of score.issues) console.log(`    - ${issue}`)
      }
      console.log(`    actual tabs: [${score.actualTabs.join(', ') || 'none'}]`)
      // Dump content on failure for debugging
      if (score.score < 80) {
        for (const u of updates) {
          console.log(`    --- ${u.tab} output ---`)
          console.log(u.newContent.split('\n').map(l => `    | ${l}`).join('\n'))
        }
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      results.push({ name: tc.name, score: 0, issues: [err.message], actualTabs: [] })
    }
    console.log()
  }

  const avg = results.reduce((s, r) => s + r.score, 0) / results.length
  console.log(`\n═══════════════════════════════════════════`)
  console.log(`Average score: ${avg.toFixed(1)}/100`)
  console.log(`Passing (≥80): ${results.filter(r => r.score >= 80).length}/${results.length}`)
  console.log(`Failing (<80): ${results.filter(r => r.score < 80).length}/${results.length}`)
  console.log(`═══════════════════════════════════════════`)
}

run().catch(err => { console.error(err); process.exit(1) })
