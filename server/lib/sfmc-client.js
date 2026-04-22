// Internal SFMC client — ported from the proven patterns in
// all-salesforce-projects/calendar-project/scripts. No third-party SDKs:
// every Salesforce-branded SFMC Node library (fuel-soap, sfmc-fuelsdk-node)
// is unmaintained or archived. This module is our own thin layer.
//
// Pure: no Supabase access, no MCP awareness. Callers pass an `account`
// object (decrypted creds from sfmc-account.js) plus op-specific args.
// Return shape is always `{ ok: true, ...result }` or
// `{ ok: false, code, message, raw? }`. Never throws on SFMC errors; only
// throws on programmer errors (missing args, bad account object).

// Token cache keyed by client_id — one SFMC app, one cached token.
// Buffer of 60s before expiry so we refresh just ahead of the cliff.
const tokenCache = new Map()

async function getToken(account) {
  if (!account?.client_id || !account?.client_secret || !account?.auth_base_url) {
    throw new Error('sfmc-client: account missing client_id / client_secret / auth_base_url')
  }
  const key = account.client_id
  const now = Date.now()
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const body = {
    grant_type: 'client_credentials',
    client_id: account.client_id,
    client_secret: account.client_secret
  }
  // account_id is optional — only needed when the installed package has
  // access to multiple BUs and you want to mint a token for a specific MID.
  if (account.account_id) body.account_id = account.account_id

  const res = await fetch(`${account.auth_base_url}/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`sfmc-client: auth failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = JSON.parse(text)
  const expiresInMs = (data.expires_in || 1080) * 1000
  tokenCache.set(key, { token: data.access_token, expiresAt: now + expiresInMs })
  return data.access_token
}

// ── SOAP ───────────────────────────────────────────────────────────────────
// Used for DE create/retrieve/update/delete. SFMC accepts the action in the
// envelope header (`<a:Action>`) rather than the SOAPAction HTTP header.

function buildSoapEnvelope(action, bodyXml, token) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  <s:Header>
    <a:Action s:mustUnderstand="1">${action}</a:Action>
    <a:To s:mustUnderstand="1">__SOAP_URL__</a:To>
    <fueloauth xmlns="http://exacttarget.com">${token}</fueloauth>
  </s:Header>
  <s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xmlns:xsd="http://www.w3.org/2001/XMLSchema">
${bodyXml}
  </s:Body>
</s:Envelope>`
}

async function soapRequest(account, action, bodyXml) {
  if (!account?.soap_base_url) throw new Error('sfmc-client: account missing soap_base_url')
  const token = await getToken(account)
  const soapUrl = `${account.soap_base_url}/Service.asmx`
  const envelope = buildSoapEnvelope(action, bodyXml, token).replace('__SOAP_URL__', soapUrl)
  const res = await fetch(soapUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    body: envelope
  })
  const text = await res.text()
  return { httpOk: res.ok, status: res.status, text }
}

// SFMC SOAP replies embed <OverallStatus> at the top and, on Create / Update /
// Delete, per-object <Results><StatusCode>. Retrieve responses skip StatusCode
// entirely — they just have OverallStatus. So success = OverallStatus OK + no
// fault + (if StatusCode is present at all, it must also be OK). Regex rather
// than XML parse: the response shape is narrow and this matches the existing
// codebase style.
function parseSoapResult(xml) {
  const overall = xml.match(/<OverallStatus>([^<]+)<\/OverallStatus>/)?.[1] || ''
  const status = xml.match(/<StatusCode>([^<]+)<\/StatusCode>/)?.[1] || ''
  const msg = xml.match(/<StatusMessage>([^<]+)<\/StatusMessage>/)?.[1] || ''
  const fault = xml.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i)?.[1] || ''
  const statusOk = status === '' || status === 'OK'
  const ok = overall === 'OK' && statusOk && !fault
  return { ok, overall, statusCode: status, message: msg || fault || '', raw: xml }
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ── REST ───────────────────────────────────────────────────────────────────
// Used for automations, query activities, DE row CRUD, asset CRUD.

async function restRequest(account, method, path, body) {
  if (!account?.rest_base_url) throw new Error('sfmc-client: account missing rest_base_url')
  const token = await getToken(account)
  const url = path.startsWith('http') ? path : `${account.rest_base_url}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON 204 etc. */ }
  return { httpOk: res.ok, status: res.status, data, text }
}

