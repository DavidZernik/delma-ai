// Curated narrative scripts — full-arc "workdays" we can run Delma against
// when there's no real production traffic to replay.
//
// Each script is a 6-12 turn user-side conversation tied to a structured
// "expected outcome" the critic uses as ground truth. These are NOT random
// synthetic cases — they're stories deliberately written to exercise:
//   - multi-tab fan-out
//   - corrections / scope changes mid-arc
//   - long-tail facts spread across turns
//   - tab-routing edge cases
//
// Adding a new narrative = adding institutional knowledge about what
// "good behavior" looks like. Edit thoughtfully.

import { OPS_BY_TAB } from '../../src/tab-ops.js'
import { applyOpsToTab, parseTabKey } from '../lib/apply-op.js'
import { supabase as sb } from '../lib/supabase.js'
import { ANTHROPIC_URL, anthropicHeaders } from '../lib/llm.js'

const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-4-5'

async function callAnthropic(model, system, messages, max_tokens = 1500) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: anthropicHeaders('narrative-critic'),
    body: JSON.stringify({ model, max_tokens, system, messages: Array.isArray(messages) ? messages : [{ role: 'user', content: messages }] })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

// ── The narratives ────────────────────────────────────────────────────────

export const NARRATIVES = [
  {
    id: 'pm-onboarding',
    title: 'PM onboarding a new SFMC project',
    turns: [
      "Hi! I'm Sarah, the new PM. I'm taking over the Birthday Campaign project from Mike. Can you help me get organized?",
      "We have a small team: I'm the PM, Keyona Abbott is the engineer doing the SFMC build, and Mike Davis from product is our stakeholder.",
      "Wait actually Keyona reports to me. And Mike isn't really involved day-to-day, he's more of an exec sponsor.",
      "The main rule we have: nothing ships on Fridays. Legal needs 48h to review.",
      "Our SFMC sender profile is SP_Birthday_Main. Source DE is BirthdayPatients_Daily.",
      "We just decided to use a single email template for all birthday segments — that's a change from last quarter when we had four. Owner is Keyona.",
      "Action item: Keyona needs to update the journey to point at the new single template by next Friday.",
      "Architecture-wise: there's a daily automation that runs at 5am, queries the source DE, and feeds the BirthdayJourney which sends WelcomeEmail.",
      "Also for the architecture: group the daily auto + query into a 'Daily Filter' layer.",
      "Looks good! Anything I missed?"
    ],
    expected: {
      people: ['Sarah (PM)', 'Keyona Abbott (Engineer, reports to Sarah)', 'Mike Davis (exec sponsor / stakeholder)'],
      decisions: ['Use single email template for all birthday segments (Keyona)'],
      actions: ['Keyona: update journey to single template (due Friday)'],
      environment: ['SP_Birthday_Main (sender profile)', 'BirthdayPatients_Daily (source DE)'],
      playbook: ['No Friday launches (legal needs 48h)'],
      architecture: ['Nodes: daily auto, query, BirthdayJourney, WelcomeEmail; auto+query in "Daily Filter" layer; edges connect them in order']
    }
  },
  {
    id: 'scope-pivot-midway',
    title: 'Scope change mid-conversation',
    turns: [
      "Quick brain dump on the Q3 launch — we're targeting March 1.",
      "OK we have three personas: VIP patients, regulars, and lapsed. Each gets a different journey.",
      "Wait scratch that. Marketing just told us VIPs get the same journey as regulars now, just with extra sender ID. So two journeys, not three.",
      "The lapsed journey is owned by Diana Chen. She's external, contractor.",
      "We decided to delay the launch by 2 weeks — March 15, not March 1. Reason: legal review on lapsed messaging.",
      "Setup keys: lapsed sender = SP_Lapsed_Reactivate. Regular sender = SP_Standard_Promo.",
      "Architecture: each journey starts from a Daily filter automation. Regular journey = 'Promo_Daily_Refresh', lapsed = 'Lapsed_Daily_Refresh'.",
      "Anything I missed?"
    ],
    expected: {
      people: ['Diana Chen (contractor, owns lapsed journey)'],
      decisions: ['VIPs share regulars journey w/ extra sender ID (was 3 personas, now 2)', 'Delay launch from March 1 to March 15 (legal review)'],
      environment: ['SP_Lapsed_Reactivate', 'SP_Standard_Promo'],
      architecture: ['Two journeys (regulars, lapsed); two daily-refresh automations feeding each']
    }
  },
  {
    id: 'noisy-chitchat-mixed',
    title: 'Real chitchat mixed with real facts',
    turns: [
      "Morning! How are you?",
      "OK quick thing — Robert Kim joined the team yesterday, he's our new data engineer.",
      "What's the weather like in your model's training data? Lol. Anyway.",
      "Robert reports to Keyona.",
      "Don't put this in the workspace, just for context: I'm tired today.",
      "Decision yesterday: we're moving the Daily_Refresh automation from 5am to 6am because of upstream data delays.",
      "What time is it where you are? Just curious.",
      "OK that's it for now."
    ],
    expected: {
      people: ['Robert Kim (data engineer, reports to Keyona)'],
      decisions: ['Move Daily_Refresh from 5am to 6am (upstream data delays)'],
      shouldNOTcapture: ['"morning how are you"', '"I\'m tired today"', '"what time is it"']
    }
  },
  {
    id: 'architecture-heavy',
    title: 'Building out a full SFMC architecture turn-by-turn',
    turns: [
      "Let's design the Welcome Series flow from scratch.",
      "Source: a data extension called NewSubscribers_Daily, populated by an upstream sync.",
      "An automation called Welcome_Send_Daily runs at 7am, querying NewSubscribers_Daily.",
      "The query filters to subs with no welcome sent yet, and feeds a journey called WelcomeJourney.",
      "WelcomeJourney has three emails: Welcome_Email_Day0, Welcome_Email_Day3, Welcome_Email_Day7.",
      "There's also a decision split after Day3 — if they opened, route to Day7; if not, exit.",
      "Group the data extension and automation under a 'Trigger Layer'. Group the journey + emails under 'Engagement Layer'.",
      "Done — does that look right?"
    ],
    expected: {
      architecture: [
        'Nodes: NewSubscribers_Daily (deSource), Welcome_Send_Daily (automation), the SQL query (sql), WelcomeJourney (journey), three emails, decision split',
        'Edges: source → automation → query → journey → emails; decision split routes Day3 → Day7 OR exit',
        'Layers: "Trigger Layer" (DE + automation), "Engagement Layer" (journey + emails)'
      ]
    }
  },
  {
    id: 'environment-heavy',
    title: 'Recording lots of technical IDs in one session',
    turns: [
      "Let me dump the env config for the Q2 launch.",
      "Sender Profile: SP_Q2_Launch.",
      "Source DE: Subscribers_Q2.",
      "Journey ID: J_Q2_Welcome_2025.",
      "Automation: Auto_Q2_Refresh.",
      "Reply mailbox is q2-replies@example.com.",
      "And a CloudPage URL: cloud.example.com/q2-preferences",
      "That's the lot."
    ],
    expected: {
      environment: [
        'SP_Q2_Launch (sender profile)', 'Subscribers_Q2 (source DE)',
        'J_Q2_Welcome_2025 (journey id)', 'Auto_Q2_Refresh (automation)',
        'q2-replies@example.com (reply mailbox)', 'cloud.example.com/q2-preferences (CloudPage URL)'
      ],
      shouldNOTcapture: ['anything in People, Playbook, Decisions, or Architecture']
    }
  },
  {
    id: 'corrections-and-supersession',
    title: 'User keeps changing their mind — exercise corrections',
    turns: [
      "We decided to use a single template for all four segments. Owner is Alex.",
      "Actually scratch that — we're keeping the four templates. Better personalization.",
      "Let me also add: David Zernik is the new tech lead. Reports to me, the PM Sarah Lee.",
      "Wait, David already exists in the workspace? OK then just update him to tech lead, he was previously engineer.",
      "And the launch date — was Mar 1, now Mar 15.",
      "Oh and the Friday rule — we can ship on Fridays now. Legal cleared a faster review path.",
      "That's all the changes."
    ],
    expected: {
      decisions: [
        'Initial: single template (4 segments). Then SUPERSEDED by: keep four templates (better personalization).',
        'Initial: launch March 1. Then SUPERSEDED by: launch March 15.'
      ],
      people: ['David Zernik role updated to "tech lead" (was engineer); reports to Sarah Lee (PM)'],
      playbook: ['"No Friday launches" rule should be REMOVED or marked superseded — Friday launches now allowed.']
    }
  },
  {
    id: 'cross-tab-fanout',
    title: 'Single message that legitimately fans out across 4 tabs',
    turns: [
      "Big update: Susan Park is now the exec sponsor (was VP). Owner of decisions in this project. Friday no-launch rule still applies. We just decided to use SP_Susan_Test as her test sender. Action: Susan to confirm her test list by EOW.",
      "And the architecture: add a TestSendAuto automation that fires Susan's preview before each batch."
    ],
    expected: {
      people: ['Susan Park role updated to exec sponsor (was VP)'],
      decisions: ['Use SP_Susan_Test as her test sender (Susan)'],
      actions: ['Susan: confirm test list by EOW'],
      environment: ['SP_Susan_Test (sender profile)'],
      architecture: ['Add TestSendAuto (automation) that fires before each batch'],
      playbook: ['No Friday launches — already in playbook, no action needed (don\'t duplicate)']
    }
  },
  {
    id: 'sfmc-cross-bu-trap',
    title: 'SFMC: cross-BU campaign with parent + working BU distinction',
    turns: [
      "OK new campaign: Populi outreach. The Populi audience DE lives in our parent BU (Emory Healthcare), but all the sends + journey activity happen in our working BU (Marketing).",
      "So the source DE is `Populi_Audience_Master` in the parent BU.",
      "We replicate it nightly to a sendable DE called `Populi_Sendable_Daily` in the Marketing BU.",
      "The automation `Populi_Sync_Auto` does the cross-BU copy at 3am.",
      "Then `Populi_Send_Auto` runs at 5am, queries the sendable DE, and feeds the `PopuliWelcome` journey.",
      "The journey sends a single email asset called `Populi_Welcome_Email_v2`.",
      "Sender profile: SP_Populi_Marketing. From address: marketing@example.com. Reply mailbox: marketing-replies@example.com.",
      "Group the cross-BU sync (source DE + sync auto + sendable DE) under a 'Cross-BU Source' layer. The 5am send + journey + email under 'Daily Send' layer.",
      "Anything missed?"
    ],
    expected: {
      environment: [
        'Parent BU = "Emory Healthcare", working BU = "Marketing" (SEPARATE keys)',
        'Source DE = Populi_Audience_Master (parent BU)',
        'Sendable DE = Populi_Sendable_Daily (Marketing BU)',
        'SP_Populi_Marketing (sender profile)',
        'marketing@example.com (from address — DIFFERENT key than reply mailbox)',
        'marketing-replies@example.com (reply mailbox)'
      ],
      architecture: [
        'Nodes: Populi_Audience_Master (deSource), Populi_Sync_Auto (automation), Populi_Sendable_Daily (de), Populi_Send_Auto (automation), PopuliWelcome (journey), Populi_Welcome_Email_v2 (email)',
        'CRITICAL: deSource for the parent-BU DE, de for the working-BU DE — these are different kinds',
        'Two layers: "Cross-BU Source" wraps the first three nodes; "Daily Send" wraps the last three',
        'Edges flow: Audience → Sync_Auto → Sendable → Send_Auto → Journey → Email'
      ],
      shouldNOTcapture: [
        'Sender profile in People tab (it goes in Environment)',
        'From address conflated with reply mailbox or sender profile (these are 3 distinct SFMC concepts)'
      ]
    }
  },
  {
    id: 'sf-dev-apex-flow',
    title: 'Salesforce dev: Apex trigger + Flow + custom object work (technical user)',
    turns: [
      "Working on a custom object Loan__c. Need an Apex trigger on insert that calls a Flow.",
      "The Flow is called Loan_Risk_Check_v2. It pulls the Loan__c.Amount__c field and checks against a Risk_Tier__c picklist.",
      "If amount > 100k, set Status__c to 'Pending Review' and create a Task assigned to the Risk Manager queue.",
      "I'm Alex Chen, the dev. PM is Maria Rodriguez (she's not technical). Risk team lead is Devon Park.",
      "Decision: we're using before-insert trigger pattern, not after-insert. Avoids the recursive trigger problem we hit last quarter.",
      "Tech keys: org alias is uat-loans-2025, sandbox is named UAT_Loans_Q1. API version 60.0.",
      "Action: I need to write a test class achieving 90% coverage by Thursday.",
      "Architecture: the trigger fires the Flow, which checks the picklist, conditionally creates a Task. Group those under a 'Loan Intake' layer.",
      "Anything I missed?"
    ],
    expected: {
      people: ['Alex Chen (dev)', 'Maria Rodriguez (PM, non-technical)', 'Devon Park (Risk team lead)'],
      decisions: ['Use before-insert trigger (avoids recursive trigger issue from last quarter)'],
      actions: ['Alex: write test class to 90% coverage by Thursday'],
      environment: ['Org alias: uat-loans-2025', 'Sandbox: UAT_Loans_Q1', 'API version: 60.0', 'Custom object: Loan__c with Amount__c, Risk_Tier__c, Status__c fields'],
      architecture: [
        'Trigger on Loan__c (insert) → Flow (Loan_Risk_Check_v2) → Task creation',
        'All inside a "Loan Intake" layer',
        'Note: this is plain Salesforce (Sales/Service Cloud), NOT SFMC — so kinds may not perfectly match the SFMC vocabulary. Architecture nodes can use endpoint kind for non-SFMC objects.'
      ]
    }
  },
  {
    id: 'sf-admin-config-only',
    title: 'Salesforce admin doing config (no code, opinionated about clicks-not-code)',
    turns: [
      "Hi! Casey here, Salesforce admin. Just me — small org, no devs.",
      "We need to add a new validation rule on the Opportunity object: Amount must be > 0 if StageName = 'Closed Won'.",
      "Going to do it in Setup → Object Manager. Won't touch any code.",
      "Decision: we're not going to use Flow Builder for this — too heavy. Validation rule is simpler and serves the same need.",
      "Action: I need to test it in our developer sandbox before pushing to prod. Will do that tomorrow.",
      "Org: company name is Riverside Construction. We're on Sales Cloud Enterprise edition.",
      "I'm the only admin. No team. Just me."
    ],
    expected: {
      people: ['Casey (admin, solo) — no team'],
      decisions: ['Use validation rule, not Flow Builder (simpler)'],
      actions: ['Casey: test in dev sandbox before prod push (tomorrow)'],
      environment: ['Org: Riverside Construction', 'Edition: Sales Cloud Enterprise'],
      shouldNOTcapture: ['Anything about teams or reporting structure (it is a solo operator — do not invent collaborators)']
    }
  },
  {
    id: 'sf-solo-consultant',
    title: 'Solo Salesforce consultant juggling multiple clients',
    turns: [
      "Quick brain dump for myself.",
      "Client: Atlas Logistics. They want a Service Cloud rollout.",
      "Their primary contact is Janelle Foster (Director of Operations). She's not technical.",
      "We agreed on a 6-week timeline. Decision: we're starting with Cases + Email-to-Case in week 1, not full Omnichannel routing. Scope creep risk.",
      "Their current org: AtlasOps_Prod. Production org. They want me building straight in production with backups, not in a sandbox. I told them no — we'll use a developer sandbox first. That's a non-negotiable from me.",
      "Action: Janelle to send me their current case email templates by Friday so I can replicate.",
      "Note to self: remind myself to check their data storage limits before importing historical case data. They're on Professional edition, limits are tighter."
    ],
    expected: {
      people: ['Janelle Foster (Director of Operations, Atlas Logistics — client, non-technical, kind:stakeholder)'],
      decisions: ['Phase 1 = Cases + Email-to-Case, NOT full Omnichannel (scope risk)', 'Use developer sandbox, NOT prod (non-negotiable)'],
      actions: ['Janelle: send current case email templates by Friday'],
      environment: ['Client org: AtlasOps_Prod (Service Cloud, Professional edition)'],
      myNotes: ['Remind self: check data storage limits before importing historical cases (Pro edition has tighter limits)'],
      shouldNOTcapture: ['"Brain dump for myself" routed to playbook or decisions — it is just narrator framing']
    }
  },
  {
    id: 'sf-cross-cloud-org',
    title: 'Mid-size org: PM working across Sales Cloud + SFMC + Service Cloud',
    turns: [
      "We're integrating data flow between three clouds: leads come into Sales Cloud, qualified ones get nurtured in SFMC, post-purchase support routes through Service Cloud.",
      "Lead arrives in Sales Cloud as Lead object → if Status = 'Qualified', a process triggers a sync to SFMC.",
      "In SFMC: a sendable DE called Qualified_Leads_Sync gets the new contact, kicks off the WelcomeNurture journey.",
      "Once they buy (Opportunity Closed Won in Sales Cloud), we sync them as a Contact + Account into Service Cloud, and an Email-to-Case channel opens.",
      "Three teams: Sales (lead by Pat Wong), Marketing (lead by Keyona Abbott), Support (lead by David Zernik). All three report to me, the VP, Sarah Lee.",
      "Decision: we're using Marketing Cloud Connect for the Sales→SFMC sync, not custom integration. Standard tooling.",
      "Action: Pat to map field mappings between Lead and SFMC contact attributes by next Wed.",
      "Architecture-wise, group Sales Cloud bits in 'Lead Intake', SFMC bits in 'Nurture', Service Cloud bits in 'Post-Sale Support'."
    ],
    expected: {
      people: [
        'Sarah Lee (VP) — manager of all three',
        'Pat Wong (Sales lead, reports to Sarah)',
        'Keyona Abbott (Marketing lead, reports to Sarah)',
        'David Zernik (Support lead, reports to Sarah)'
      ],
      decisions: ['Use Marketing Cloud Connect for Sales→SFMC sync (standard tooling, not custom)'],
      actions: ['Pat: map Lead-to-SFMC contact field mappings by Wednesday'],
      architecture: [
        'Three layers: "Lead Intake", "Nurture", "Post-Sale Support"',
        'Sales Cloud Lead → process → SFMC Qualified_Leads_Sync (sendable DE) → WelcomeNurture (journey) → conversion → Service Cloud Contact + Account + Email-to-Case',
        'SFMC parts use SFMC kinds (de, journey, etc.); Sales/Service Cloud objects can be endpoint kind or labeled in their notes'
      ]
    }
  },
  {
    id: 'sfmc-classification-traps',
    title: 'SFMC: classification ambiguity (CloudPage, AMPscript, decision splits)',
    turns: [
      "The new flow has a quiz the user takes from the email link. The quiz is a CloudPage with AMPscript handling submissions.",
      "After they submit, we use a decision split inside the journey: if quiz_complete = true, send the next email; otherwise wait 48h and re-prompt.",
      "The CloudPage is called `Birthday_Quiz_2025`. The journey is `BirthdayJourney_v3`.",
      "Two emails: `Birthday_Initial` (sent on day 0) and `Birthday_FollowUp` (sent on day 3 if quiz incomplete).",
      "Source DE: `Birthday_Patients_Daily`. Sender profile: SP_Birthday_Promo.",
      "Anything I missed?"
    ],
    expected: {
      architecture: [
        'Birthday_Quiz_2025 must be kind:cloudpage (NOT email — common LLM mistake)',
        'BirthdayJourney_v3 = kind:journey',
        'Birthday_Initial + Birthday_FollowUp = kind:email each',
        'Decision split inside journey = kind:decision (NOT a separate journey)',
        'Birthday_Patients_Daily = kind:de (or deSource if read-only)',
        'AMPscript should appear as a NOTE on the CloudPage node, NOT as its own node — AMPscript is a language used inside SFMC objects, not an SFMC object itself'
      ],
      environment: [
        'SP_Birthday_Promo (sender profile)'
      ],
      shouldNOTcapture: [
        'AMPscript as its own architecture node',
        'CloudPage classified as email or as endpoint',
        'Decision split as a separate journey'
      ]
    }
  }
]

