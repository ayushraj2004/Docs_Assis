// ─── State ────────────────────────────────────────────────────────────────────
let currentSessionId = null;
let chatMessages = [];
let savedHistories = {};
let sidebarOpen = true;
let isLoading = false;
let pinnedAnswers = {};
let favorites = {};
let docTags = {};
let notes = {};

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme();
  await newChat();
  await refreshDocuments();
  await loadHistoryList();
  await loadPins();
  await loadFavorites();
  await loadNotes();
  const tagsRes = await fetch('/api/tags');
  docTags = await tagsRes.json();
});

// ─── Theme ─────────────────────────────────────────────────────────────────────
const DARK = {
  '--bg-main':'#1A1816','--bg-secondary':'#24211E','--bg-sidebar':'#2D2A26',
  '--bg-card':'#34302B','--border':'#4A443D','--text-primary':'#F5F1EB',
  '--text-secondary':'#B9B0A5','--text-muted':'#8E8478',
  '--accent':'#D97757','--accent-hover':'#C76647','--success':'#4CAF50'
};
const LIGHT = {
  '--bg-main':'#F5F0E8','--bg-secondary':'#EDE8DF','--bg-sidebar':'#E5DFD5',
  '--bg-card':'#DDD6CA','--border':'#C8BFB0','--text-primary':'#2C2520',
  '--text-secondary':'#5C5248','--text-muted':'#8C7E72',
  '--accent':'#C76647','--accent-hover':'#B85535','--success':'#3A8A3E'
};

function applyTheme() {
  const light = localStorage.getItem('theme') === 'light';
  document.documentElement.classList.toggle('dark', !light);
  document.documentElement.classList.toggle('light', light);
  const vars = light ? LIGHT : DARK;
  Object.entries(vars).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
  document.getElementById('themeIcon').className = light ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  document.getElementById('themeIcon').style.color = light ? '#C76647' : '#D97757';
  document.getElementById('themeLabel').textContent = light ? 'Dark Mode' : 'Light Mode';
}
function toggleTheme() {
  localStorage.setItem('theme', localStorage.getItem('theme') === 'light' ? 'dark' : 'light');
  applyTheme();
}

// ─── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('sidebar').classList.toggle('collapsed', !sidebarOpen);
}

// ─── Session ───────────────────────────────────────────────────────────────────
async function newChat() {
  if (chatMessages.length > 0 && currentSessionId) await persistCurrentChat();
  const res = await fetch('/api/session/new', { method: 'POST' });
  const data = await res.json();
  currentSessionId = data.session_id;
  chatMessages = [];
  renderChat();
  document.getElementById('chatTitle').textContent = 'New Conversation';
  document.getElementById('chatSubtitle').textContent = 'Upload documents to begin';
}

async function persistCurrentChat(title = null) {
  if (!chatMessages.length) return;
  const label = title || chatMessages[0]?.content?.slice(0, 45) || 'Chat';
  await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: currentSessionId, title: label, messages: chatMessages, timestamp: Date.now() })
  });
  await loadHistoryList();
}

async function loadHistoryList() {
  const res = await fetch('/api/history');
  savedHistories = await res.json();
  const container = document.getElementById('historyList');
  const entries = Object.values(savedHistories).sort((a, b) => b.timestamp - a.timestamp);
  if (!entries.length) {
    container.innerHTML = '<p class="text-xs text-gray-600 text-center py-2">No history yet</p>';
    return;
  }
  container.innerHTML = entries.map(e => `
    <div class="history-item group" onclick="loadHistorySession('${e.session_id}')">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fa-regular fa-message text-[10px] text-gray-600 flex-shrink-0"></i>
        <span class="text-xs text-gray-400 truncate">${escHtml(e.title || 'Chat')}</span>
      </div>
      <button onclick="event.stopPropagation();deleteHistorySession('${e.session_id}')"
        class="del-btn w-5 h-5 items-center justify-center text-gray-600 hover:text-red-400 transition-colors text-xs">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>`).join('');
}

async function loadHistorySession(sessionId) {
  if (chatMessages.length > 0 && currentSessionId) await persistCurrentChat();
  const entry = savedHistories[sessionId];
  if (!entry) return;
  currentSessionId = sessionId;
  chatMessages = entry.messages || [];
  document.getElementById('chatTitle').textContent = entry.title || 'Chat';
  renderChat();
}

