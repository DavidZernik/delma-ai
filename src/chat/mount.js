// Mount the React chat sidebar into a specific DOM node. The workspace UI
// (src/main.js) stays vanilla JS; the chat is the only React island. This
// lets us add React without rewriting the existing workspace renderer.
//
// main.js calls mountChat() once it knows the user's workspace + user IDs.
// Re-calling with different IDs remounts cleanly.

import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { ChatSidebar } from './ChatSidebar.jsx'

let root = null

export function mountChat({ containerId, projectId, userId }) {
  const el = document.getElementById(containerId)
  if (!el) {
    console.warn('[chat mount] container not found:', containerId)
    return
  }
  if (!root) root = createRoot(el)
  root.render(createElement(ChatSidebar, { projectId, userId }))
}

export function unmountChat() {
  root?.unmount()
  root = null
}