// ── Run a single narrative end-to-end ─────────────────────────────────────

async function ensureSimWorkspace(label) {
  const SIM_USER = '00000000-0000-0000-0000-000000000001'

  // PER-NARRATIVE ORG. Each run gets its own Organization so org-level tabs
  // (people, playbook) start empty. Previously narratives shared one big sim
  // org, and state leaked across runs — the critic kept (correctly) flagging
  // "14 ghost people" and "7 Friday rules" that were artifacts of prior sims,
  // not the current test. Cleanup runs on age, not per-run delete, so a few
  // days of sim orgs accumulate — `cleanupOldQaSimOrgs` sweeps them.
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const rand = Math.random().toString(36).slice(2, 7)
  const orgName = `QA Sim · ${label} · ${ts} · ${rand}`
  const orgSlug = `qa-sim-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${rand}`.slice(0, 60)

  const { data: org, error: orgErr } = await sb.from('organizations')
    .insert({ name: orgName, slug: orgSlug, created_by: SIM_USER })
    .select().single()
  if (orgErr || !org) throw new Error(`sim org create failed: ${orgErr?.message || 'null row'}`)
  await sb.from('org_members').insert({ org_id: org.id, user_id: SIM_USER, role: 'admin' })

  const wsName = `${label} ${ts}`
  const { data: ws, error: wsErr } = await sb.from('workspaces')
    .insert({ name: wsName, org_id: org.id, created_by: SIM_USER }).select().single()
  if (wsErr || !ws) throw new Error(`sim workspace create failed: ${wsErr?.message || 'null row'}`)
  await sb.from('workspace_members').insert({ workspace_id: ws.id, user_id: SIM_USER, role: 'owner' })

  return { orgId: org.id, workspaceId: ws.id, userId: SIM_USER, workspaceName: wsName, orgName }
}

