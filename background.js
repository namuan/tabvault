// TabVault - Background Service Worker
// Handles all Chrome API interactions for saving and restoring sessions

const SCHEMA_VERSION = "1.0";
const AUTO_SAVE_ALARM = "tabvault-auto-save";
const AUTO_SAVE_DEFAULT_MINUTES = 15;
const AUTO_SAVE_INTERVALS = [5, 10, 15, 30, 60];

// URLs that cannot be restored
const SKIP_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "devtools://",
  "about:",
  "edge://",
];

function isRestorableUrl(url) {
  return !SKIP_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// ─── SAVE ────────────────────────────────────────────────────────────────────

async function captureSession(sessionName) {
  const [windows, allTabs, allGroups] = await Promise.all([
    chrome.windows.getAll({ populate: false }),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);

  // Build a map of groupId -> group info
  const groupMap = {};
  for (const group of allGroups) {
    groupMap[group.id] = {
      id: group.id,
      title: group.title || "",
      color: group.color,
      collapsed: group.collapsed,
      windowId: group.windowId,
    };
  }

  // Build per-window structure
  const windowData = windows.map((win) => {
    const windowTabs = allTabs
      .filter((t) => t.windowId === win.id && isRestorableUrl(t.url || ""))
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        url: t.url,
        title: t.title || "",
        pinned: t.pinned,
        groupId: t.groupId >= 0 ? t.groupId : null,
        active: t.active,
        index: t.index,
      }));

    // Collect group IDs referenced by this window's tabs
    const usedGroupIds = [
      ...new Set(windowTabs.map((t) => t.groupId).filter(Boolean)),
    ];
    const groups = usedGroupIds
      .map((id) => groupMap[id])
      .filter(Boolean)
      .map((g) => ({
        savedGroupId: g.id,
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
      }));

    return {
      focused: win.focused,
      state: win.state,
      tabs: windowTabs,
      groups,
    };
  });

  const session = {
    schemaVersion: SCHEMA_VERSION,
    name: sessionName || `Session ${new Date().toLocaleString()}`,
    savedAt: new Date().toISOString(),
    windows: windowData,
  };

  return session;
}

async function downloadSession(session) {
  const json = JSON.stringify(session, null, 2);
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const safeName = session.name.replace(/[^a-z0-9_\-\s]/gi, "_").trim();
  const filename = `tabvault_${safeName}_${Date.now()}.json`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });

  return filename;
}

// ─── RESTORE ─────────────────────────────────────────────────────────────────

async function restoreSession(session, options = {}) {
  const { newWindow = true } = options;

  if (!session || !session.windows) {
    throw new Error("Invalid session file.");
  }

  let restoredTabs = 0;
  let restoredGroups = 0;
  let currentWindowId = null;

  if (!newWindow) {
    const [currentWin] = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (currentWin) currentWindowId = currentWin.id;
  }

  for (let wi = 0; wi < session.windows.length; wi++) {
    const winData = session.windows[wi];
    const restorableTabs = winData.tabs.filter((t) =>
      isRestorableUrl(t.url || "")
    );
    if (restorableTabs.length === 0) continue;

    const pinnedTabs = restorableTabs.filter((t) => t.pinned);
    const normalTabs = restorableTabs.filter((t) => !t.pinned);
    const orderedTabs = [...pinnedTabs, ...normalTabs];

    let windowId;
    let createdTabIds = [];

    if (newWindow || !currentWindowId) {
      const firstTab = orderedTabs[0];
      const newWin = await chrome.windows.create({
        url: firstTab.url,
        focused: winData.focused || false,
        state: winData.state === "minimized" ? "normal" : winData.state || "normal",
      });
      windowId = newWin.id;
      createdTabIds.push(newWin.tabs[0].id);
      for (let i = 1; i < orderedTabs.length; i++) {
        const t = orderedTabs[i];
        const created = await chrome.tabs.create({
          windowId,
          url: t.url,
          pinned: t.pinned,
          active: false,
        });
        createdTabIds.push(created.id);
      }
    } else {
      windowId = currentWindowId;
      for (let i = 0; i < orderedTabs.length; i++) {
        const t = orderedTabs[i];
        const created = await chrome.tabs.create({
          windowId,
          url: t.url,
          pinned: t.pinned,
          active: false,
        });
        createdTabIds.push(created.id);
      }
    }

    restoredTabs += createdTabIds.length;

    const activeIdx = orderedTabs.findIndex((t) => t.active);
    if (activeIdx >= 0 && createdTabIds[activeIdx]) {
      await chrome.tabs.update(createdTabIds[activeIdx], { active: true });
    }

    const groupBuckets = {};
    for (let i = 0; i < orderedTabs.length; i++) {
      const t = orderedTabs[i];
      if (t.groupId) {
        if (!groupBuckets[t.groupId]) groupBuckets[t.groupId] = [];
        groupBuckets[t.groupId].push(createdTabIds[i]);
      }
    }

    const groupMeta = {};
    for (const g of winData.groups || []) {
      groupMeta[g.savedGroupId] = g;
    }

    for (const [savedGroupId, tabIds] of Object.entries(groupBuckets)) {
      const meta = groupMeta[savedGroupId];
      const newGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });

      if (meta) {
        await chrome.tabGroups.update(newGroupId, {
          title: meta.title || "",
          color: meta.color || "grey",
          collapsed: meta.collapsed || false,
        });
      }
      restoredGroups++;
    }

    currentWindowId = windowId;
  }

  return { restoredTabs, restoredGroups };
}