// ── Data Extension: create ────────────────────────────────────────────────

const FIELD_TYPE_ALLOWED = new Set([
  'Text', 'Number', 'Date', 'Boolean', 'EmailAddress', 'Phone', 'Decimal', 'Locale'
])

function renderField(f) {
  if (!f?.name) throw new Error('sfmc-client: every field needs a `name`')
  const type = f.type || 'Text'
  if (!FIELD_TYPE_ALLOWED.has(type)) {
    throw new Error(`sfmc-client: invalid field type "${type}" (allowed: ${[...FIELD_TYPE_ALLOWED].join(', ')})`)
  }
  const parts = [
    `<CustomerKey>${escapeXml(f.customerKey || f.name)}</CustomerKey>`,
    `<Name>${escapeXml(f.name)}</Name>`,
    `<FieldType>${type}</FieldType>`
  ]
  if (f.length && (type === 'Text' || type === 'EmailAddress' || type === 'Phone')) {
    parts.push(`<MaxLength>${f.length}</MaxLength>`)
  }
  if (f.scale !== undefined && type === 'Decimal') {
    parts.push(`<Scale>${f.scale}</Scale>`)
  }
  if (f.isPrimaryKey) parts.push(`<IsPrimaryKey>true</IsPrimaryKey>`)
  if (f.isRequired) parts.push(`<IsRequired>true</IsRequired>`)
  if (f.isNillable === false || f.isPrimaryKey) parts.push(`<IsNillable>false</IsNillable>`)
  if (f.defaultValue !== undefined && f.defaultValue !== null) {
    parts.push(`<DefaultValue>${escapeXml(f.defaultValue)}</DefaultValue>`)
  }
  return `        <Field>\n          ${parts.join('\n          ')}\n        </Field>`
}

export async function createDataExtension(account, { name, customerKey, description, fields, sendable, sendableSubscriberField, retentionDays, folderId }) {
  if (!name || !Array.isArray(fields) || !fields.length) {
    throw new Error('sfmc-client.createDataExtension: need name + non-empty fields[]')
  }
  const key = customerKey || name
  const fieldsXml = fields.map(renderField).join('\n')
  const sendableXml = sendable
    ? `<IsSendable>true</IsSendable>
      <SendableDataExtensionField>
        <CustomerKey>${escapeXml(sendableSubscriberField || 'SubscriberKey')}</CustomerKey>
        <Name>${escapeXml(sendableSubscriberField || 'SubscriberKey')}</Name>
      </SendableDataExtensionField>
      <SendableSubscriberField>
        <Name>Subscriber Key</Name>
      </SendableSubscriberField>`
    : `<IsSendable>false</IsSendable>`
  const folderXml = folderId ? `<CategoryID>${folderId}</CategoryID>` : ''
  const descXml = description ? `<Description>${escapeXml(description)}</Description>` : ''
  const retentionXml = retentionDays
    ? `<DataRetentionPeriodLength>${retentionDays}</DataRetentionPeriodLength>
       <DataRetentionPeriod>Days</DataRetentionPeriod>
       <RowBasedRetention>false</RowBasedRetention>
       <ResetRetentionPeriodOnImport>false</ResetRetentionPeriodOnImport>
       <DeleteAtEndOfRetentionPeriod>true</DeleteAtEndOfRetentionPeriod>`
    : ''
  const body = `    <CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <Objects xsi:type="DataExtension">
        <CustomerKey>${escapeXml(key)}</CustomerKey>
        <Name>${escapeXml(name)}</Name>
        ${descXml}
        ${folderXml}
        ${sendableXml}
        ${retentionXml}
        <Fields>
${fieldsXml}
        </Fields>
      </Objects>
    </CreateRequest>`
  const { text } = await soapRequest(account, 'Create', body)
  const parsed = parseSoapResult(text)
  if (!parsed.ok) {
    return { ok: false, code: parsed.statusCode || 'soap_error', message: parsed.message, raw: text }
  }
  const deId = text.match(/<NewID>([^<]+)<\/NewID>/)?.[1] || text.match(/<ObjectID>([^<]+)<\/ObjectID>/)?.[1] || null
  return { ok: true, customerKey: key, name, deId }
}