// ── Native Anthropic tool-use: define each typed op as a tool ──────────

import { ROUTER_SYSTEM_PROMPT } from '../../src/router-prompt.js'

// Build Anthropic tool definitions from OPS_BY_TAB. Each typed op becomes
// a single tool with a synthetic name (delma_<filename>__<op>). The args
// schemas are the SAME contracts the typed-op handlers expect, so the
// model can't pass invalid args without it being immediately obvious.
function buildAnthropicTools() {
  const tools = []
  for (const [filename, ops] of Object.entries(OPS_BY_TAB)) {
    const tabPrefix = filename === 'architecture' ? 'diagram:' : (['people.md', 'playbook.md'].includes(filename) ? 'org:' : 'memory:')
    const tabKey = `${tabPrefix}${filename}`
    for (const op of ops) {
      tools.push({
        name: `${filename.replace(/\W/g, '_')}__${op}`,
        description: `Apply typed op "${op}" on ${tabKey}.`,
        input_schema: SCHEMA_BY_OP[op] || { type: 'object', properties: {}, additionalProperties: true }
      })
    }
  }
  return tools
}

// Lightweight arg-shape hints for each op. We don't try to be exhaustive —
// the typed-op handlers validate strictly and any errors get surfaced to the
// model via tool_result messages so it can self-correct.
const SCHEMA_BY_OP = {
  add_person: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, kind: { type: 'string', enum: ['person', 'manager', 'stakeholder', 'team', 'vendor'] }, reports_to: { type: 'string' } }, required: ['name'] },
  set_role: { type: 'object', properties: { person: { type: 'string' }, role: { type: 'string' } }, required: ['person', 'role'] },
  remove_person: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  add_reporting_line: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  remove_reporting_line: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  set_manager: { type: 'object', properties: { person: { type: 'string' }, manager: { type: 'string' } }, required: ['person', 'manager'] },
  add_playbook_rule: { type: 'object', properties: { text: { type: 'string' }, section: { type: 'string' } }, required: ['text'] },
  remove_playbook_rule: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  set_environment_key: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' }, project: { type: 'string' } }, required: ['key', 'value'] },
  remove_environment_key: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  add_decision: { type: 'object', properties: { text: { type: 'string' }, owner: { type: 'string' }, project: { type: 'string' } }, required: ['text'] },
  add_action: { type: 'object', properties: { text: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' }, project: { type: 'string' } }, required: ['text'] },
  complete_action: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  complete_action_by_text: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  remove_decision: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  supersede_decision: { type: 'object', properties: { id: { type: 'string' }, new_text: { type: 'string' }, owner: { type: 'string' } }, required: ['id', 'new_text'] },
  append_my_note: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  replace_my_notes: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  set_prose: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  add_node: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' }, layer: { type: 'string' } }, required: ['id', 'label', 'kind'] },
  set_node_label: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] },
  set_node_note: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] },
  set_node_kind: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' } }, required: ['id', 'kind'] },
  move_node_to_layer: { type: 'object', properties: { id: { type: 'string' }, layer: { type: 'string' } }, required: ['id', 'layer'] },
  remove_node: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  add_edge: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] },
  remove_edge: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  add_layer: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] },
  remove_layer: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  // New ops added for handler-level dedup escapes
  merge_nodes: { type: 'object', properties: { keep_id: { type: 'string' }, remove_id: { type: 'string' } }, required: ['keep_id', 'remove_id'] },
  supersede_rule: { type: 'object', properties: { id: { type: 'string' }, new_text: { type: 'string' }, section: { type: 'string' } }, required: ['id', 'new_text'] }
}

