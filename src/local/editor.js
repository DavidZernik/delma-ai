// Per-section edit mode: swap the rendered pane for a textarea, save
// the edited content back through the parent. Owns no global state —
// takes getter/callbacks from the parent so the workspace can toggle
// edit on/off cleanly.

export function initEditor({ els, getCurrent, onSave, onCancel }) {
  function paint() {
    els.pane.innerHTML = `
      <textarea class="edit-textarea" id="editor"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn-primary" id="saveBtn">Save</button>
      </div>`
    const editor = document.getElementById('editor')
    editor.value = getCurrent()
    editor.focus()
    document.getElementById('saveBtn').addEventListener('click', async () => {
      els.editStatus.textContent = 'Saving…'
      try {
        await onSave(editor.value)
      } catch (err) {
        els.editStatus.textContent = 'Save failed: ' + err.message
      }
    })
  }

  return { paint, cancel: onCancel }
}