async function deleteHistorySession(sessionId) {
  await fetch(`/api/history/${sessionId}`, { method: 'DELETE' });
  delete savedHistories[sessionId];
  await loadHistoryList();
}

async function clearAllHistory() {
  await Promise.all(Object.keys(savedHistories).map(id => fetch(`/api/history/${id}`, { method: 'DELETE' })));
  savedHistories = {};
  await loadHistoryList();
}

// ─── Upload ────────────────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.add('drag-over');
}
function handleDragLeave() {
  document.getElementById('dropzone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  handleDragLeave();
  uploadFiles([...e.dataTransfer.files]);
}
function handleFileSelect(e) {
  uploadFiles([...e.target.files]);
  e.target.value = '';
}

async function uploadFiles(files) {
  const progressDiv = document.getElementById('uploadProgress');
  progressDiv.classList.remove('hidden');
  for (const file of files) {
    const itemId = 'up_' + Date.now();
    const ext = file.name.split('.').pop().toLowerCase();
    const icon = ext === 'pdf' ? 'fa-file-pdf' : ext === 'docx' ? 'fa-file-word' : 'fa-file-lines';
    progressDiv.insertAdjacentHTML('beforeend', `
      <div id="${itemId}" class="upload-item uploading">
        <div class="upload-progress-bar"></div>
        <i class="fa-solid ${icon} upload-file-icon flex-shrink-0 text-xs" style="color:var(--accent)"></i>
        <div class="flex-1 min-w-0">
          <span class="text-xs truncate block" style="color:var(--text-secondary)">${escHtml(file.name)}</span>
          <div class="flex items-center gap-1 mt-0.5">
            <i class="fa-solid fa-spinner animate-spin text-[9px]" style="color:var(--accent)"></i>
            <span class="text-[10px]" style="color:var(--text-muted)">Embedding…</span>
          </div>
        </div>
      </div>`);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      const res = await fetch('/api/upload', { method: 'POST', body: formData, signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      const el = document.getElementById(itemId);
      el.classList.remove('uploading');
      el.classList.add('done');
      if (res.ok) {
        el.innerHTML = `
          <div class="upload-progress-bar" style="width:100%;animation:none"></div>
          <i class="fa-solid fa-circle-check flex-shrink-0 text-xs" style="color:var(--success)"></i>
          <span class="text-xs truncate flex-1" style="color:var(--text-secondary)">${escHtml(file.name)}</span>
          <span class="text-[10px] font-medium" style="color:var(--success)">${data.duplicate ? 'Cached' : data.chunks + ' chunks'}</span>`;
        showToast(data.duplicate ? 'Already indexed' : `✓ Indexed ${data.chunks} chunks`, 'success');
      } else {
        el.innerHTML = `
          <i class="fa-solid fa-circle-xmark flex-shrink-0 text-xs" style="color:#ef4444"></i>
          <span class="text-xs truncate flex-1" style="color:#ef4444">${escHtml(data.error || 'Failed')}</span>`;
        showToast(data.error || 'Upload failed', 'error');
      }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Timeout — try a smaller file' : 'Network error';
      const el = document.getElementById(itemId);
      el.classList.remove('uploading');
      el.innerHTML = `
        <i class="fa-solid fa-circle-xmark flex-shrink-0 text-xs" style="color:#ef4444"></i>
        <span class="text-xs" style="color:#ef4444">${msg}</span>`;
      showToast(msg, 'error');
    }
    setTimeout(() => document.getElementById(itemId)?.remove(), 4000);
  }
  await refreshDocuments();
  setTimeout(() => { if (!progressDiv.children.length) progressDiv.classList.add('hidden'); }, 4500);
}

// ─── Documents ─────────────────────────────────────────────────────────────────
async function refreshDocuments() {
  const [docsRes, favsRes, tagsRes] = await Promise.all([
    fetch('/api/documents'), fetch('/api/favorites'), fetch('/api/tags')
  ]);
  const data = await docsRes.json();
  favorites = await favsRes.json();
  docTags = await tagsRes.json();
  document.getElementById('statDocs').textContent = data.total_documents;
  document.getElementById('statChunks').textContent = data.total_chunks;
  const container = document.getElementById('documentList');
  if (!data.documents?.length) {
    container.innerHTML = `
      <div class="empty-state rounded-xl p-4 text-center">
        <i class="fa-regular fa-folder-open text-gray-600 text-xl mb-2 block"></i>
        <p class="text-xs text-gray-600">No documents yet</p>
      </div>`;
    updateStatus(0); return;
  }
  container.innerHTML = data.documents.map(d => {
    const isFav = !!favorites[d.file_hash];
    const tags = (docTags[d.file_hash] || []);
    const tagsHtml = tags.map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('');
    return `
    <div class="doc-item group mb-1" id="doc_${d.file_hash}">
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <i class="fa-solid ${fileIcon(d.filename)} text-xs flex-shrink-0" style="color:var(--accent)"></i>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium truncate" style="color:var(--text-secondary)">${escHtml(d.filename)}</p>
          <p class="text-[10px]" style="color:var(--text-muted)">${d.pages}p · ${d.chunks} chunks</p>
          <div class="flex flex-wrap gap-1 mt-1">${tagsHtml}
            <button onclick="addTag('${d.file_hash}')" class="tag-add-btn"><i class="fa-solid fa-plus text-[8px]"></i></button>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1 flex-shrink-0">
        <button onclick="summarizeDoc('${d.file_hash}','${escHtml(d.filename)}')" title="Summarize" class="icon-btn" style="color:var(--accent)"><i class="fa-solid fa-wand-magic-sparkles text-[10px]"></i></button>
        <button onclick="toggleFavorite('${d.file_hash}')" title="Favorite" class="icon-btn" style="color:${isFav ? '#D97757' : 'var(--text-muted)'}"><i class="fa-solid fa-star text-[10px]"></i></button>
        <button onclick="deleteDocument('${d.file_hash}','${escHtml(d.filename)}')" class="del-btn w-5 h-5 items-center justify-center transition-colors text-xs" style="color:var(--text-muted)"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>`;
  }).join('');
  updateStatus(data.total_documents);
}

// ─── Favorites ─────────────────────────────────────────────────────────────────
async function loadFavorites() {
  const res = await fetch('/api/favorites');
  favorites = await res.json();
}
async function toggleFavorite(fileHash) {
  if (favorites[fileHash]) {
    await fetch(`/api/favorites/${fileHash}`, { method: 'DELETE' });
    showToast('Removed from favorites', 'success');
  } else {
    await fetch(`/api/favorites/${fileHash}`, { method: 'POST' });
    showToast('Added to favorites ⭐', 'success');
  }
  await refreshDocuments();
}

// ─── Tags ──────────────────────────────────────────────────────────────────────
async function addTag(fileHash) {
  const tag = prompt('Enter tag name:');
  if (!tag?.trim()) return;
  const current = docTags[fileHash] || [];
  if (current.includes(tag.trim())) return;
  const updated = [...current, tag.trim()];
  await fetch(`/api/tags/${fileHash}`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ tags: updated })
  });
  docTags[fileHash] = updated;
  await refreshDocuments();
}

