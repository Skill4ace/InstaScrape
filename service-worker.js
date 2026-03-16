const STORAGE_KEY = "analysisState";
const DEFAULT_STATE = Object.freeze({
  status: "idle",
  profileUsername: "",
  currentList: "",
  strategy: "",
  phase: "",
  pagesFetched: 0,
  stopReason: "",
  lastSeenUsername: "",
  note: "Open an Instagram profile and start an analysis.",
  startedAt: null,
  finishedAt: null,
  updatedAt: null,
  activeTabId: null,
  followers: [],
  following: [],
  notFollowingBack: [],
  counts: {
    followers: 0,
    following: 0,
    notFollowingBack: 0
  },
  partialCounts: {
    followers: 0,
    following: 0,
    notFollowingBack: 0,
    scrollPasses: 0,
    requestEvents: 0
  },
  error: ""
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_STATE });
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onStartup?.addListener(async () => {
  await ensureState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_ANALYSIS_STATE":
      return { state: await getState() };
    case "RESET_ANALYSIS":
    await saveState(DEFAULT_STATE);
    return { state: DEFAULT_STATE };
    case "START_ANALYSIS":
      return { state: await startAnalysis() };
    case "SCRAPE_PROGRESS":
      await mergeState(message.payload);
      return { state: await getState() };
    case "SCRAPE_COMPLETE":
      await mergeState({
        ...message.payload,
        status: "done",
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: ""
      });
      return { state: await getState() };
    case "SCRAPE_ERROR":
      await mergeState({
        strategy: message.strategy || "",
        phase: message.phase || "error",
        pagesFetched: message.pagesFetched || 0,
        stopReason: message.stopReason || message.error || "",
        lastSeenUsername: message.lastSeenUsername || "",
        partialCounts: message.partialCounts || {},
        status: "error",
        error: message.error || "Unknown scraping error.",
        note: message.note || "Instagram blocked the scrape or the page layout changed.",
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return { state: await getState() };
    default:
      return {};
  }
}

async function startAnalysis() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab.url) {
    throw new Error("No active tab found.");
  }

  if (!tab.url.startsWith("https://www.instagram.com/")) {
    throw new Error("Open an Instagram profile tab before starting.");
  }

  const profileUsername = extractProfileUsername(tab.url);
  if (!profileUsername) {
    throw new Error("Open a public Instagram profile root page before starting.");
  }

  const nextState = {
    ...DEFAULT_STATE,
    status: "starting",
    profileUsername,
    activeTabId: tab.id,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    note: `Injecting scraper into @${profileUsername}.`
  };

  await saveState(nextState);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_ANALYSIS",
      profileUsername
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The scraper did not accept the run request.");
    }
  } catch (error) {
    await saveState({
      ...nextState,
      status: "error",
      error: error.message,
      note: "The scraper could not attach to the Instagram tab.",
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    throw error;
  }

  return await getState();
}

function extractProfileUsername(tabUrl) {
  const url = new URL(tabUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return "";
  }

  const candidate = segments[0].trim();
  const reserved = new Set([
    "accounts",
    "direct",
    "explore",
    "legal",
    "p",
    "reel",
    "reels",
    "stories"
  ]);

  if (!candidate || reserved.has(candidate.toLowerCase())) {
    return "";
  }

  return candidate;
}

async function ensureState() {
  const current = await chrome.storage.local.get(STORAGE_KEY);
  if (!current?.[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_STATE });
  }
}

async function getState() {
  await ensureState();
  const current = await chrome.storage.local.get(STORAGE_KEY);
  return current[STORAGE_KEY];
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  await broadcastState(state);
}

async function mergeState(patch) {
  const current = await getState();
  const nextState = {
    ...current,
    ...patch,
    counts: {
      ...current.counts,
      ...(patch.counts || {})
    },
    partialCounts: {
      ...current.partialCounts,
      ...(patch.partialCounts || {})
    }
  };
  await saveState(nextState);
}

async function broadcastState(state) {
  try {
    await chrome.runtime.sendMessage({
      type: "STATE_UPDATED",
      state
    });
  } catch (error) {
    if (!String(error?.message || "").includes("Receiving end does not exist")) {
      console.warn("Failed to broadcast state update.", error);
    }
  }
}
