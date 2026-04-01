/**
 * agent-sdk.js — WebSocket client for the Claude CLI Agent SDK.
 *
 * Connects to the server's /ws/agent-sdk endpoint, which spawns
 * claude --json as a child process. Handles bidirectional streaming
 * and transcript accumulation for the watcher.
 */

const BATCH_SIZE = 5  // messages before triggering watcher

export function createAgentSDK({ onMessage, onStatus, onTranscriptBatch }) {
  let ws = null
  let transcript = []
  let messageCount = 0
  let connected = false

  function connect(projectDir) {
    if (ws) ws.close()

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws/agent-sdk?dir=${encodeURIComponent(projectDir)}`

    console.log('[agent-sdk] connecting:', url)
    onStatus('connecting')

    ws = new WebSocket(url)

    ws.onopen = () => {
      console.log('[agent-sdk] connected')
      connected = true
      onStatus('connected')
    }

    ws.onmessage = (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        data = { type: 'raw', content: event.data }
      }

      onMessage(data)

      // Accumulate transcript for watcher
      transcript.push(data)
      messageCount++

      if (messageCount >= BATCH_SIZE) {
        const batch = transcript.map(m => formatTranscriptMessage(m)).join('\n')
        transcript = []
        messageCount = 0
        onTranscriptBatch(batch)
      }
    }

    ws.onclose = () => {
      console.log('[agent-sdk] disconnected')
      connected = false
      onStatus('disconnected')

      // Flush remaining transcript
      if (transcript.length) {
        const batch = transcript.map(m => formatTranscriptMessage(m)).join('\n')
        transcript = []
        messageCount = 0
        onTranscriptBatch(batch)
      }
    }

    ws.onerror = (err) => {
      console.error('[agent-sdk] error:', err)
      onStatus('error')
    }
  }

  function send(message) {
    if (!ws || !connected) return
    ws.send(JSON.stringify({ type: 'user_message', content: message }))
    // Add user message to transcript — claude --json may not echo user input
    // The message renderer in main.js handles display separately to avoid double-render
    transcript.push({ type: 'user_message', content: message })
    messageCount++
  }

  function disconnect() {
    if (ws) ws.close()
  }

  function isConnected() {
    return connected
  }

  return { connect, send, disconnect, isConnected }
}

// Format a message object into readable transcript text for the watcher
function formatTranscriptMessage(msg) {
  if (!msg) return ''

  switch (msg.type) {
    case 'user_message':
      return `[USER] ${msg.content}`

    case 'assistant':
    case 'assistant_message':
      return `[ASSISTANT] ${msg.content || JSON.stringify(msg)}`

    case 'tool_use':
      return `[TOOL_USE] ${msg.name || msg.tool}: ${JSON.stringify(msg.input || msg.content || '').slice(0, 200)}`

    case 'tool_result':
      return `[TOOL_RESULT] ${JSON.stringify(msg.content || msg.output || '').slice(0, 300)}`

    case 'error':
      return `[ERROR] ${msg.content}`

    case 'raw':
      return `[RAW] ${msg.content}`

    default:
      return `[${msg.type || 'UNKNOWN'}] ${JSON.stringify(msg).slice(0, 200)}`
  }
}
