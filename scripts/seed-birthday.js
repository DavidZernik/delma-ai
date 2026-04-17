import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { applyOpsToTab } from '../server/lib/apply-op.js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const WS = 'a1b2c3d4-0000-0000-0000-000000000001'
const ORG = '58e43330-c76c-474c-b89e-7a2d606a4a61'
const USER = 'dab61e85-4a99-4641-9b2d-957b12843f0a'

async function run(scope, ops) {
  try {
    const r = await applyOpsToTab(sb, scope, ops)
    console.log(`  ✓ ${scope.filename} — ${r.applied.length} applied, ${r.errors.length} errors`)
    if (r.errors.length) r.errors.forEach(e => console.log(`    err: ${e.msg}`))
  } catch (e) { console.log(`  ✗ ${scope.filename}: ${e.message}`) }
}

const org = (filename) => ({ kind: 'org', orgId: ORG, userId: USER, filename })
const mem = (filename) => ({ kind: 'project', workspaceId: WS, userId: USER, filename })
const dia = (filename) => ({ kind: 'diagram', workspaceId: WS, userId: USER, filename })

console.log('Seeding Birthday Campaign into Delma...\n')

// People
console.log('People:')
await run(org('people.md'), [
  { op: 'add_person', args: { name: 'Keyona Abbott', role: 'Manager / PM', kind: 'manager' } },
  { op: 'add_person', args: { name: 'David Zernik', role: 'SFMC Architect', kind: 'person', reports_to: 'Keyona Abbott' } }
])

// Decisions
console.log('Decisions:')
await run(mem('decisions.md'), [
  { op: 'add_decision', args: { text: 'Cancer removed from quiz flow — not appropriate for lead nurture', owner: 'Keyona Abbott' } },
  { op: 'add_decision', args: { text: 'Use API Event entry source for follow-up journey (DEAudience does not support recurring polling)', owner: 'David Zernik' } },
  { op: 'add_decision', args: { text: '48-hour wait steps between follow-up emails (currently 5 min for testing)', owner: 'David Zernik' } },
  { op: 'add_decision', args: { text: 'ProcessedFlag pattern: SFMC SQL marks rows Y after Fire Event step', owner: 'David Zernik' } },
  { op: 'add_action', args: { text: 'Switch Birthday_Daily_Filter SQL to point at production ENT.All_Patients_Opted_In', owner: 'David Zernik' } },
  { op: 'add_action', args: { text: 'Change follow-up journey wait steps from 5 min to 48 hours before go-live', owner: 'David Zernik' } },
  { op: 'add_action', args: { text: 'Activate Birthday_Daily_Send_Refresh automation on schedule (10 AM CT)', owner: 'David Zernik' } },
  { op: 'add_action', args: { text: 'Soft launch: start with LastName LIKE A%, expand daily', owner: 'David Zernik' } }
])

// Environment
console.log('Environment:')
await run(mem('environment.md'), [
  { op: 'set_environment_key', args: { key: 'Source_DE', value: 'ENT.All_Patients_Opted_In', note: 'Shared DE, key A5BD1930-82C8-48EE-9353-A33F3E095594' } },
  { op: 'set_environment_key', args: { key: 'Birthday_Daily_Send_DE', value: 'birthday-daily-send-1775856643368', note: 'Sendable DE, rebuilt daily, journey entry source' } },
  { op: 'set_environment_key', args: { key: 'Quiz_Responses_DE', value: 'birthday_quiz_responses', note: 'Key 0C53F1BE-0AAB-4F7D-83C6-C743CAF1F1A8, folder JOURNEYS' } },
  { op: 'set_environment_key', args: { key: 'Birthday_Email_Asset', value: 'brand_all_hbd_2026', note: 'Asset ID 264938, Content Builder > Journeys > Brand' } },
  { op: 'set_environment_key', args: { key: 'CloudPage_ID', value: '8085', note: 'Asset ID 264940, live URL mcvxtx2z6j...pub.sfmc-content.com' } },
  { op: 'set_environment_key', args: { key: 'Daily_Filter_Query_ID', value: 'cbb76dd1-0bfd-4bbc-a05d-5b91e6984c43', note: 'Birthday_Daily_Filter in Automation Studio' } },
  { op: 'set_environment_key', args: { key: 'Daily_Send_Automation_ID', value: '11515afe-c5c3-4b6e-8005-f7e8c8a50a45', note: 'Birthday_Daily_Send_Refresh, daily 5 AM CT, NOT activated' } },
  { op: 'set_environment_key', args: { key: 'Followup_Journey_ID', value: 'cb195f60-a163-4a5b-b4cc-2ecb6a62c485', note: 'Birthday Quiz Follow-Up, 3 branches, published v1' } },
  { op: 'set_environment_key', args: { key: 'Main_Journey_ID', value: 'd53b5e04-ec9a-4526-b05e-8b8bd0b6e746', note: 'Birthday Daily Email, published v1' } },
  { op: 'set_environment_key', args: { key: 'Event_Def_Key', value: 'ContactEvent-d3c7ed48-1809-303f-c8cf-c3fc8b6844e4', note: 'Fire Event API entry for Birthday_Daily_Send' } }
])

