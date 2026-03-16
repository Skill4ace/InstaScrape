const startButton = document.getElementById("startButton");
const resetButton = document.getElementById("resetButton");
const profileLabel = document.getElementById("profileLabel");
const statusBadge = document.getElementById("statusBadge");
const updatedLabel = document.getElementById("updatedLabel");
const noteLabel = document.getElementById("note");
const strategyValue = document.getElementById("strategyValue");
const phaseValue = document.getElementById("phaseValue");
const pagesValue = document.getElementById("pagesValue");
const lastSeenValue = document.getElementById("lastSeenValue");
const stopReasonValue = document.getElementById("stopReasonValue");
const followersCount = document.getElementById("followersCount");
const followingCount = document.getElementById("followingCount");
const diffCount = document.getElementById("diffCount");
const followersMeta = document.getElementById("followersMeta");
const followingMeta = document.getElementById("followingMeta");
const diffMeta = document.getElementById("diffMeta");
const followersList = document.getElementById("followersList");
const followingList = document.getElementById("followingList");
const diffList = document.getElementById("diffList");

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "START_ANALYSIS" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to start analysis.");
    }
    renderState(response.state);
  } catch (error) {
    renderError(error.message);
  }
});

resetButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "RESET_ANALYSIS" });
  renderState(response.state);
});

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = button.dataset.copyTarget;
    const state = await loadState();
    const text = (state?.[target] || []).join("\n");
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_UPDATED" && message.state) {
    renderState(message.state);
  }
});

void init();

async function init() {
  const state = await loadState();
  renderState(state);
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_ANALYSIS_STATE" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load extension state.");
  }
  return response.state;
}

function renderState(state = {}) {
  profileLabel.textContent = state.profileUsername ? `@${state.profileUsername}` : "No profile selected";
  statusBadge.textContent = titleCase(state.status || "idle");
  statusBadge.className = `badge ${state.status || "idle"}`;
  updatedLabel.textContent = formatDate(state.updatedAt);
  noteLabel.textContent = state.error || state.note || "Ready.";
  strategyValue.textContent = titleCase(state.strategy || "-");
  phaseValue.textContent = titleCase(state.phase || "-");
  pagesValue.textContent = String(state.pagesFetched || 0);
  lastSeenValue.textContent = state.lastSeenUsername || "-";
  stopReasonValue.textContent = state.stopReason || "No stop reason yet.";

  followersCount.textContent = formatCount(state.counts?.followers);
  followingCount.textContent = formatCount(state.counts?.following);
  diffCount.textContent = formatCount(state.counts?.notFollowingBack);

  renderLog(followersList, followersMeta, state.followers, "Followers will appear here.");
  renderLog(followingList, followingMeta, state.following, "Following will appear here.");
  renderLog(diffList, diffMeta, state.notFollowingBack, "The comparison result will appear here.");

  startButton.disabled = state.status === "starting" || state.status === "running";
}

function renderLog(container, meta, values = [], emptyText) {
  const lines = Array.isArray(values) ? values : [];
  meta.textContent = `${lines.length} username${lines.length === 1 ? "" : "s"}`;
  if (!lines.length) {
    container.textContent = emptyText;
    container.classList.add("empty");
    return;
  }

  container.textContent = lines.join("\n");
  container.classList.remove("empty");
}

function renderError(message) {
  renderState({
    status: "error",
    note: message,
    error: message,
    counts: {
      followers: 0,
      following: 0,
      notFollowingBack: 0
    },
    followers: [],
    following: [],
    notFollowingBack: []
  });
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(value) {
  if (!value) {
    return "No run yet";
  }

  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function titleCase(value) {
  return String(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(" ");
}