// ─── Pins ──────────────────────────────────────────────────────────────────────
async function loadPins() {
  const res = await fetch('/api/pins');
  pinnedAnswers = await res.json();
  renderPins();
}
async function pinAnswer(idx) {
  const msg = chatMessages[idx];
  if (!msg) return;
  await fetch('/api/pins', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ content: msg.content, sources: msg.sources || [] })
  });
  showToast('Answer pinned 📌', 'success');
  await loadPins();
}
async function deletePin(pinId) {
  await fetch(`/api/pins/${pinId}`, { method: 'DELETE' });
  await loadPins();
}
function renderPins() {
  const container = document.getElementById('pinnedList');
  if (!container) return;
  const entries = Object.entries(pinnedAnswers);
  if (!entries.length) {
    container.innerHTML = '<p class="text-xs text-gray-600 text-center py-2">No pinned answers yet</p>';
    return;
  }
  container.innerHTML = entries.map(([id, p]) => `
    <div class="history-item group">
      <span class="text-xs text-gray-400 truncate flex-1">${escHtml(p.content.slice(0, 60))}…</span>
      <button onclick="deletePin('${id}')" class="del-btn w-5 h-5 items-center justify-center text-gray-600 hover:text-red-400 text-xs"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
}

// ─── Notes ─────────────────────────────────────────────────────────────────────
async function loadNotes() {
  const res = await fetch('/api/notes');
  notes = await res.json();
}
async function saveNote() {
  const text = document.getElementById('noteInput').value.trim();
  if (!text) return;
  const res = await fetch('/api/notes', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  notes[data.note_id] = { text, ts: Date.now() };
  document.getElementById('noteInput').value = '';
  renderNotes();
  showToast('Note saved', 'success');
}
async function deleteNote(noteId) {
  await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
  delete notes[noteId];
  renderNotes();
}
function renderNotes() {
  const container = document.getElementById('notesList');
  if (!container) return;
  const entries = Object.entries(notes).sort((a,b) => b[1].ts - a[1].ts);
  if (!entries.length) { container.innerHTML = '<p class="text-xs text-gray-500 text-center py-2">No notes yet</p>'; return; }
  container.innerHTML = entries.map(([id, n]) => `
    <div class="note-item group">
      <p class="text-xs text-gray-300 flex-1 leading-relaxed">${escHtml(n.text)}</p>
      <button onclick="deleteNote('${id}')" class="del-btn w-5 h-5 items-center justify-center text-gray-600 hover:text-red-400 text-xs mt-1"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
}
function openNotes() {
  renderNotes();
  document.getElementById('notesModal').classList.remove('hidden');
}
function closeNotes() { document.getElementById('notesModal').classList.add('hidden'); }

// ─── Summary ───────────────────────────────────────────────────────────────────
async function summarizeDoc(fileHash, filename) {
  showToast('Generating summary…', 'success');
  const res = await fetch(`/api/summary/${fileHash}`);
  const data = await res.json();
  if (!res.ok) { showToast(data.error || 'Failed', 'error'); return; }
  document.getElementById('summaryTitle').textContent = filename;
  document.getElementById('summaryBody').innerHTML = formatAnswer(data.summary);
  document.getElementById('summaryModal').classList.remove('hidden');
}
function closeSummary() { document.getElementById('summaryModal').classList.add('hidden'); }

// ─── Analytics ─────────────────────────────────────────────────────────────────
async function openAnalytics() {
  const res = await fetch('/api/analytics');
  const data = await res.json();
  document.getElementById('analyticsTotalQueries').textContent = data.total_queries;
  // Query frequency bar chart (last 7 days)
  const daily = data.daily || {};
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const max = Math.max(1, ...days.map(d => daily[d] || 0));
  document.getElementById('queryGraph').innerHTML = days.map(d => {
    const count = daily[d] || 0;
    const pct = Math.round((count / max) * 100);
    return `
      <div class="flex flex-col items-center gap-1 flex-1">
        <span class="text-[9px]" style="color:var(--text-muted)">${count}</span>
        <div class="w-full rounded-t-sm relative" style="height:60px;background:rgba(217,119,87,.15)">
          <div class="absolute bottom-0 w-full rounded-t-sm transition-all" style="height:${pct}%;background:var(--accent)"></div>
        </div>
        <span class="text-[9px]" style="color:var(--text-muted)">${d.slice(5)}</span>
      </div>`;
  }).join('');
  // Top queries
  document.getElementById('topQueries').innerHTML = data.top_queries.length
    ? data.top_queries.map(([q, c]) => `
        <div class="flex items-center justify-between py-1.5" style="border-bottom:1px solid var(--border)">
          <span class="text-xs truncate flex-1 mr-3" style="color:var(--text-secondary)">${escHtml(q)}</span>
          <span class="text-xs font-semibold" style="color:var(--accent)">${c}x</span>
        </div>`).join('')
    : `<p class="text-xs py-2" style="color:var(--text-muted)">No queries yet</p>`;
  document.getElementById('analyticsModal').classList.remove('hidden');
}
function closeAnalytics() { document.getElementById('analyticsModal').classList.add('hidden'); }


function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'fa-file-pdf';
  if (ext === 'docx') return 'fa-file-word';
  return 'fa-file-lines';
}

