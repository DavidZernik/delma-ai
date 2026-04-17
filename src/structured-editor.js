// Structured form editors for the five memory tabs. Replaces the raw
// markdown editor (which is preserved as a "Raw" toggle) with table/list
// UIs that map directly onto the typed-op layer.
//
// Each editor renders into a host element and posts ops to /api/op. After
// each successful op, Realtime pushes the change back to all clients.
//
// The supabase client is passed in (not imported) so this module stays
// dependency-light and trivially mockable.

import { isStructuredTab } from './tab-ops.js'

// ── Generic helpers ─────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v
    else if (k === 'on') for (const [evt, fn] of Object.entries(v)) e.addEventListener(evt, fn)
    else if (k in e) e[k] = v
    else e.setAttribute(k, v)
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c == null || c === false) continue
    e.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return e
}

async function postOp(authHeaders, ctx, tabKey, op, args) {
  const res = await fetch('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({
      tabKey, ops: [{ op, args }],
      projectId: ctx.projectId, orgId: ctx.orgId
    })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `op failed (${res.status})`)
  }
  return res.json()
}

function makeOpRunner(host, authHeaders, ctx, tabKey, onAfter) {
  return async (op, args) => {
    const status = host.querySelector('.struct-status')
    if (status) { status.textContent = 'Saving…'; status.className = 'struct-status pending' }
    try {
      await postOp(authHeaders, ctx, tabKey, op, args)
      if (status) { status.textContent = 'Saved'; status.className = 'struct-status ok' }
      // Realtime will refresh data; onAfter is for any local extras.
      onAfter && onAfter()
    } catch (err) {
      console.error('[structured-editor] op failed:', err)
      if (status) { status.textContent = err.message; status.className = 'struct-status err' }
    }
  }
}

// ── Per-tab editors ─────────────────────────────────────────────────────

function renderPeopleEditor(host, data, run) {
  const people = data.people || []
  const kinds = ['person', 'manager', 'stakeholder', 'team', 'vendor']

  const tbody = el('tbody')
  for (const p of people) {
    tbody.append(el('tr', {}, [
      el('td', {}, [el('input', {
        class: 'struct-input', value: p.name || '',
        on: { blur: (e) => { /* name edits not exposed as an op yet — skip */ } }
      })]),
      el('td', {}, [el('input', {
        class: 'struct-input', value: p.role || '', placeholder: 'role',
        on: { blur: (e) => {
          const newRole = e.target.value.trim()
          if (newRole !== (p.role || '')) run('set_role', { person: p.name, role: newRole })
        } }
      })]),
      el('td', {}, [(() => {
        const sel = el('select', { class: 'struct-input' })
        for (const k of kinds) sel.append(el('option', { value: k, selected: p.kind === k, textContent: k }))
        // No set_kind op for People yet — kind is set on add. Disable to signal that.
        sel.disabled = true; sel.title = 'Kind is set on add. Remove + re-add to change.'
        return sel
      })()]),
      el('td', {}, [(() => {
        const sel = el('select', {
          class: 'struct-input',
          on: { change: (e) => {
            const mgrName = e.target.value
            if (mgrName) run('set_manager', { person: p.name, manager: mgrName })
            else run('remove_reporting_line', { from: p.name, to: managerNameFromId(people, p.reports_to?.[0]) })
          } }
        })
        sel.append(el('option', { value: '', textContent: '— none —' }))
        for (const m of people) {
          if (m.id === p.id) continue
          const isMgr = (p.reports_to || []).includes(m.id)
          sel.append(el('option', { value: m.name, selected: isMgr, textContent: m.name }))
        }
        return sel
      })()]),
      el('td', { class: 'struct-cell-action' }, [el('button', {
        class: 'struct-btn-x', textContent: '×', title: 'Remove person',
        on: { click: () => { if (confirm(`Remove ${p.name}?`)) run('remove_person', { name: p.name }) } }
      })])
    ]))
  }

  // New row inputs
  const newName = el('input', { class: 'struct-input', placeholder: 'Name' })
  const newRole = el('input', { class: 'struct-input', placeholder: 'Role' })
  const newKind = el('select', { class: 'struct-input' })
  for (const k of kinds) newKind.append(el('option', { value: k, textContent: k }))
  const newMgr = el('select', { class: 'struct-input' })
  newMgr.append(el('option', { value: '', textContent: '— no manager —' }))
  for (const m of people) newMgr.append(el('option', { value: m.name, textContent: m.name }))
  const addBtn = el('button', {
    class: 'struct-btn-add', textContent: '+ Add Person',
    on: { click: () => {
      const args = { name: newName.value.trim(), role: newRole.value.trim() || undefined, kind: newKind.value }
      if (newMgr.value) args.reports_to = newMgr.value
      if (!args.name) { alert('Name is required'); return }
      run('add_person', args).then(() => { newName.value = ''; newRole.value = '' })
    } }
  })

  host.replaceChildren(
    el('table', { class: 'struct-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { textContent: 'Name' }),
        el('th', { textContent: 'Role' }),
        el('th', { textContent: 'Kind' }),
        el('th', { textContent: 'Reports to' }),
        el('th', {})
      ])]),
      tbody,
      el('tfoot', {}, [el('tr', {}, [
        el('td', {}, [newName]),
        el('td', {}, [newRole]),
        el('td', {}, [newKind]),
        el('td', {}, [newMgr]),
        el('td', {}, [addBtn])
      ])])
    ]),
    el('div', { class: 'struct-status' })
  )
}

