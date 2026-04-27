// "Connections and Passwords" tab — currently the SFMC half. Reads
// `~/.config/sfmc/.env` via /api/config/sfmc and renders one card per
// business unit (child + parent). Each card shows the account's
// identifying fields, masks the client_secret with an eye toggle, and lets
// the user edit + save in place. Writes back through /api/config/sfmc as
// flat env-key/value pairs.
//
// This tab does NOT render CLAUDE.md content — it's intentionally outside
// the project-doc model because credentials belong to the machine, not the
// project. Multiple projects share these creds. Future platforms (CRM,
// HubSpot, Twilio, etc.) plug in as additional sections inside this tab.

import { escapeHtml, escapeAttr } from './util.js'

// The fields each BU card shows, in display order. `key` is the property on
// the loaded account object (lowercase + underscored from local-config.js);
// `envChild` / `envParent` are the env-var names the POST endpoint expects.
// `secret: true` enables the eye-icon mask. `placeholder` is what the input
// hints at when the value is empty.
const FIELDS = [
  { key: 'label',           label: 'Display name',  envChild: 'CHILD_BU_LABEL',          envParent: 'PARENT_BU_LABEL',          placeholder: 'e.g. Emory Marketing BU' },
  { key: 'account_id',      label: 'MID',           envChild: 'ACCOUNT_ID',              envParent: 'PARENT_BU_MID',            placeholder: 'e.g. 7282941' },
  { key: 'client_id',       label: 'Client ID',     envChild: 'CLIENT_ID',               envParent: 'PARENT_BU_CLIENT_ID',      placeholder: 'OAuth installed-package client id' },
  { key: 'client_secret',   label: 'Client secret', envChild: 'CLIENT_SECRET',           envParent: 'PARENT_BU_CLIENT_SECRET',  placeholder: 'OAuth installed-package client secret', secret: true },
  { key: 'auth_base_url',   label: 'Auth URL',      envChild: 'AUTH_BASE_URL',           envParent: 'PARENT_BU_AUTH_BASE_URL',  placeholder: 'https://....auth.marketingcloudapis.com' },
  { key: 'rest_base_url',   label: 'REST URL',      envChild: 'REST_BASE_URL',           envParent: 'PARENT_BU_REST_BASE_URL',  placeholder: 'https://....rest.marketingcloudapis.com' },
  { key: 'soap_base_url',   label: 'SOAP URL',      envChild: 'SOAP_BASE_URL',           envParent: 'PARENT_BU_SOAP_BASE_URL',  placeholder: 'https://....soap.marketingcloudapis.com' }
]

const TIERS = [
  { key: 'child',  label: 'Marketing BU', empty: 'No marketing BU configured yet.' },
  { key: 'parent', label: 'Parent BU',    empty: 'No parent BU configured yet (optional — only needed for cross-BU calls).' }
]

