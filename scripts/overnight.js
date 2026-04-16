// Fire the full overnight quality pipeline on prod, return immediately.
//
//   npm run overnight              → fires prod, watch https://delma-ai.onrender.com/logs
//   npm run overnight -- --watch   → also polls progress and exits when done
//
// The prod server runs the job in the background and writes results to
// Supabase. The /logs page renders those rows, so refreshing it shows
// scores as narratives complete.

import { config } from 'dotenv'
config({ override: true })

const PROD_URL = process.env.DELMA_PROD_URL || 'https://delma-ai.onrender.com'
const RENDER_API_KEY = process.env.RENDER_API_KEY
const SERVICE_ID = process.env.DELMA_RENDER_SERVICE_ID || 'srv-d74o4thr0fns73d2cvv0'
const OWNER_ID = process.env.DELMA_RENDER_OWNER_ID || 'tea-d0mdjtbe5dus738ebea0'

const watch = process.argv.includes('--watch')

async function fire() {
  const url = `${PROD_URL}/quality/run-overnight`
  console.log(`Firing: POST ${url}`)
  const res = await fetch(url, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.started) {
    console.error(`Failed: ${res.status}`, body)
    process.exit(1)
  }
  console.log('')
  console.log('🟢 Full pipeline running on prod. ~12-15 min total.')
  console.log('   12 narratives + regression evals + state hygiene + signal mining')
  console.log('')
  console.log('Results page:  ' + PROD_URL + '/logs')
  console.log('')
}

async function pollRenderLogs() {
  if (!RENDER_API_KEY) {
    console.log('(no RENDER_API_KEY in .env — skipping progress watch; results on /logs)')
    return
  }
  console.log('Watching for narrative completions...\n')
  const seen = new Set()
  const start = Date.now()
  const maxMs = 20 * 60 * 1000

  while (Date.now() - start < maxMs) {
    const now = new Date().toISOString()
    const since = new Date(Date.now() - 25 * 60 * 1000).toISOString()
    const params = new URLSearchParams({
      ownerId: OWNER_ID,
      resource: SERVICE_ID,
      startTime: since,
      endTime: now,
      direction: 'forward',
      limit: '300'
    })
    const r = await fetch(`https://api.render.com/v1/logs?${params}`, {
      headers: { Authorization: `Bearer ${RENDER_API_KEY}` }
    })
    const data = await r.json().catch(() => ({}))
    for (const l of data.logs || []) {
      const msg = (l.message || '').replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
      const scored = msg.match(/\[quality:nar\] (\S+) — (\d)\/5 in (\d+)ms/)
      if (scored && !seen.has(scored[1])) {
        seen.add(scored[1])
        console.log(`  ${scored[2]}/5  ${scored[1].padEnd(30)} ${Math.round(scored[3] / 1000)}s`)
      }
      if (msg.includes('overnight done') && !seen.has('__done__')) {
        seen.add('__done__')
        const elapsed = Math.round((Date.now() - start) / 1000)
        console.log(`\n✅ Pipeline complete (${elapsed}s). Full results: ${PROD_URL}/logs`)
        return
      }
    }
    await new Promise(r => setTimeout(r, 20_000))
  }
  console.log('\n(watch timed out after 20 min — check /logs for final results)')
}

await fire()
if (watch) await pollRenderLogs()