function managerNameFromId(people, id) {
  return id ? (people.find(p => p.id === id)?.name || '') : ''
}

function renderDecisionsEditor(host, data, run) {
  const decisions = data.decisions || []
  const actions = data.actions || []

  const decList = el('ul', { class: 'struct-list' })
  for (const d of decisions) {
    decList.append(el('li', { class: d.superseded_by ? 'struct-superseded' : '' }, [
      el('span', { textContent: d.text }),
      d.owner ? el('span', { class: 'struct-owner', textContent: ` (${d.owner})` }) : null,
      el('button', { class: 'struct-btn-x', textContent: '×',
        on: { click: () => { if (confirm('Remove this decision (no audit trail)?')) run('remove_decision', { id: d.id }) } } })
    ]))
  }
  const newDec = el('input', { class: 'struct-input', placeholder: 'New decision…' })
  const newDecOwner = el('input', { class: 'struct-input struct-input-owner', placeholder: 'Owner (optional)' })
  const addDec = el('button', {
    class: 'struct-btn-add', textContent: '+ Decision',
    on: { click: () => {
      if (!newDec.value.trim()) return
      run('add_decision', { text: newDec.value.trim(), owner: newDecOwner.value.trim() || undefined })
        .then(() => { newDec.value = ''; newDecOwner.value = '' })
    } }
  })

  const actList = el('ul', { class: 'struct-list' })
  for (const a of actions) {
    actList.append(el('li', { class: a.done ? 'struct-done' : '' }, [
      el('input', {
        type: 'checkbox', checked: a.done,
        on: { change: (e) => { if (e.target.checked) run('complete_action', { id: a.id }) } }
      }),
      el('span', { textContent: ` ${a.text}` }),
      a.owner ? el('span', { class: 'struct-owner', textContent: ` (${a.owner})` }) : null,
      a.due ? el('span', { class: 'struct-due', textContent: ` — due ${a.due}` }) : null
    ]))
  }
  const newAct = el('input', { class: 'struct-input', placeholder: 'New action…' })
  const newActOwner = el('input', { class: 'struct-input struct-input-owner', placeholder: 'Owner' })
  const newActDue = el('input', { class: 'struct-input struct-input-owner', placeholder: 'Due' })
  const addAct = el('button', {
    class: 'struct-btn-add', textContent: '+ Action',
    on: { click: () => {
      if (!newAct.value.trim()) return
      run('add_action', { text: newAct.value.trim(), owner: newActOwner.value.trim() || undefined, due: newActDue.value.trim() || undefined })
        .then(() => { newAct.value = ''; newActOwner.value = ''; newActDue.value = '' })
    } }
  })

  host.replaceChildren(
    el('h3', { textContent: 'Decisions' }), decList,
    el('div', { class: 'struct-row' }, [newDec, newDecOwner, addDec]),
    el('h3', { textContent: 'Actions' }), actList,
    el('div', { class: 'struct-row' }, [newAct, newActOwner, newActDue, addAct]),
    el('div', { class: 'struct-status' })
  )
}

