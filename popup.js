// TabVault – Popup script

// ─── DOM refs ────────────────────────────────────────────────────────────────
const navBtns       = document.querySelectorAll(".nav-btn");
const panels        = document.querySelectorAll(".panel");
const btnSave       = document.getElementById("btn-save");
const sessionNameEl = document.getElementById("session-name");
const dropZone      = document.getElementById("drop-zone");
const fileInput     = document.getElementById("file-input");
const restorePreview= document.getElementById("restore-preview");
const btnRestoreNew = document.getElementById("btn-restore-new");
const btnRestoreHere= document.getElementById("btn-restore-here");
const historyList   = document.getElementById("history-list");
const toast         = document.getElementById("toast");
const autosaveToggle= document.getElementById("autosave-toggle");
const intervalSection = document.getElementById("autosave-interval-section");
const intervalBtns  = document.querySelectorAll(".interval-btn");

const statTabs    = document.getElementById("stat-tabs");
const statGroups  = document.getElementById("stat-groups");
const statWindows = document.getElementById("stat-windows");

let pendingSession = null;
let toastTimer = null;

// ─── Tabs navigation ─────────────────────────────────────────────────────────
navBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    navBtns.forEach((b) => b.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.panel}`).classList.add("active");
    if (btn.dataset.panel === "history") loadHistory();
  });
});

// ─── Load live stats ─────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await sendMessage({ type: "GET_TAB_COUNT" });
    if (res.success) {
      statTabs.textContent    = res.tabCount;
      statGroups.textContent  = res.groupCount;
      statWindows.textContent = res.windowCount;
    }
  } catch (e) {}
}

// ─── Save ────────────────────────────────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  const name = sessionNameEl.value.trim() || `Session ${new Date().toLocaleString()}`;
  setLoading(btnSave, true);
  try {
    const res = await sendMessage({ type: "SAVE_SESSION", name });
    if (res.success) {
      showToast(`✓ Saved as ${res.filename}`, "success");
      sessionNameEl.value = "";
    } else {
      showToast(`✗ ${res.error}`, "error");
    }
  } catch (e) {
    showToast("✗ Save failed", "error");
  } finally {
    setLoading(btnSave, false);
  }
});

sessionNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnSave.click();
});

// ─── Drop zone ───────────────────────────────────────────────────────────────
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file.name.endsWith(".json")) {
    showToast("✗ Please select a .json file", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const session = JSON.parse(e.target.result);
      if (!session.windows || !session.savedAt) throw new Error("Invalid format");
      pendingSession = session;
      showPreview(session);
    } catch (err) {
      showToast("✗ Invalid session file", "error");
      pendingSession = null;
      restorePreview.style.display = "none";
    }
  };
  reader.readAsText(file);
}

function showPreview(session) {
  const tabCount = session.windows.reduce((n, w) => n + (w.tabs?.length || 0), 0);
  const windowCount = session.windows.length;

  document.getElementById("preview-name").textContent = session.name || "Unnamed session";
  document.getElementById("preview-tabs").textContent = `${tabCount} tab${tabCount !== 1 ? "s" : ""}`;
  document.getElementById("preview-windows").textContent = `${windowCount} window${windowCount !== 1 ? "s" : ""}`;
  document.getElementById("preview-date").textContent = formatDate(session.savedAt);

  restorePreview.style.display = "block";
}

btnRestoreNew.addEventListener("click", () => doRestore({ newWindow: true }));
btnRestoreHere.addEventListener("click", () => doRestore({ newWindow: false }));

async function doRestore(options) {
  if (!pendingSession) return;

  const tabCount = pendingSession.windows.reduce((n, w) => n + (w.tabs?.length || 0), 0);
  if (tabCount > 40) {
    if (!confirm(`This will open ${tabCount} tabs. Continue?`)) return;
  }

  setLoading(btnRestoreNew, true);
  setLoading(btnRestoreHere, true);
  try {
    const res = await sendMessage({
      type: "RESTORE_SESSION",
      session: pendingSession,
      options,
    });
    if (res.success) {
      showToast(`✓ Restored ${res.restoredTabs} tabs in ${res.restoredGroups} group${res.restoredGroups !== 1 ? "s" : ""}`, "success");
      restorePreview.style.display = "none";
      pendingSession = null;
      fileInput.value = "";
    } else {
      showToast(`✗ ${res.error}`, "error");
    }
  } catch (e) {
    showToast("✗ Restore failed", "error");
  } finally {
    setLoading(btnRestoreNew, false);
    setLoading(btnRestoreHere, false);
    loadStats();
  }
}

// ─── History ─────────────────────────────────────────────────────────────────
async function loadHistory() {
  const res = await sendMessage({ type: "GET_SESSIONS" });
  if (!res.success) return;

  const sessions = res.sessions;
  if (!sessions.length) {
    historyList.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
          <rect x="4" y="6" width="24" height="20" rx="2"/>
          <path d="M4 11h24"/>
          <path d="M9 8v3M16 8v3M23 8v3"/>
        </svg>
        <div class="empty-title">No saved sessions</div>
        <div class="empty-sub">Save a session to see it here</div>
      </div>`;
    return;
  }

  historyList.innerHTML = sessions
    .map(
      (s, i) => `
    <div class="session-card" style="animation-delay:${i * 30}ms" data-id="${s.id}">
      <div class="session-card-top">
        <div class="session-name">${escapeHtml(s.name)}</div>
        <button class="session-delete" data-id="${s.id}" title="Delete">
          <svg viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2" y1="2" x2="11" y2="11"/>
            <line x1="11" y1="2" x2="2" y2="11"/>
          </svg>
        </button>
      </div>
      <div class="session-meta">
        <div class="session-chip">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="2" width="10" height="7" rx="1"/><path d="M1 4h10"/></svg>
          ${s.tabCount} tab${s.tabCount !== 1 ? "s" : ""}
        </div>
        <div class="session-chip">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="1" width="10" height="10" rx="1.5"/></svg>
          ${s.windowCount} window${s.windowCount !== 1 ? "s" : ""}
        </div>
      </div>
      <div class="session-time">${formatDate(s.savedAt)}</div>
      <div class="restore-opts" style="margin-top:8px;">
        <button class="btn btn-primary" style="flex:1;padding:6px 8px;font-size:10px;" data-action="restore-new" data-id="${s.id}">
          New window
        </button>
        <button class="btn btn-secondary" style="flex:1;padding:6px 8px;font-size:10px;" data-action="restore-here" data-id="${s.id}">
          Download
        </button>
      </div>
    </div>`
    )
    .join("");

  // Delete buttons
  historyList.querySelectorAll(".session-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const res = await sendMessage({ type: "DELETE_SESSION", id });
      if (res.success) {
        showToast("Session deleted", "success");
        loadHistory();
      }
    });
  });

  // Restore / download buttons
  historyList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const session = sessions.find((s) => s.id === id)?.data;
      if (!session) return;

      if (action === "restore-new") {
        setLoading(btn, true);
        const res = await sendMessage({ type: "RESTORE_SESSION", session, options: { newWindow: true } });
        setLoading(btn, false);
        if (res.success) {
          showToast(`✓ Restored ${res.restoredTabs} tabs`, "success");
          loadStats();
        } else {
          showToast(`✗ ${res.error}`, "error");
        }
      } else if (action === "restore-here") {
        const downloadRes = await sendMessage({ type: "DOWNLOAD_SESSION", session });
        if (downloadRes.success) showToast("✓ Downloaded", "success");
      }
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function setLoading(btn, loading) {
  if (loading) {
    btn._origContent = btn.innerHTML;
    btn.innerHTML = `<div class="spinner"></div> Working…`;
    btn.disabled = true;
  } else {
    if (btn._origContent) btn.innerHTML = btn._origContent;
    btn.disabled = false;
  }
}