function updateStatus(n) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const sub = document.getElementById('chatSubtitle');
  if (n > 0) {
    dot.style.background = 'var(--success)';
    dot.style.boxShadow = '0 0 6px var(--success)';
    txt.textContent = `${n} doc${n > 1 ? 's' : ''} indexed`;
    txt.style.color = 'var(--success)';
    sub.textContent = `${n} document${n > 1 ? 's' : ''} ready`;
  } else {
    dot.style.background = 'var(--text-muted)';
    dot.style.boxShadow = 'none';
    txt.textContent = 'No documents';
    txt.style.color = 'var(--text-muted)';
    sub.textContent = 'Upload documents to begin';
  }
}

async function deleteDocument(fileHash, filename) {
  if (!confirm(`Remove "${filename}" from the index?`)) return;
  const res = await fetch(`/api/documents/${fileHash}`, { method: 'DELETE' });
  if (res.ok) { showToast(`Removed ${filename}`, 'success'); await refreshDocuments(); }
}

async function clearAllDocuments() {
  if (!confirm('Remove ALL documents?')) return;
  await fetch('/api/documents/clear', { method: 'DELETE' });
  showToast('All documents cleared', 'success');
  await refreshDocuments();
}

// ─── Chat ──────────────────────────────────────────────────────────────────────
function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuery(); }
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 144) + 'px';
}