// ── Data Extension: list + get ────────────────────────────────────────────

export async function listDataExtensions(account, { namePattern, folderId, limit = 50 } = {}) {
  const filterXml = namePattern
    ? `<Filter xsi:type="SimpleFilterPart">
         <Property>Name</Property>
         <SimpleOperator>like</SimpleOperator>
         <Value>${escapeXml(namePattern)}</Value>
       </Filter>`
    : folderId
      ? `<Filter xsi:type="SimpleFilterPart">
           <Property>CategoryID</Property>
           <SimpleOperator>equals</SimpleOperator>
           <Value>${folderId}</Value>
         </Filter>`
      : ''
  const body = `    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>DataExtension</ObjectType>
        <Properties>CustomerKey</Properties>
        <Properties>Name</Properties>
        <Properties>Description</Properties>
        <Properties>IsSendable</Properties>
        <Properties>CategoryID</Properties>
        <Properties>ObjectID</Properties>
        ${filterXml}
      </RetrieveRequest>
    </RetrieveRequestMsg>`
  const { text } = await soapRequest(account, 'Retrieve', body)
  const parsed = parseSoapResult(text)
  if (!parsed.ok && parsed.statusCode !== 'MoreDataAvailable') {
    return { ok: false, code: parsed.statusCode || 'soap_error', message: parsed.message, raw: text }
  }
  const results = []
  const regex = /<Results[^>]*>([\s\S]*?)<\/Results>/g
  let match
  while ((match = regex.exec(text))) {
    const chunk = match[1]
    results.push({
      customerKey: chunk.match(/<CustomerKey>([^<]+)<\/CustomerKey>/)?.[1],
      name: chunk.match(/<Name>([^<]+)<\/Name>/)?.[1],
      description: chunk.match(/<Description>([^<]*)<\/Description>/)?.[1] || '',
      objectId: chunk.match(/<ObjectID>([^<]+)<\/ObjectID>/)?.[1],
      folderId: chunk.match(/<CategoryID>([^<]+)<\/CategoryID>/)?.[1],
      sendable: chunk.match(/<IsSendable>([^<]+)<\/IsSendable>/)?.[1] === 'true'
    })
    if (results.length >= limit) break
  }
  return { ok: true, count: results.length, items: results }
}

export async function getDataExtension(account, { customerKey }) {
  if (!customerKey) throw new Error('sfmc-client.getDataExtension: need customerKey')
  // Get DE metadata
  const { ok, items, message, code } = await listDataExtensions(account, { namePattern: customerKey, limit: 5 })
  if (!ok) return { ok: false, code, message }
  const de = items.find(d => d.customerKey === customerKey) || items[0]
  if (!de) return { ok: false, code: 'not_found', message: `No DE with CustomerKey "${customerKey}"` }
  // Get fields via SOAP DataExtensionField retrieve
  const fieldsBody = `    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>DataExtensionField</ObjectType>
        <Properties>Name</Properties>
        <Properties>FieldType</Properties>
        <Properties>MaxLength</Properties>
        <Properties>IsPrimaryKey</Properties>
        <Properties>IsRequired</Properties>
        <Filter xsi:type="SimpleFilterPart">
          <Property>DataExtension.CustomerKey</Property>
          <SimpleOperator>equals</SimpleOperator>
          <Value>${escapeXml(customerKey)}</Value>
        </Filter>
      </RetrieveRequest>
    </RetrieveRequestMsg>`
  const { text } = await soapRequest(account, 'Retrieve', fieldsBody)
  const fields = []
  const regex = /<Results[^>]*>([\s\S]*?)<\/Results>/g
  let m
  while ((m = regex.exec(text))) {
    const c = m[1]
    fields.push({
      name: c.match(/<Name>([^<]+)<\/Name>/)?.[1],
      type: c.match(/<FieldType>([^<]+)<\/FieldType>/)?.[1],
      length: Number(c.match(/<MaxLength>([^<]+)<\/MaxLength>/)?.[1]) || null,
      isPrimaryKey: c.match(/<IsPrimaryKey>([^<]+)<\/IsPrimaryKey>/)?.[1] === 'true',
      isRequired: c.match(/<IsRequired>([^<]+)<\/IsRequired>/)?.[1] === 'true'
    })
  }
  return { ok: true, ...de, fields }
}