const CLAUDE_SYS = `You are Claude, the assistant a PM is talking to. You have access to Delma's typed-op tools. After each user message:
1. If the user said anything worth capturing (a person, a decision, a tech ID, a process rule, an architecture detail, a personal note), call the appropriate tool(s).
2. Reply with a short, natural acknowledgement (1-2 sentences). Do NOT recite which tools you called.

Tools are named <filename>__<op>, e.g. people_md__add_person. Each tool's input_schema describes its args. Call as many tools per turn as needed; the user might mention several facts in one message.

Use the most specific tool available. For "X reports to Y instead of Z", prefer set_manager (replaces) over add_reporting_line (adds). For decisions that contradict prior ones, prefer supersede_decision over remove_decision. For an action whose id you don't know, use complete_action_by_text.

When the user REVERSES a prior decision or rule ("scratch that", "actually", "instead", "changed our mind", a direct contradiction), DO NOT call add_decision or add_playbook_rule — the handler will error on the near-duplicate and you'll leave the workspace with contradictions. Use supersede_decision or supersede_rule instead. If the prior id isn't obvious from the current state, emit add_* anyway — the error message will give you the existing id so you can supersede on the next turn.

For architecture nodes, REUSE existing ids when you reference an object that's already in the diagram. Don't invent a new id for the same concept (the handler blocks near-duplicate labels). If you realize two different ids point at the same thing, call merge_nodes to collapse them.

If nothing concrete was said (chitchat, questions, vague hedges), don't call any tool. Just reply naturally.`