// Playbook
console.log('Playbook:')
await run(org('playbook.md'), [
  { op: 'add_playbook_rule', args: { text: 'Use ENT. prefix for shared DEs in SFMC SQL queries', section: 'SFMC' } },
  { op: 'add_playbook_rule', args: { text: 'Source DE (All_Patients_Opted_In) is already filtered to opted-in — no separate opt-out check needed', section: 'Birthday Campaign' } },
  { op: 'add_playbook_rule', args: { text: 'ProcessedFlag pattern: SQL overwrites rows with ProcessedFlag=Y after Fire Event to prevent reprocessing', section: 'SFMC' } },
  { op: 'add_playbook_rule', args: { text: 'Sendable DEs must have SendableSubscriberField = Subscriber Key to appear in Journey Builder entry picker', section: 'SFMC' } }
])

// Architecture
console.log('Architecture:')
await run(dia('architecture'), [
  { op: 'add_node', args: { id: 'source_de', label: 'All_Patients_Opted_In', kind: 'deSource', note: 'Shared DE from Health Cloud', layer: 'patient_source' } },
  { op: 'add_node', args: { id: 'daily_filter', label: 'Birthday_Daily_Filter', kind: 'sql', note: 'Finds todays birthdays', layer: 'daily_trigger' } },
  { op: 'add_node', args: { id: 'daily_send_de', label: 'Birthday_Daily_Send', kind: 'de', note: 'Sendable DE, rebuilt daily', layer: 'daily_trigger' } },
  { op: 'add_node', args: { id: 'daily_auto', label: 'Birthday_Daily_Send_Refresh', kind: 'automation', note: '5 AM CT daily', layer: 'daily_trigger' } },
  { op: 'add_node', args: { id: 'main_journey', label: 'Birthday Daily Email', kind: 'journey', note: 'Sends birthday email' } },
  { op: 'add_node', args: { id: 'bday_email', label: 'brand_all_hbd_2026', kind: 'email', note: 'Birthday email with quiz buttons' } },
  { op: 'add_node', args: { id: 'quiz_page', label: 'Birthday Quiz CloudPage', kind: 'cloudpage', note: 'Page ID 8085, saves response' } },
  { op: 'add_node', args: { id: 'quiz_responses', label: 'birthday_quiz_responses', kind: 'de', note: 'Stores quiz answers + ProcessedFlag' } },
  { op: 'add_node', args: { id: 'followup_journey', label: 'Birthday Quiz Follow-Up', kind: 'journey', note: 'Decision split: HV / WS / General' } },
  { op: 'add_node', args: { id: 'decision_split', label: 'Quiz Result Router', kind: 'decision', note: 'heart→HV, womens→WS, else→General' } },
  { op: 'add_layer', args: { id: 'patient_source', title: 'Patient Source' } },
  { op: 'add_layer', args: { id: 'daily_trigger', title: 'Daily Trigger & Filter' } },
  { op: 'add_edge', args: { from: 'source_de', to: 'daily_filter', label: 'queried daily' } },
  { op: 'add_edge', args: { from: 'daily_filter', to: 'daily_send_de', label: 'overwrites' } },
  { op: 'add_edge', args: { from: 'daily_auto', to: 'daily_filter', label: 'runs' } },
  { op: 'add_edge', args: { from: 'daily_send_de', to: 'main_journey', label: 'entry source' } },
  { op: 'add_edge', args: { from: 'main_journey', to: 'bday_email', label: 'sends' } },
  { op: 'add_edge', args: { from: 'bday_email', to: 'quiz_page', label: 'quiz link' } },
  { op: 'add_edge', args: { from: 'quiz_page', to: 'quiz_responses', label: 'saves response' } },
  { op: 'add_edge', args: { from: 'quiz_responses', to: 'followup_journey', label: 'triggers via API Event' } },
  { op: 'add_edge', args: { from: 'followup_journey', to: 'decision_split', label: 'routes by ResultPath' } }
])

console.log('\nDone! Refresh localhost:5173 to see the populated tabs.')