async function sendQuery() {
  const input = document.getElementById('queryInput');
  const query = input.value.trim();
  if (!query || isLoading) return;
  isLoading = true;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('welcomeScreen').style.display = 'none';
  chatMessages.push({ role: 'user', content: query, timestamp: Date.now() });
  renderChat();
  const typingId = addTypingIndicator();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, session_id: currentSessionId, top_k: 5 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await res.json();
    removeTypingIndicator(typingId);
    chatMessages.push({
      role: 'assistant',
      content: res.ok ? data.answer : (data.error || 'Something went wrong.'),
      sources: res.ok ? (data.sources || []) : [],
      timestamp: Date.now()
    });
    if (chatMessages.length === 2) document.getElementById('chatTitle').textContent = query.slice(0, 45);
  } catch (err) {
    removeTypingIndicator(typingId);
    chatMessages.push({ role: 'assistant', content: err.name === 'AbortError' ? 'Request timed out.' : 'Network error. Is the server running?', sources: [], timestamp: Date.now() });
  }
  renderChat();
  isLoading = false;
  document.getElementById('sendBtn').disabled = false;
  input.focus();
}

async function regenerate() {
  const lastUser = [...chatMessages].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  const idx = chatMessages.map(m => m.role).lastIndexOf('assistant');
  if (idx !== -1) chatMessages.splice(idx, 1);
  document.getElementById('queryInput').value = lastUser.content;
  await sendQuery();
}