// Post-turn reflection: after the main tool-use loop finishes, ask a cheap
// model "did you miss anything the user named in this turn?" and let it
// emit follow-up ops. Most 2/5 narratives in today's results came from the
// LLM dropping explicitly-named objects (Welcome_Email_Day3, Populi_Send_Auto).
// This pass catches those. Tagged `reflective: true` in the op log so we
// can see which captures came from the reflection step vs the primary pass.
//
// Disabled with DELMA_SIM_NO_REFLECT=1 for A/B comparison runs.
async function reflectTurn(userText, ops, ctx) {
  if (process.env.DELMA_SIM_NO_REFLECT === '1') return []
  if (!userText || userText.length < 30) return []  // skip chitchat-length turns

  const opsSummary = ops.length
    ? ops.map(o => `- ${o.tab}/${o.op} ${JSON.stringify(o.args || {}).slice(0, 120)}`).join('\n')
    : '(no tools called)'

  const prompt = `Review the last turn. For each thing the user named, did you call the right tool?

USER TURN: """${userText}"""

TOOL CALLS YOU MADE:
${opsSummary}

CHECKLIST — check EACH item individually:
- Every named person → add_person (+ set_manager/add_reporting_line if reporting stated)
- Every named SFMC object (Journey, Automation, DE, Email asset, CloudPage, SQL query activity, decision split) → architecture add_node (+ edges to wire it in)
  IMPORTANT: if the user listed MULTIPLE objects by name (e.g. "Day0, Day3, Day7" or "Sync_Auto and Send_Auto"), EACH ONE needs its own add_node call. Do NOT collapse them into a single node. Count them.
- Every explicit decision or reversal → add_decision or supersede_decision
- Every tech ID (sender profile, BU, API, org alias, sandbox name) → set_environment_key
- Every to-do → add_action with owner and due if stated
- Every policy rule → add_playbook_rule

EDGE DIRECTION CHECK: for any edges you added, verify direction matches data flow:
- Automation queries a DE → edge FROM the DE TO the automation (data flows into the automation)
- Automation feeds a journey → edge FROM the automation TO the journey
- Journey sends an email → edge FROM the journey TO the email
- Source DE replicates to sendable DE → edge FROM source TO sendable (data copies downstream)
If an edge is backwards, call remove_edge then add_edge with the correct direction.

If you captured everything AND edges are correct: reply "complete" with no tool calls.
If you MISSED something or an edge is wrong: fix it now.`

  try {
    const tools = buildAnthropicTools()
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders('narrative-sim-reflect'),
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 1200,
        system: CLAUDE_SYS,
        tools,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    if (!res.ok) { console.warn('[quality:nar] reflection failed:', res.status); return [] }
    const data = await res.json()
    const toolUses = (data.content || []).filter(c => c.type === 'tool_use')
    if (!toolUses.length) return []

    const followUps = []
    for (const tu of toolUses) {
      const [fileSafe, op] = tu.name.split('__')
      const filename = fileSafe.replace(/_md$/, '.md').replace(/^architecture$/, 'architecture')
      const tabPrefix = filename === 'architecture' ? 'diagram:' : (['people.md', 'playbook.md'].includes(filename) ? 'org:' : 'memory:')
      const tabKey = `${tabPrefix}${filename}`
      const scope = parseTabKey(tabKey, ctx)
      if (!scope) continue
      const t0 = Date.now()
      try {
        const r = await applyOpsToTab(sb, scope, [{ op, args: tu.input || {} }])
        followUps.push({ tab: tabKey, op, args: tu.input, ok: true, ms: Date.now() - t0, errors: r.errors, reflective: true })
      } catch (err) {
        // Rejections here are often "handler caught a near-dup we already
        // had" — that's fine, the original pass captured it. Still logged
        // so we can see what reflection tried.
        followUps.push({ tab: tabKey, op, args: tu.input, ok: false, ms: Date.now() - t0, error: err.message, reflective: true })
      }
    }
    return followUps
  } catch (err) {
    console.warn('[quality:nar] reflection error (non-fatal):', err.message)
    return []
  }
}