// ── Data Extension: delete ────────────────────────────────────────────────

export async function deleteDataExtension(account, { customerKey }) {
  if (!customerKey) throw new Error('sfmc-client.deleteDataExtension: need customerKey')
  const body = `    <DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <Objects xsi:type="DataExtension">
        <CustomerKey>${escapeXml(customerKey)}</CustomerKey>
      </Objects>
    </DeleteRequest>`
  const { text } = await soapRequest(account, 'Delete', body)
  const parsed = parseSoapResult(text)
  if (!parsed.ok) {
    return { ok: false, code: parsed.statusCode || 'soap_error', message: parsed.message, raw: text }
  }
  return { ok: true, customerKey }
}

// ── Data Extension: insert rows ───────────────────────────────────────────
// REST path — SFMC's customobjectdata endpoint accepts batched upserts.

export async function insertRows(account, { customerKey, rows }) {
  if (!customerKey || !Array.isArray(rows) || !rows.length) {
    throw new Error('sfmc-client.insertRows: need customerKey + non-empty rows[]')
  }
  // `/hub/v1/dataevents/.../rowset` takes a bare array of row objects — each
  // row is `{ keys: { SubscriberKey: "..." }, values: { ... } }` for upsert
  // semantics against the DE's primary keys.
  const { httpOk, status, data, text } = await restRequest(
    account, 'POST',
    `/hub/v1/dataevents/key:${encodeURIComponent(customerKey)}/rowset`,
    rows
  )
  if (!httpOk) return { ok: false, code: `http_${status}`, message: data?.message || text.slice(0, 300) }
  return { ok: true, inserted: Array.isArray(data) ? data.length : rows.length }
}

// ── Query Activity ────────────────────────────────────────────────────────
// REST path. Creates a SQL query activity that writes to a target DE.

const QUERY_UPDATE_TYPE = { Overwrite: 0, Append: 1, UpdateAdd: 2, UpdateOnly: 3 }

// Category resolution cache per client_id — SFMC requires a categoryId
// (folder) for query activities but doesn't accept 0 or null. We resolve
// the root Query folder once per process and reuse.
const queryCategoryCache = new Map()

async function resolveQueryCategoryId(account) {
  const cached = queryCategoryCache.get(account.client_id)
  if (cached) return cached
  // SFMC's /email/v1/categories expects `catType` as a plain query param,
  // not a $filter. Returns the folders usable for query activities.
  const { httpOk, data, text, status } = await restRequest(
    account, 'GET',
    `/email/v1/categories?catType=queryactivity&$pagesize=50`
  )
  if (!httpOk) throw new Error(`resolveQueryCategoryId: HTTP ${status} — ${text.slice(0, 200)}`)
  const items = data?.items || data?.results || []
  // Response uses `categoryId` + `parentCatId` (email/v1 naming). Prefer
  // the root folder (lowest parentCatId, often 0), otherwise the first.
  const root = items.slice().sort((a, b) => (a.parentCatId ?? 0) - (b.parentCatId ?? 0))[0]
  const id = root?.categoryId ?? root?.id
  if (!id) throw new Error('resolveQueryCategoryId: no query folders returned')
  queryCategoryCache.set(account.client_id, id)
  return id
}