// ─── STORAGE HELPERS (saved sessions list) ──────────────────────────────────

async function getSavedSessions() {
  const result = await chrome.storage.local.get("sessions");
  return result.sessions || [];
}

async function saveSessionToStorage(session) {
  const sessions = await getSavedSessions();
  sessions.unshift({
    id: Date.now().toString(),
    name: session.name,
    savedAt: session.savedAt,
    tabCount: session.windows.reduce((n, w) => n + w.tabs.length, 0),
    windowCount: session.windows.length,
    data: session,
  });
  if (sessions.length > 20) sessions.pop();
  try {
    await chrome.storage.local.set({ sessions });
  } catch (e) {
    if (e.message?.includes("QUOTA")) {
      while (sessions.length > 1) {
        sessions.pop();
        try {
          await chrome.storage.local.set({ sessions });
          break;
        } catch {
          continue;
        }
      }
    } else {
      throw e;
    }
  }
  return sessions;
}

async function deleteSessionFromStorage(id) {
  const sessions = await getSavedSessions();
  const filtered = sessions.filter((s) => s.id !== id);
  await chrome.storage.local.set({ sessions: filtered });
  return filtered;
}

// ─── AUTO-SAVE ──────────────────────────────────────────────────────────────

async function getAutoSaveConfig() {
  const result = await chrome.storage.local.get("autoSaveConfig");
  return result.autoSaveConfig || { enabled: false, intervalMinutes: AUTO_SAVE_DEFAULT_MINUTES };
}

async function setAutoSaveConfig(config) {
  console.log("[TabVault] setAutoSaveConfig", config);
  await chrome.storage.local.set({ autoSaveConfig: config });
  if (config.enabled) {
    await chrome.alarms.create(AUTO_SAVE_ALARM, { periodInMinutes: config.intervalMinutes });
    const alarm = await chrome.alarms.get(AUTO_SAVE_ALARM);
    console.log("[TabVault] alarm created:", alarm);
  } else {
    await chrome.alarms.clear(AUTO_SAVE_ALARM);
    console.log("[TabVault] alarm cleared");
  }
  return config;
}

async function handleAutoSave() {
  console.log("[TabVault] handleAutoSave started");
  try {
    const session = await captureSession("Auto-save");
    console.log("[TabVault] captured session:", session.name, session.windows.length, "windows,", session.windows.reduce((n, w) => n + w.tabs.length, 0), "tabs");
    const sessions = await saveSessionToStorage(session);
    console.log("[TabVault] saved to storage, total sessions:", sessions.length);
  } catch (e) {
    console.error("[TabVault] handleAutoSave failed:", e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log("[TabVault] alarm fired:", alarm.name);
  if (alarm.name === AUTO_SAVE_ALARM) {
    handleAutoSave();
  }
});

(async () => {
  const config = await getAutoSaveConfig();
  console.log("[TabVault] service worker startup, autoSaveConfig:", config);
  if (config.enabled) {
    await chrome.alarms.create(AUTO_SAVE_ALARM, { periodInMinutes: config.intervalMinutes });
    const alarm = await chrome.alarms.get(AUTO_SAVE_ALARM);
    console.log("[TabVault] re-registered alarm:", alarm);
  }
})();

// ─── MESSAGE LISTENER ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ success: true, ...result }))
    .catch((err) => sendResponse({ success: false, error: err.message }));
  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  switch (message.type) {
    case "SAVE_SESSION": {
      const session = await captureSession(message.name);
      const [filename, sessions] = await Promise.all([
        downloadSession(session),
        saveSessionToStorage(session),
      ]);
      return { filename, sessions };
    }

    case "RESTORE_SESSION": {
      const result = await restoreSession(message.session, message.options);
      return result;
    }

    case "GET_SESSIONS": {
      const sessions = await getSavedSessions();
      return { sessions };
    }

    case "DELETE_SESSION": {
      const sessions = await deleteSessionFromStorage(message.id);
      return { sessions };
    }

    case "GET_TAB_COUNT": {
      const tabs = await chrome.tabs.query({});
      const groups = await chrome.tabGroups.query({});
      const windows = await chrome.windows.getAll({});
      return {
        tabCount: tabs.length,
        groupCount: groups.length,
        windowCount: windows.length,
      };
    }

    case "GET_AUTO_SAVE_CONFIG": {
      const config = await getAutoSaveConfig();
      return { config };
    }

    case "SET_AUTO_SAVE_CONFIG": {
      const config = await setAutoSaveConfig(message.config);
      return { config };
    }

    case "DOWNLOAD_SESSION": {
      const filename = await downloadSession(message.session);
      return { filename };
    }

    case "TRIGGER_AUTO_SAVE": {
      await handleAutoSave();
      const sessions = await getSavedSessions();
      return { sessions };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}