// Native tool-use turn. Returns the assistant's tool calls + final reply.
async function runOneTurn(messages, ctx) {
  const tools = buildAnthropicTools()
  const opsRecorded = []   // { tab, op, args, ok, ms, error }

  // Loop because the model may call multiple tools and chain
  let turnMessages = messages.slice()
  let finalText = ''
  for (let iter = 0; iter < 8; iter++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders('narrative-sim'),
      body: JSON.stringify({ model: HAIKU, max_tokens: 1500, system: CLAUDE_SYS, tools, messages: turnMessages })
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const content = data.content || []
    const toolUses = content.filter(c => c.type === 'tool_use')
    const texts = content.filter(c => c.type === 'text').map(c => c.text).join(' ')
    if (texts) finalText = texts

    if (!toolUses.length || data.stop_reason === 'end_turn') {
      return { reply: finalText, ops: opsRecorded, raw: data }
    }

    // Apply each tool_use, append assistant content + tool_result blocks
    turnMessages.push({ role: 'assistant', content })
    const toolResults = []
    for (const tu of toolUses) {
      const [fileSafe, op] = tu.name.split('__')
      const filename = fileSafe.replace(/_md$/, '.md').replace(/^architecture$/, 'architecture')
      const tabPrefix = filename === 'architecture' ? 'diagram:' : (['people.md', 'playbook.md'].includes(filename) ? 'org:' : 'memory:')
      const tabKey = `${tabPrefix}${filename}`
      const scope = parseTabKey(tabKey, ctx)
      const t0 = Date.now()
      let resultText = '', isErr = false
      if (!scope) {
        resultText = `error: unknown tab ${tabKey}`; isErr = true
      } else {
        try {
          const r = await applyOpsToTab(sb, scope, [{ op, args: tu.input || {} }])
          resultText = JSON.stringify({ applied: r.applied.length, errors: r.errors })
          opsRecorded.push({ tab: tabKey, op, args: tu.input, ok: true, ms: Date.now() - t0, errors: r.errors })
        } catch (err) {
          resultText = `error: ${err.message}`; isErr = true
          opsRecorded.push({ tab: tabKey, op, args: tu.input, ok: false, ms: Date.now() - t0, error: err.message })
        }
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText, is_error: isErr })
    }
    turnMessages.push({ role: 'user', content: toolResults })
  }
  return { reply: finalText || '(model exceeded tool-use loop)', ops: opsRecorded, raw: null }
}

