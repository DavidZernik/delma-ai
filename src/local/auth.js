// Sign-in / sign-out for Delma.
//
// Boot sequence:
//   1) Check the URL hash. If it contains an access_token (the redirect
//      from a Supabase magic-link email lands here), POST it to the local
//      server's /api/auth/callback to persist the session, then strip the
//      hash and continue.
//   2) Hit /api/auth/status. If signed in, hand control back to the caller.
//      If not, render the login screen and wait.
//
// All credential handling stays inside the local Express server — the
// browser only ever sees the access_token long enough to ship it down to
// localhost. Refresh tokens never touch the browser.

import { escapeHtml } from './util.js'

export function initAuth({ els, onSignedIn }) {
  // Returns the current { signedIn, email, devAuth } from the local server.
  async function fetchStatus() {
    const res = await fetch('/api/auth/status')
    return await res.json()
  }

  // If the URL hash carries `access_token`, hand it to the server and
  // remove it from the URL so a refresh doesn't replay the magic link.
  async function consumeMagicLinkHash() {
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return false
    const params = new URLSearchParams(hash)
    const access_token = params.get('access_token')
    if (!access_token) return false
    const expires_at = params.get('expires_at')
    try {
      const res = await fetch('/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token, expires_at })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        showLoginError(err.error || `sign-in failed (status ${res.status})`)
        return false
      }
    } catch (err) {
      showLoginError(err.message)
      return false
    } finally {
      // Always strip the hash so reloading the page doesn't replay it.
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    return true
  }

  function paintLogin(devAuth) {
    els.login.hidden = false
    els.login.innerHTML = `
      <h1>Sign in to Delma</h1>
      <p>${devAuth
        ? 'Dev mode — entering an email signs you in instantly, no email round-trip.'
        : 'Enter your email. We\'ll send you a one-time sign-in link.'}</p>
      <input id="loginEmail" type="email" placeholder="you@example.com" autofocus autocomplete="email" />
      <div class="picker-actions">
        <button class="btn-primary" id="loginBtn">${devAuth ? 'Sign in' : 'Email me a link'}</button>
      </div>
      <div id="loginStatus"></div>`

    const emailEl = document.getElementById('loginEmail')
    const btn = document.getElementById('loginBtn')
    const submit = async () => {
      const email = emailEl.value.trim()
      if (!email || !email.includes('@')) { showLoginError('valid email required'); return }
      btn.disabled = true
      showLoginStatus('Signing in…')
      try {
        const res = await fetch('/api/auth/sign-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        })
        const data = await res.json()
        if (!res.ok) { showLoginError(data.error || `sign-in failed (status ${res.status})`); btn.disabled = false; return }
        if (data.mode === 'dev') {
          await proceedAfterSignIn()
          return
        }
        showLoginStatus(`Check your email — we sent a sign-in link to ${email}.`)
        btn.disabled = false
      } catch (err) {
        showLoginError(err.message)
        btn.disabled = false
      }
    }
    btn.addEventListener('click', submit)
    emailEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  }

  function showLoginError(msg) {
    const host = document.getElementById('loginStatus')
    if (host) host.innerHTML = `<div class="error-banner">${escapeHtml(msg)}</div>`
  }
  function showLoginStatus(msg) {
    const host = document.getElementById('loginStatus')
    if (host) host.innerHTML = `<div class="info-banner">${escapeHtml(msg)}</div>`
  }

  async function proceedAfterSignIn() {
    const status = await fetchStatus()
    if (!status.signedIn) { showLoginError('sign-in did not stick — try again'); return }
    els.login.hidden = true
    els.login.innerHTML = ''
    onSignedIn(status)
  }

  async function start() {
    await consumeMagicLinkHash()
    const status = await fetchStatus()
    if (status.signedIn) {
      onSignedIn(status)
      return
    }
    paintLogin(!!status.devAuth)
  }

  async function signOut() {
    try { await fetch('/api/auth/sign-out', { method: 'POST' }) } catch { /* best-effort */ }
    window.location.reload()
  }

  return { start, signOut }
}