export async function createQueryActivity(account, { name, key, description, targetDE, sql, updateType = 'Overwrite', categoryId }) {
  if (!name || !targetDE || !sql) {
    throw new Error('sfmc-client.createQueryActivity: need name + targetDE + sql')
  }
  if (!(updateType in QUERY_UPDATE_TYPE)) {
    throw new Error(`sfmc-client: invalid updateType "${updateType}" (allowed: ${Object.keys(QUERY_UPDATE_TYPE).join(', ')})`)
  }
  const resolvedCategoryId = categoryId ?? await resolveQueryCategoryId(account)
  const body = {
    name,
    key: key || name,
    description: description || '',
    queryText: sql,
    targetName: targetDE,
    targetKey: targetDE,
    targetUpdateTypeId: QUERY_UPDATE_TYPE[updateType],
    targetUpdateTypeName: updateType,
    categoryId: resolvedCategoryId
  }
  const { httpOk, status, data, text } = await restRequest(account, 'POST', '/automation/v1/queries/', body)
  if (!httpOk) return { ok: false, code: `http_${status}`, message: data?.message || text.slice(0, 300) }
  return { ok: true, queryId: data.queryDefinitionId || data.id || data.key, key: data.key, name: data.name, categoryId: resolvedCategoryId }
}

export async function runQueryActivity(account, { queryId }) {
  if (!queryId) throw new Error('sfmc-client.runQueryActivity: need queryId')
  const { httpOk, status, data, text } = await restRequest(
    account, 'POST',
    `/automation/v1/queries/${encodeURIComponent(queryId)}/actions/start`,
    {}
  )
  if (!httpOk) return { ok: false, code: `http_${status}`, message: data?.message || text.slice(0, 300) }
  return { ok: true, result: data }
}

// ── Automations ───────────────────────────────────────────────────────────

// steps: [{ stepNumber, activities: [{ name, activityObjectId, objectTypeId }] }]
// schedule: { startDate, icalRecur, timezoneId?, endDate? } OR null for unscheduled
export async function createAutomation(account, { name, key, description, steps, schedule }) {
  if (!name || !Array.isArray(steps) || !steps.length) {
    throw new Error('sfmc-client.createAutomation: need name + non-empty steps[]')
  }
  const body = {
    name,
    key: key || name,
    description: description || '',
    steps: steps.map((s, i) => ({
      stepNumber: s.stepNumber ?? i + 1,
      name: s.name || `Step ${i + 1}`,
      activities: (s.activities || []).map((a, j) => ({
        name: a.name,
        activityObjectId: a.activityObjectId,
        objectTypeId: a.objectTypeId ?? 300,
        displayOrder: a.displayOrder ?? j + 1
      }))
    })),
    startSource: schedule
      ? {
          typeId: 1,
          schedule: {
            scheduleTypeId: 4,
            startDate: schedule.startDate,
            endDate: schedule.endDate || null,
            icalRecur: schedule.icalRecur,
            timezoneId: schedule.timezoneId ?? 10,
            statusId: 1
          }
        }
      : undefined
  }
  const { httpOk, status, data, text } = await restRequest(account, 'POST', '/automation/v1/automations/', body)
  if (!httpOk) return { ok: false, code: `http_${status}`, message: data?.message || text.slice(0, 300) }
  return { ok: true, automationId: data.id || data.objectId, key: data.key, name: data.name }
}

export async function runAutomation(account, { automationId }) {
  if (!automationId) throw new Error('sfmc-client.runAutomation: need automationId')
  const { httpOk, status, data, text } = await restRequest(
    account, 'POST',
    `/automation/v1/automations/${encodeURIComponent(automationId)}/actions/start`,
    {}
  )
  if (!httpOk) return { ok: false, code: `http_${status}`, message: data?.message || text.slice(0, 300) }
  return { ok: true, result: data }
}

export async function getAutomationStatus(account, { automationId }) {
  if (!automationId) throw new Error('sfmc-client.getAutomationStatus: need automationId')
  const { httpOk, status, data, text } = await restRequest(
    account, 'GET',
    `/automation/v1/automations/${encodeURIComponent(automationId)}`
  )
  if (!httpOk) return { ok: false, code: `http_${status}`, message: data?.message || text.slice(0, 300) }
  return {
    ok: true,
    automationId: data.id,
    name: data.name,
    status: data.status,
    lastRunTime: data.lastRunTime,
    nextRunTime: data.nextRunTime
  }
}