function showToast(msg, type = "") {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("show"));
  });
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Auto-save ────────────────────────────────────────────────────────────
async function loadAutoSaveConfig() {
  const res = await sendMessage({ type: "GET_AUTO_SAVE_CONFIG" });
  if (!res.success) return;
  const config = res.config;
  autosaveToggle.checked = config.enabled;
  updateIntervalUI(config.intervalMinutes);
  updateIntervalSectionState();
}

function updateIntervalUI(minutes) {
  intervalBtns.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.minutes) === minutes);
  });
}

function updateIntervalSectionState() {
  intervalSection.classList.toggle("disabled", !autosaveToggle.checked);
}

autosaveToggle.addEventListener("change", async () => {
  const enabled = autosaveToggle.checked;
  const activeBtn = document.querySelector(".interval-btn.active");
  const intervalMinutes = activeBtn ? Number(activeBtn.dataset.minutes) : 15;
  updateIntervalSectionState();
  const res = await sendMessage({ type: "SET_AUTO_SAVE_CONFIG", config: { enabled, intervalMinutes } });
  if (res.success) {
    showToast(enabled ? `✓ Auto-save every ${intervalMinutes}m` : "Auto-save disabled", "success");
  }
});

intervalBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const intervalMinutes = Number(btn.dataset.minutes);
    updateIntervalUI(intervalMinutes);
    const res = await sendMessage({ type: "SET_AUTO_SAVE_CONFIG", config: { enabled: true, intervalMinutes } });
    if (res.success) {
      autosaveToggle.checked = true;
      updateIntervalSectionState();
      showToast(`✓ Auto-save every ${intervalMinutes}m`, "success");
    }
  });
});

const btnTestAutosave = document.getElementById("btn-test-autosave");
btnTestAutosave.addEventListener("click", async () => {
  setLoading(btnTestAutosave, true);
  try {
    const res = await sendMessage({ type: "TRIGGER_AUTO_SAVE" });
    if (res.success) {
      showToast("✓ Auto-save test completed — check History", "success");
    } else {
      showToast(`✗ Auto-save test failed: ${res.error}`, "error");
    }
  } catch (e) {
    showToast("✗ Auto-save test failed", "error");
  } finally {
    setLoading(btnTestAutosave, false);
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────
loadStats();
loadAutoSaveConfig();
loadHistory();