function renderEnvironmentEditor(host, data, run) {
  const entries = data.entries || []
  const tbody = el('tbody')
  for (const e of entries) {
    tbody.append(el('tr', {}, [
      el('td', { textContent: e.key, class: 'struct-cell-key' }),
      el('td', {}, [el('input', {
        class: 'struct-input', value: e.value || '',
        on: { blur: (ev) => {
          if (ev.target.value !== e.value) run('set_environment_key', { key: e.key, value: ev.target.value, note: e.note || undefined })
        } }
      })]),
      el('td', {}, [el('input', {
        class: 'struct-input', value: e.note || '', placeholder: 'note',
        on: { blur: (ev) => {
          if (ev.target.value !== (e.note || '')) run('set_environment_key', { key: e.key, value: e.value, note: ev.target.value })
        } }
      })]),
      el('td', { class: 'struct-cell-action' }, [el('button', {
        class: 'struct-btn-x', textContent: '×',
        on: { click: () => { if (confirm(`Remove key "${e.key}"?`)) run('remove_environment_key', { key: e.key }) } }
      })])
    ]))
  }
  const nKey = el('input', { class: 'struct-input', placeholder: 'Key' })
  const nVal = el('input', { class: 'struct-input', placeholder: 'Value' })
  const nNote = el('input', { class: 'struct-input', placeholder: 'Note (optional)' })
  const addBtn = el('button', {
    class: 'struct-btn-add', textContent: '+ Add Entry',
    on: { click: () => {
      if (!nKey.value.trim() || !nVal.value.trim()) { alert('Key and value required'); return }
      run('set_environment_key', { key: nKey.value.trim(), value: nVal.value.trim(), note: nNote.value.trim() || undefined })
        .then(() => { nKey.value = ''; nVal.value = ''; nNote.value = '' })
    } }
  })
  host.replaceChildren(
    el('table', { class: 'struct-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { textContent: 'Key' }),
        el('th', { textContent: 'Value' }),
        el('th', { textContent: 'Note' }),
        el('th', {})
      ])]),
      tbody,
      el('tfoot', {}, [el('tr', {}, [
        el('td', {}, [nKey]), el('td', {}, [nVal]), el('td', {}, [nNote]), el('td', {}, [addBtn])
      ])])
    ]),
    el('div', { class: 'struct-status' })
  )
}

function renderPlaybookEditor(host, data, run) {
  const rules = data.rules || []
  const bySection = {}
  for (const r of rules) {
    const sec = r.section || 'General'
    if (!bySection[sec]) bySection[sec] = []
    bySection[sec].push(r)
  }
  const blocks = []
  for (const [sec, list] of Object.entries(bySection)) {
    const ul = el('ul', { class: 'struct-list' })
    for (const r of list) {
      ul.append(el('li', {}, [
        el('span', { textContent: r.text }),
        el('button', { class: 'struct-btn-x', textContent: '×',
          on: { click: () => { if (confirm('Remove rule?')) run('remove_playbook_rule', { id: r.id }) } } })
      ]))
    }
    blocks.push(el('h3', { textContent: sec }), ul)
  }
  const nText = el('input', { class: 'struct-input', placeholder: 'New rule…' })
  const nSec = el('input', { class: 'struct-input struct-input-owner', placeholder: 'Section (optional)' })
  const addBtn = el('button', {
    class: 'struct-btn-add', textContent: '+ Add Rule',
    on: { click: () => {
      if (!nText.value.trim()) return
      run('add_playbook_rule', { text: nText.value.trim(), section: nSec.value.trim() || undefined })
        .then(() => { nText.value = ''; nSec.value = '' })
    } }
  })
  host.replaceChildren(
    ...blocks,
    el('div', { class: 'struct-row' }, [nText, nSec, addBtn]),
    el('div', { class: 'struct-status' })
  )
}

function renderMyNotesEditor(host, data, run) {
  const ta = el('textarea', { class: 'struct-input struct-textarea', rows: 16, value: data.text || '' })
  const saveBtn = el('button', {
    class: 'struct-btn-add', textContent: 'Save',
    on: { click: () => run('replace_my_notes', { text: ta.value }) }
  })
  host.replaceChildren(ta, el('div', { class: 'struct-row' }, [saveBtn]),
    el('div', { class: 'struct-status' }))
}

const EDITORS = {
  'people.md': renderPeopleEditor,
  'decisions.md': renderDecisionsEditor,
  'environment.md': renderEnvironmentEditor,
  'playbook.md': renderPlaybookEditor,
  'my-notes.md': renderMyNotesEditor
}

// Public API. Returns true if the editor took over, false if the filename
// is not a structured tab and the caller should fall back to markdown.
export function renderStructuredEditor(host, { filename, structured, tabKey, ctx, authHeaders, onAfter }) {
  if (!isStructuredTab(filename) || !EDITORS[filename]) return false
  const run = makeOpRunner(host, authHeaders, ctx, tabKey, onAfter)
  EDITORS[filename](host, structured || {}, run)
  return true
}