const CRITIC_SYS = `You critique a Delma narrative-test run. Delma is a workspace for people building things in the Salesforce ecosystem — Salesforce (Sales/Service Cloud, Apex, Flows, custom objects) AND Salesforce Marketing Cloud (Journeys, DEs, automations, CloudPages). Users span:

- Solo admins / consultants working alone (no team to capture)
- PMs in mid-size orgs (somewhat-technical, opinionated about scope, juggle several clouds)
- Devs writing Apex / triggers / flows (technical, need build context)
- Pure SFMC marketing ops folks (Journey Builder + Email Studio focused)
- Cross-cloud teams integrating Sales Cloud → SFMC → Service Cloud

YOUR LENS: read the narrative's user persona FROM THE TURNS THEMSELVES — solo admin sounds different from cross-cloud VP. Then ask: could THIS user, with THIS workspace state, make their next decision and unblock their work tomorrow? Does the workspace capture what they need — or only what a different persona would want?

Calibrate to the persona:
- Solo admin: don't ding for missing People rows — there's no team
- Dev: tech keys + decisions matter most; people might be light
- PM: workflow clarity + decisions + actions; tech keys the dev cares about can be lighter
- Marketing ops: SFMC accuracy matters more (Journey vs Automation, etc.)
- Cross-cloud: getting the cloud boundaries right is the headline

WHAT MATTERS MOST (across all personas):

1. Workflow / build clarity — what does this thing DO, top to bottom? For SFMC:
   the journey + dependencies. For Sales Cloud: the trigger / flow / object
   relationships. For solo admin work: just the rule + where it lives.
2. Decisions captured — these unblock work whether you're a team or solo.
3. Action items captured WITH owners (or self-as-owner if solo).
4. Tech keys captured at all (org name, sandbox name, custom object/field names,
   SFMC IDs) — even if minor classification is off. The user can fix a label,
   they can't conjure a missing org alias from nothing.
5. People structure ONLY when there is a team (don't fabricate it for solo users).

WHAT MATTERS LESS (don't be a pedant):

- Whether a CloudPage was labeled kind:cloudpage vs kind:endpoint — annoying,
  but the PM can see the node label and rename it. NOT a 1/5.
- Whether AMPscript got captured as a node or a note — semantic detail.
- Whether a Send Classification got a perfect technical name. Close-enough
  is fine.
- Whether the LLM lowercased or PascalCased an id.

WHAT MATTERS A LOT (real ship-blockers — adapt to persona):

- (SFMC) Parent BU vs working BU getting collapsed into one key
- (SFMC) Sender Profile + From Address + Reply Mailbox conflated
- (SFMC) Source DE vs Sendable DE conflated
- (Sales/Service Cloud dev) Sandbox vs production confusion in env keys
- (Sales/Service Cloud dev) Apex class / Flow / trigger conflated as one node
- (Cross-cloud) Cloud boundaries wrong (Sales Cloud lead misclassified as SFMC contact)
- A decision recorded twice with contradicting text (any persona — confusion)
- An action item without an owner when one was clearly named (any persona)
- People reporting structure invented for a SOLO user (don't add fake teams)

TONE: be the PM's pragmatic teammate. Honest but not nitpicky. If 4 of 5
expected things landed and the missing one wasn't a ship-blocker, that's a 4.

Score 1-5 on:
- accuracy   (does the final state let the PM make their next move?)
- coverage   (% of WHAT-MATTERS-MOST items present; over-capture of noise also dings)
- correctness (right tabs, right ops, right SFMC sense — at PM-fluency level)
- timeliness (any pathological lag — outliers > 3s on a typed op?)

Return JSON ONLY:
{
  "scores": { "accuracy": <1-5>, "coverage": <1-5>, "correctness": <1-5>, "timeliness": <1-5> },
  "overall": <1-5>,
  "summary": "<2-3 sentences in PM-teammate voice. What worked, what would actually block them tomorrow>",
  "missed": [ "<things this PM will need that aren't there — be concrete about why it matters>" ],
  "wrong": [ "<actual ship-blockers, NOT pedantic classification quibbles>" ],
  "praise": [ "<what genuinely landed well — useful for them to know we got X right>" ]
}`