// ─── Render ────────────────────────────────────────────────────────────────────
function renderChat() {
  const win = document.getElementById('chatWindow');
  const welcome = document.getElementById('welcomeScreen');
  win.querySelectorAll('.chat-msg').forEach(e => e.remove());
  if (!chatMessages.length) {
    welcome.style.display = 'flex';
    if (!win.contains(welcome)) win.appendChild(welcome);
    return;
  }
  welcome.style.display = 'none';
  chatMessages.forEach((msg, idx) => {
    const el = document.createElement('div');
    el.className = 'chat-msg msg-animate max-w-3xl mx-auto w-full';
    if (msg.role === 'user') {
      el.innerHTML = `
        <div class="flex justify-end">
          <div class="user-bubble px-5 py-3 text-sm leading-relaxed text-gray-100 max-w-xl">
            ${escHtml(msg.content)}
          </div>
        </div>`;
    } else {
      const sourcesHtml = msg.sources?.length ? `
        <div class="flex flex-wrap gap-2 mt-4 pt-3 border-t border-white/5">
          <span class="text-[10px] text-gray-600 uppercase tracking-widest font-medium w-full mb-1">Sources</span>
          ${msg.sources.map(s => `
            <span class="source-chip">
              <i class="fa-solid fa-book-open text-[9px]"></i>
              ${escHtml(s.filename)} · p.${s.page}
            </span>`).join('')}
        </div>` : '';
      el.innerHTML = `
        <div class="flex gap-3 items-start">
          <div class="ai-avatar w-8 h-8 rounded-xl flex items-center justify-center mt-0.5">
            <i class="fa-solid fa-brain text-white text-xs"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="answer-card px-5 py-4">
              <div class="answer-content text-sm text-gray-300">${formatAnswer(msg.content)}</div>
              ${sourcesHtml}
            </div>
            <div class="flex items-center gap-2 mt-2 ml-1">
              <button onclick="copyText(this,${idx})" class="action-btn">
                <i class="fa-regular fa-copy text-[10px]"></i> Copy
              </button>
              <button onclick="pinAnswer(${idx})" class="action-btn">
                <i class="fa-solid fa-thumbtack text-[10px]"></i> Pin
              </button>
              ${idx === chatMessages.length - 1 ? `
              <button onclick="regenerate()" class="action-btn">
                <i class="fa-solid fa-rotate-right text-[10px]"></i> Regenerate
              </button>` : ''}
            </div>
          </div>
        </div>`;
    }
    win.appendChild(el);
  });
  win.scrollTop = win.scrollHeight;
}

function addTypingIndicator() {
  const id = 'typing_' + Date.now();
  const win = document.getElementById('chatWindow');
  const el = document.createElement('div');
  el.id = id;
  el.className = 'chat-msg max-w-3xl mx-auto w-full';
  el.innerHTML = `
    <div class="flex gap-3 items-start">
      <div class="ai-avatar w-8 h-8 rounded-xl flex items-center justify-center">
        <i class="fa-solid fa-brain text-white text-xs"></i>
      </div>
      <div class="answer-card px-5 py-4">
        <div class="flex items-center gap-1.5">
          <span class="typing-dot w-2 h-2 rounded-full inline-block" style="background:var(--accent)"></span>
          <span class="typing-dot w-2 h-2 rounded-full inline-block" style="background:var(--accent)"></span>
          <span class="typing-dot w-2 h-2 rounded-full inline-block" style="background:var(--accent)"></span>
        </div>
      </div>
    </div>`;
  win.appendChild(el);
  win.scrollTop = win.scrollHeight;
  return id;
}
function removeTypingIndicator(id) { document.getElementById(id)?.remove(); }

// ─── Utilities ─────────────────────────────────────────────────────────────────
function formatAnswer(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/^[\*\-] (.+)/gm,'<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g,'<ul>$1</ul>')
    .replace(/\n/g,'<br/>');
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function copyText(btn, idx) {
  navigator.clipboard.writeText(chatMessages[idx]?.content || '').then(() => {
    btn.innerHTML = `<i class="fa-solid fa-check text-[10px]" style="color:var(--success)"></i> Copied!`;
    setTimeout(() => { btn.innerHTML = '<i class="fa-regular fa-copy text-[10px]"></i> Copy'; }, 2000);
  });
}
function exportChat() {
  if (!chatMessages.length) { showToast('No chat to export', 'error'); return; }
  const text = chatMessages.map(m =>
    `[${m.role.toUpperCase()}]\n${m.content}${m.sources?.length ? '\nSources: '+m.sources.map(s=>`${s.filename} p.${s.page}`).join(', ') : ''}`
  ).join('\n\n────────────────────\n\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], {type:'text/plain'})),
    download: `docurag_chat_${currentSessionId?.slice(0,8)}.txt`
  });
  a.click();
  showToast('Chat exported', 'success');
}

setInterval(async () => {
  if (chatMessages.length > 0 && currentSessionId) await persistCurrentChat();
}, 30000);

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  document.getElementById('toastIcon').className = type === 'success'
    ? 'fa-solid fa-circle-check text-sm'
    : 'fa-solid fa-circle-xmark text-sm';
  document.getElementById('toastIcon').style.color = type === 'success' ? '#4CAF50' : '#ef4444';
  document.getElementById('toastMsg').textContent = msg;
  toast.classList.remove('hidden');
  toast.querySelector('div').classList.add('toast-show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}