export function initSfmcTab() {
  // Per-tier edit state — independent toggles for child and parent so editing
  // one doesn't blow away input on the other.
  const editing = { child: false, parent: false }
  // Per-tier reveal state for the secret field (eye toggle).
  const revealing = { child: false, parent: false }
  let cached = null

  async function fetchAccounts() {
    const res = await fetch('/api/config/sfmc')
    if (!res.ok) throw new Error(`status ${res.status}`)
    cached = await res.json()
    return cached
  }

  async function render(host) {
    host.innerHTML = `<p class="empty-hint">Loading SFMC connections…</p>`
    let data
    try { data = await fetchAccounts() }
    catch (err) {
      host.innerHTML = `<div class="error-banner">Couldn't load SFMC connections: ${escapeHtml(err.message)}</div>`
      return
    }
    paint(host, data)
  }

  function paint(host, data) {
    const cards = TIERS.map(tier => buildCard(tier, data[tier.key])).join('')
    host.innerHTML = `
      <div class="sfmc-tab">
        <p class="sfmc-intro">Credentials are stored on this machine only and are <strong>never</strong> sent to Claude. Each platform's secrets live in their own file (e.g. <code>~/.config/sfmc/.env</code>) so Delma can use them without ever exposing them to the model.</p>
        <div class="sfmc-platform">
          <div class="sfmc-platform-head">
            <div class="sfmc-platform-title">Salesforce Marketing Cloud</div>
          </div>
          ${cards}
        </div>
      </div>`
    for (const tier of TIERS) wireCard(host, tier, data[tier.key])
  }

  function buildCard(tier, account) {
    const isEdit = editing[tier.key]
    const reveal = revealing[tier.key]
    const present = !!account
    const headerLabel = present ? escapeHtml(account.label || tier.label) : tier.label

    if (!isEdit && !present) {
      // Empty state — show "Add" button instead of fields.
      return `
        <div class="sfmc-card sfmc-card-empty" data-tier="${tier.key}">
          <div class="sfmc-card-head">
            <div class="sfmc-card-title">${escapeHtml(tier.label)}</div>
            <button class="btn-secondary" data-act="edit">Add</button>
          </div>
          <div class="sfmc-card-empty-hint">${escapeHtml(tier.empty)}</div>
        </div>`
    }

    const rows = FIELDS.map(f => {
      const value = (account && account[f.key]) || ''
      if (isEdit) {
        const inputType = f.secret && !reveal ? 'password' : 'text'
        const eyeBtn = f.secret
          ? `<button type="button" class="sfmc-eye" data-act="reveal" title="${reveal ? 'Hide' : 'Show'}">${reveal ? '🙈' : '👁'}</button>`
          : ''
        return `
          <div class="sfmc-row">
            <label class="sfmc-row-label" for="sfmc-${tier.key}-${f.key}">${escapeHtml(f.label)}</label>
            <div class="sfmc-row-input">
              <input id="sfmc-${tier.key}-${f.key}" type="${inputType}" data-field="${f.key}" value="${escapeAttr(value)}" placeholder="${escapeAttr(f.placeholder)}" autocomplete="off" spellcheck="false" />
              ${eyeBtn}
            </div>
          </div>`
      }
      // Read-only display.
      const display = f.secret
        ? (reveal ? value : maskSecret(value))
        : value
      const eyeBtn = f.secret
        ? `<button type="button" class="sfmc-eye" data-act="reveal" title="${reveal ? 'Hide' : 'Show'}">${reveal ? '🙈' : '👁'}</button>`
        : ''
      return `
        <div class="sfmc-row">
          <div class="sfmc-row-label">${escapeHtml(f.label)}</div>
          <div class="sfmc-row-value">
            <span class="sfmc-row-text${f.secret && !reveal ? ' sfmc-row-mask' : ''}">${value ? escapeHtml(display) : '<span class="sfmc-row-empty">—</span>'}</span>
            ${eyeBtn}
          </div>
        </div>`
    }).join('')

    const buttons = isEdit
      ? `<button class="btn-secondary" data-act="cancel">Cancel</button>
         <button class="btn-primary" data-act="save">Save</button>`
      : `<button class="btn-secondary" data-act="edit">Edit</button>`

    return `
      <div class="sfmc-card" data-tier="${tier.key}">
        <div class="sfmc-card-head">
          <div class="sfmc-card-title">${headerLabel}</div>
          <div class="sfmc-card-actions">${buttons}</div>
        </div>
        <div class="sfmc-card-body">${rows}</div>
        <div class="sfmc-card-status" data-status></div>
      </div>`
  }

  function maskSecret(s) {
    if (!s) return ''
    if (s.length <= 8) return '•'.repeat(s.length)
    return s.slice(0, 4) + '•'.repeat(Math.min(s.length - 8, 24)) + s.slice(-4)
  }

  function wireCard(host, tier, account) {
    const card = host.querySelector(`.sfmc-card[data-tier="${tier.key}"]`)
    if (!card) return

    card.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
      editing[tier.key] = true
      paint(host, cached)
    })
    card.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      editing[tier.key] = false
      paint(host, cached)
    })
    card.querySelector('[data-act="reveal"]')?.addEventListener('click', () => {
      revealing[tier.key] = !revealing[tier.key]
      paint(host, cached)
    })

    const saveBtn = card.querySelector('[data-act="save"]')
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const status = card.querySelector('[data-status]')
        const inputs = card.querySelectorAll('input[data-field]')
        const flat = {}
        for (const inp of inputs) {
          const f = FIELDS.find(x => x.key === inp.dataset.field)
          if (!f) continue
          const envName = tier.key === 'child' ? f.envChild : f.envParent
          flat[envName] = inp.value
        }
        status.textContent = 'Saving…'
        saveBtn.disabled = true
        try {
          const res = await fetch('/api/config/sfmc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(flat)
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || `status ${res.status}`)
          editing[tier.key] = false
          await fetchAccounts()
          paint(host, cached)
        } catch (err) {
          status.textContent = `Save failed: ${err.message}`
          saveBtn.disabled = false
        }
      })
    }
  }

  return { render }
}