async function critique(narrative, transcript, finalState, opTimings) {
  const userMsg = `## Narrative
**${narrative.title}** (id: ${narrative.id})

### Script (user side)
${narrative.turns.map((t, i) => `T${i + 1}: ${t}`).join('\n')}

### Expected outcome (ground truth, written by author)
${JSON.stringify(narrative.expected, null, 2)}

### Actual final structured state per tab
${Object.entries(finalState).map(([k, v]) => `### ${k}\n${JSON.stringify(v, null, 2)}`).join('\n\n')}

### Op timings (ms)
${opTimings.map(t => `${t.tab}/${t.op}: ${t.ms}ms ${t.ok ? '' : '[FAIL: ' + t.error + ']'}`).join('\n')}

Critique this run.`
  const raw = await callAnthropic(SONNET, CRITIC_SYS, userMsg, 2000)
  try { return JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')) }
  catch { return { overall: 0, summary: 'Critic returned unparsable JSON: ' + raw.slice(0, 200), missed: [], wrong: [], praise: [], scores: {} } }
}

export async function runNarrative(narrative, opts = {}) {
  console.log('[quality:nar]', narrative.id, '— starting (native tool-use)')
  const t0 = Date.now()
  const ctx = await ensureSimWorkspace(`nar:${narrative.id}`)
  const runId = opts.runId || null
  const transcript = []          // for /logs display
  const apiMessages = []         // Anthropic messages array (with tool_use/tool_result blocks)
  const allOpResults = []
  const turnTimings = []         // for Mode-A measurement: ms from user msg → first op

  for (const userMsg of narrative.turns) {
    transcript.push({ role: 'user', text: userMsg })
    apiMessages.push({ role: 'user', content: userMsg })
    const turnStart = Date.now()
    const { reply, ops } = await runOneTurn(apiMessages, ctx)
    // Post-turn reflection — catches named objects the primary pass dropped.
    const reflectiveOps = await reflectTurn(userMsg, ops, ctx)
    const allTurnOps = reflectiveOps.length ? [...ops, ...reflectiveOps] : ops
    turnTimings.push({
      user_msg: userMsg.slice(0, 60),
      ops_count: ops.length,
      reflective_ops_count: reflectiveOps.length,
      ms_to_reply: Date.now() - turnStart,
      ops_called: allTurnOps.map(o => `${o.tab}/${o.op}${o.reflective ? ' (reflect)' : ''}`)
    })
    apiMessages.push({ role: 'assistant', content: reply })  // simplified — drops tool blocks but keeps the natural reply for next turn
    allOpResults.push(...allTurnOps)
    transcript.push({ role: 'claude', text: reply, ops: allTurnOps })
  }

  const [{ data: mem }, { data: org }, { data: dia }] = await Promise.all([
    sb.from('memory_notes').select('filename, structured').eq('workspace_id', ctx.workspaceId),
    sb.from('org_memory_notes').select('filename, structured').eq('org_id', ctx.orgId),
    sb.from('diagram_views').select('view_key, structured').eq('workspace_id', ctx.workspaceId)
  ])
  const finalState = {}
  for (const r of mem || []) if (r.structured) finalState['memory:' + r.filename] = r.structured
  for (const r of org || []) if (r.structured) finalState['org:' + r.filename] = r.structured
  for (const r of dia || []) if (r.structured) finalState['diagram:' + r.view_key] = r.structured

  const crit = await critique(narrative, transcript, finalState, allOpResults)
  // Deterministic fidelity diff — embedding-based "did we capture what the
  // user said?" score. Stable across runs (the critic's score isn't).
  let fidelity = null
  try {
    const { computeFidelity } = await import('./fidelity.js')
    fidelity = await computeFidelity(narrative, finalState)
  } catch (err) {
    console.warn('[quality:nar] fidelity compute failed (non-fatal):', err.message)
  }
  const totalMs = Date.now() - t0

  const { data: simRow } = await sb.from('quality_simulations').insert({
    workspace_id: ctx.workspaceId,
    transcript: { narrative_id: narrative.id, narrative_title: narrative.title, turns: transcript, turn_timings: turnTimings },
    ops_applied: allOpResults, final_state: finalState,
    critique: crit, total_duration_ms: totalMs,
    overall_score: crit.overall || null,
    run_id: runId,
    fidelity_score: fidelity?.percent ?? null,
    fidelity_detail: fidelity || null
  }).select('id').single()

  // Auto-promote critic findings into candidate eval cases for review.
  // Each "missed" or "wrong" item becomes a candidate row — David triages
  // in the morning; accepted ones become permanent eval cases.
  const candidates = []
  for (const m of crit.missed || []) candidates.push({
    source_simulation_id: simRow?.id || null, category: 'missed',
    finding_text: m, suggested_input: null, expected_op: null, expected_tab: null,
    run_id: runId
  })
  for (const w of crit.wrong || []) candidates.push({
    source_simulation_id: simRow?.id || null, category: 'wrong',
    finding_text: w, suggested_input: null, expected_op: null, expected_tab: null,
    run_id: runId
  })
  if (candidates.length) await sb.from('quality_candidate_evals').insert(candidates)

  const fidStr = fidelity?.percent != null ? ` · fidelity ${fidelity.percent}%` : ''
  console.log(`[quality:nar] ${narrative.id} — ${crit.overall}/5${fidStr} in ${totalMs}ms (filed ${candidates.length} candidate eval(s))`)
  return {
    narrative_id: narrative.id,
    score: crit.overall,
    fidelity: fidelity?.percent ?? null,
    totalMs,
    candidates: candidates.length
  }
}

// Delete per-sim QA orgs older than N days (and everything under them).
// Each narrative run now creates its own org; this keeps accumulation bounded.
// Matches on slug prefix `qa-sim-` (new-style, per-narrative) plus the legacy
// shared org slug `delma-qa-sim` for anything lingering from pre-refactor.
export async function cleanupOldQaWorkspaces(daysOld = 3) {
  const cutoff = new Date(Date.now() - daysOld * 86400 * 1000).toISOString()
  const { data: orgs } = await sb.from('organizations')
    .select('id, slug, name')
    .or('slug.like.qa-sim-%,slug.eq.delma-qa-sim')
    .lt('created_at', cutoff)
  if (!orgs?.length) return { deleted_orgs: 0, deleted_workspaces: 0 }

  const orgIds = orgs.map(o => o.id)
  const { data: wss } = await sb.from('workspaces').select('id').in('org_id', orgIds)
  const wsIds = (wss || []).map(w => w.id)

  if (wsIds.length) {
    await sb.from('memory_notes').delete().in('workspace_id', wsIds)
    await sb.from('diagram_views').delete().in('workspace_id', wsIds)
    await sb.from('history_snapshots').delete().in('workspace_id', wsIds)
    await sb.from('mcp_call_logs').delete().in('workspace_id', wsIds)
    await sb.from('api_op_logs').delete().in('workspace_id', wsIds)
    await sb.from('quality_router_calls').delete().in('workspace_id', wsIds)
    await sb.from('workspace_members').delete().in('workspace_id', wsIds)
    await sb.from('workspaces').delete().in('id', wsIds)
  }
  // Org-level tabs + members, then the org itself
  await sb.from('org_memory_notes').delete().in('org_id', orgIds)
  await sb.from('org_members').delete().in('org_id', orgIds)
  await sb.from('organizations').delete().in('id', orgIds)

  console.log('[quality:nar] cleanup —', orgIds.length, 'stale QA orgs deleted (with', wsIds.length, 'workspaces)')
  return { deleted_orgs: orgIds.length, deleted_workspaces: wsIds.length }
}

// Run all (or one specific) narrative
export async function runAllNarratives(opts = {}) {
  // Cleanup BEFORE so the morning view isn't polluted by yesterday's 3 sims
  // worth of dead workspaces.
  try { await cleanupOldQaWorkspaces(3) }
  catch (err) { console.warn('[quality:nar] cleanup failed (non-fatal):', err.message) }

  const out = []
  for (const n of NARRATIVES) {
    try { out.push(await runNarrative(n, { runId: opts.runId })) }
    catch (err) { console.error('[quality:nar] failed', n.id, err.message); out.push({ narrative_id: n.id, error: err.message }) }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAllNarratives().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
}
