(() => {
  if (globalThis.__instaScrapeInjected) {
    return;
  }
  globalThis.__instaScrapeInjected = true;

  const RESERVED_SEGMENTS = new Set([
    "about",
    "accounts",
    "api",
    "challenge",
    "developer",
    "direct",
    "directory",
    "download",
    "explore",
    "legal",
    "p",
    "privacy",
    "reel",
    "reels",
    "sessions",
    "stories",
    "terms"
  ]);
  const CURSOR_FIELD_CANDIDATES = ["after", "max_id", "cursor", "next_max_id", "end_cursor"];
  const COUNT_FIELD_CANDIDATES = ["count", "first", "page_size"];
  const BLOCKED_CAPTURE_HINTS = ["bloks", "logging", "qe", "reels", "stories", "feed", "discover"];
  const BRIDGE_INPUT_SOURCE = "INSTASCRAPE_EXTENSION";
  const BRIDGE_OUTPUT_SOURCE = "INSTASCRAPE_PAGE_BRIDGE";

  let isRunning = false;
  let lastProgressAt = 0;
  let bridgeReadyPromise = null;
  let activeCollector = null;

  window.addEventListener("message", handleBridgeMessage);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "RUN_ANALYSIS") {
      return;
    }

    if (isRunning) {
      sendResponse({ ok: false, error: "A scrape is already running in this tab." });
      return;
    }

    void runAnalysis(message.profileUsername).catch((error) => {
      reportError(error);
    });

    sendResponse({ ok: true });
  });

  async function runAnalysis(expectedUsername) {
    if (isRunning) {
      throw new Error("A scrape is already running in this tab.");
    }

    isRunning = true;
    lastProgressAt = 0;

    try {
      const profileUsername = getProfileUsername();
      if (!profileUsername || profileUsername !== expectedUsername) {
        throw new Error("Open the Instagram profile root page before starting.");
      }

      await notifyProgress({
        status: "running",
        profileUsername,
        currentList: "followers",
        strategy: "request-first",
        phase: "opening",
        pagesFetched: 0,
        stopReason: "",
        lastSeenUsername: "",
        partialCounts: {
          followers: 0,
          following: 0,
          notFollowingBack: 0,
          scrollPasses: 0,
          requestEvents: 0
        },
        note: "Opening followers.",
        followers: [],
        following: [],
        notFollowingBack: [],
        counts: {
          followers: 0,
          following: 0,
          notFollowingBack: 0
        },
        updatedAt: new Date().toISOString()
      });

      const followersResult = await collectRelationshipList({
        relationship: "followers",
        profileUsername,
        knownFollowers: []
      });

      await notifyProgress({
        status: "running",
        profileUsername,
        currentList: "following",
        strategy: followersResult.meta.strategy,
        phase: "opening",
        pagesFetched: followersResult.meta.displayProgress,
        stopReason: followersResult.meta.stopReason,
        lastSeenUsername: followersResult.meta.lastSeenUsername,
        partialCounts: {
          followers: followersResult.usernames.length,
          following: 0,
          notFollowingBack: 0,
          scrollPasses: followersResult.meta.scrollPasses,
          requestEvents: followersResult.meta.requestEvents
        },
        note: `Collected ${followersResult.usernames.length} followers. Opening following.`,
        followers: followersResult.usernames,
        following: [],
        notFollowingBack: [],
        counts: {
          followers: followersResult.usernames.length,
          following: 0,
          notFollowingBack: 0
        },
        updatedAt: new Date().toISOString()
      });

      const followingResult = await collectRelationshipList({
        relationship: "following",
        profileUsername,
        knownFollowers: followersResult.usernames
      });

      const followerSet = new Set(followersResult.usernames.map((entry) => entry.toLowerCase()));
      const notFollowingBack = followingResult.usernames.filter((username) => !followerSet.has(username.toLowerCase()));
      const finalStrategy =
        followersResult.meta.strategy === followingResult.meta.strategy ? followingResult.meta.strategy : "ui-hard-scroll";
      const finalStopReason = [
        `followers: ${followersResult.meta.strategy} (${followersResult.meta.stopReason})`,
        `following: ${followingResult.meta.strategy} (${followingResult.meta.stopReason})`
      ].join(" | ");

      await chrome.runtime.sendMessage({
        type: "SCRAPE_COMPLETE",
        payload: {
          status: "done",
          profileUsername,
          currentList: "",
          strategy: finalStrategy,
          phase: "done",
          pagesFetched: followingResult.meta.displayProgress,
          stopReason: finalStopReason,
          lastSeenUsername: followingResult.meta.lastSeenUsername,
          partialCounts: {
            followers: followersResult.usernames.length,
            following: followingResult.usernames.length,
            notFollowingBack: notFollowingBack.length,
            scrollPasses: followersResult.meta.scrollPasses + followingResult.meta.scrollPasses,
            requestEvents: followersResult.meta.requestEvents + followingResult.meta.requestEvents
          },
          note: `Finished analyzing @${profileUsername}. Followers via ${followersResult.meta.strategy}; following via ${followingResult.meta.strategy}.`,
          followers: followersResult.usernames,
          following: followingResult.usernames,
          notFollowingBack,
          counts: {
            followers: followersResult.usernames.length,
            following: followingResult.usernames.length,
            notFollowingBack: notFollowingBack.length
          }
        }
      });
    } finally {
      isRunning = false;
      activeCollector = null;
    }
  }

  async function collectRelationshipList({ relationship, profileUsername, knownFollowers }) {
    await ensureBridgeInstalled();
    await closeDialogIfOpen();

    const collector = createCollector(relationship);
    activeCollector = collector;
    sendBridgeControl("INSTASCRAPE_CAPTURE_START", {
      runId: collector.runId,
      relationship
    });

    let dialog = null;
    try {
      collector.phase = "opening";
      await emitCollectorProgress(profileUsername, relationship, knownFollowers, collector, `Opening ${relationship}.`, true);

      dialog = await openRelationshipDialog(relationship, profileUsername);
      collector.phase = "capturing";
      await emitCollectorProgress(profileUsername, relationship, knownFollowers, collector, `Capturing ${relationship} requests.`, true);

      const requestResult = await runRequestFirstCollection(dialog, collector, profileUsername, knownFollowers);

      if (!requestResult.completed) {
        collector.strategy = "ui-hard-scroll";
        collector.phase = "fallback-scrolling";
        collector.stopReason = requestResult.reason || "Request capture stalled; falling back to UI hard scroll.";
        await emitCollectorProgress(
          profileUsername,
          relationship,
          knownFollowers,
          collector,
          collector.stopReason,
          true
        );
        await runFallbackScrollCollection(dialog, collector, profileUsername, knownFollowers);
      }

      if (!collector.stopReason) {
        collector.stopReason =
          collector.strategy === "request-first"
            ? "Request pagination exhausted."
            : "UI fallback reached a stable bottom with no new users.";
      }

      return {
        usernames: collectorToSortedArray(collector),
        meta: {
          strategy: collector.strategy,
          phase: collector.phase,
          displayProgress: collector.strategy === "request-first" ? collector.pagesFetched : collector.scrollPasses,
          stopReason: collector.stopReason,
          lastSeenUsername: collector.lastSeenUsername,
          scrollPasses: collector.scrollPasses,
          requestEvents: collector.requestEvents
        }
      };
    } finally {
      sendBridgeControl("INSTASCRAPE_CAPTURE_STOP", { runId: collector.runId });
      activeCollector = null;
      if (dialog) {
        await closeDialogIfOpen();
      }
    }
  }

  async function runRequestFirstCollection(dialog, collector, profileUsername, knownFollowers) {
    let stalledPasses = 0;

    for (let pass = 1; pass <= 10; pass += 1) {
      const baselineCounter = collector.eventCounter;
      const beforeCount = collectorUserCount(collector);
      const context = resolveModalContext(dialog);
      addEntriesToCollector(collector, context.entries);

      collector.scrollPasses = pass;
      collector.phase = collector.pagesFetched > 0 ? "paging" : "capturing";
      await emitCollectorProgress(
        profileUsername,
        collector.relationship,
        knownFollowers,
        collector,
        buildCaptureNote(collector, context)
      );

      await hardScrollDialog(context);
      const hadActivity = await waitForCollectorActivity(collector, baselineCounter, 2500);

      addEntriesToCollector(collector, resolveModalContext(dialog).entries);

      if (collector.hasNextPage === false) {
        collector.stopReason = "Request pagination exhausted.";
        return { completed: true };
      }

      if (collector.template && collector.nextCursor) {
        const replayResult = await replayRemainingPages(collector, profileUsername, knownFollowers);
        if (replayResult.completed) {
          return replayResult;
        }
      }

      const addedUsers = collectorUserCount(collector) - beforeCount;
      if (!hadActivity && addedUsers === 0) {
        stalledPasses += 1;
      } else {
        stalledPasses = 0;
      }

      if (stalledPasses >= 3) {
        break;
      }
    }

    return {
      completed: collector.hasNextPage === false,
      reason: collector.pagesFetched
        ? "Request capture stalled before completion; switching to UI hard scroll."
        : "No usable request capture detected; switching to UI hard scroll."
    };
  }

  async function replayRemainingPages(collector, profileUsername, knownFollowers) {
    collector.phase = "paging";
    let zeroNewPagesWithoutCursor = 0;

    while (collector.template && collector.hasNextPage !== false && collector.nextCursor && collector.pagesFetched < 200) {
      const request = materializeReplayRequest(collector.template, collector.nextCursor);
      if (!request) {
        return { completed: false, reason: "Captured request could not be replayed." };
      }

      const replaySignature = `${request.method} ${request.url} ${request.body || ""}`;
      if (collector.replayedSignatures.has(replaySignature)) {
        return { completed: false, reason: "Replay cursor repeated before exhaustion." };
      }
      collector.replayedSignatures.add(replaySignature);

      const beforeCount = collectorUserCount(collector);
      const baselineCounter = collector.eventCounter;

      sendBridgeControl("INSTASCRAPE_REQUEST_PAGE", {
        runId: collector.runId,
        request
      });

      const hadActivity = await waitForCollectorActivity(collector, baselineCounter, 4500);
      const addedUsers = collectorUserCount(collector) - beforeCount;

      await emitCollectorProgress(
        profileUsername,
        collector.relationship,
        knownFollowers,
        collector,
        `Fetched ${collector.pagesFetched} request page${collector.pagesFetched === 1 ? "" : "s"} for ${collector.relationship}.`
      );

      if (!hadActivity) {
        return { completed: false, reason: "Replayed request did not return usable data." };
      }

      if (collector.hasNextPage === false) {
        collector.stopReason = "Request pagination exhausted.";
        return { completed: true };
      }

      if (addedUsers === 0 && !collector.nextCursor) {
        zeroNewPagesWithoutCursor += 1;
      } else {
        zeroNewPagesWithoutCursor = 0;
      }

      if (zeroNewPagesWithoutCursor >= 2) {
        collector.stopReason = "Two request pages returned no new users and no next cursor.";
        return { completed: true };
      }

      if (addedUsers === 0 && collector.nextCursor) {
        return { completed: false, reason: "Request pages are not adding new users while cursors keep advancing." };
      }
    }

    return { completed: collector.hasNextPage === false };
  }

  async function runFallbackScrollCollection(dialog, collector, profileUsername, knownFollowers) {
    let stableBottomPasses = 0;

    for (let pass = 1; pass <= 120; pass += 1) {
      const context = resolveModalContext(dialog);
      addEntriesToCollector(collector, context.entries);
      const beforeCount = collectorUserCount(collector);
      const beforeFingerprint = context.fingerprint;

      collector.scrollPasses = pass;
      await emitCollectorProgress(
        profileUsername,
        collector.relationship,
        knownFollowers,
        collector,
        buildFallbackNote(collector, context)
      );

      const moved = await hardScrollDialog(context);
      await waitForDomAdvance(dialog, context.scroller, beforeFingerprint, 2400);

      const refreshedContext = resolveModalContext(dialog);
      addEntriesToCollector(collector, refreshedContext.entries);
      const afterFingerprint = refreshedContext.fingerprint;
      const addedUsers = collectorUserCount(collector) - beforeCount;
      const atBottom = isAtScrollEnd(refreshedContext.scroller);

      const unchangedFingerprint =
        beforeFingerprint.scrollTop === afterFingerprint.scrollTop &&
        beforeFingerprint.scrollHeight === afterFingerprint.scrollHeight &&
        beforeFingerprint.tailKey === afterFingerprint.tailKey;

      if ((addedUsers === 0 && unchangedFingerprint && atBottom) || (!moved && atBottom)) {
        stableBottomPasses += 1;
      } else {
        stableBottomPasses = 0;
      }

      if (stableBottomPasses >= 3) {
        collector.stopReason = "UI fallback reached a stable bottom with no new users.";
        return;
      }
    }

    collector.stopReason = "UI fallback hit the scroll pass limit.";
  }

  function createCollector(relationship) {
    return {
      runId: makeRunId(),
      relationship,
      strategy: "request-first",
      phase: "opening",
      pagesFetched: 0,
      requestEvents: 0,
      scrollPasses: 0,
      stopReason: "",
      lastSeenUsername: "",
      hasNextPage: null,
      nextCursor: "",
      template: null,
      userMap: new Map(),
      requestSignatures: new Set(),
      replayedSignatures: new Set(),
      eventCounter: 0
    };
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== BRIDGE_OUTPUT_SOURCE || !activeCollector) {
      return;
    }

    if (data.type !== "INSTASCRAPE_CAPTURE_EVENT") {
      return;
    }

    const payload = data.payload || {};
    if (payload.runId !== activeCollector.runId) {
      return;
    }

    if (payload.kind === "capture-started" || payload.kind === "capture-stopped") {
      bumpCollectorActivity(activeCollector);
      return;
    }

    if (payload.kind === "replay-error") {
      activeCollector.stopReason = payload.error || "Replay request failed.";
      bumpCollectorActivity(activeCollector);
      return;
    }

    if (payload.kind !== "network-response") {
      return;
    }

    const candidate = analyzeCapturedResponse(payload, activeCollector.relationship);
    if (!candidate.accepted) {
      return;
    }

    const requestKey = buildRequestSignature(payload.request);
    if (!activeCollector.requestSignatures.has(requestKey)) {
      activeCollector.requestSignatures.add(requestKey);
      activeCollector.pagesFetched += 1;
    }

    activeCollector.requestEvents += 1;
    addUsernames(activeCollector, candidate.usernames);

    if (candidate.pagination) {
      activeCollector.hasNextPage = candidate.pagination.hasNextPage;
      activeCollector.nextCursor = candidate.pagination.nextCursor || "";
      if (!activeCollector.template) {
        activeCollector.template = buildReplayTemplate(payload.request, candidate.pagination);
      }
    }

    if (candidate.pagination?.hasNextPage === false) {
      activeCollector.stopReason = "Request pagination exhausted.";
    }

    bumpCollectorActivity(activeCollector);
  }

  function analyzeCapturedResponse(payload, relationship) {
    const analysis = inspectResponseJson(payload.response?.json);
    const score = scoreCaptureCandidate(payload.request, analysis, relationship);
    return {
      accepted: score >= 65 && analysis.usernames.length >= 3,
      usernames: analysis.usernames,
      pagination: analysis.pagination,
      score
    };
  }

  function inspectResponseJson(root) {
    const usernames = new Map();
    const paginationCandidates = [];

    walkJson(root, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return;
      }

      if (isLikelyUserObject(node) && looksLikeUsername(node.username)) {
        const lower = node.username.toLowerCase();
        if (!usernames.has(lower)) {
          usernames.set(lower, node.username.trim());
        }
      }

      const pagination = readPaginationCandidate(node);
      if (pagination) {
        paginationCandidates.push(pagination);
      }
    });

    return {
      usernames: Array.from(usernames.values()),
      pagination: pickPaginationCandidate(paginationCandidates)
    };
  }

  function walkJson(node, visitor) {
    if (Array.isArray(node)) {
      for (const entry of node) {
        walkJson(entry, visitor);
      }
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    visitor(node);
    for (const value of Object.values(node)) {
      walkJson(value, visitor);
    }
  }

  function isLikelyUserObject(node) {
    return (
      typeof node?.username === "string" &&
      (typeof node.id === "string" ||
        typeof node.id === "number" ||
        typeof node.pk === "string" ||
        typeof node.pk === "number" ||
        typeof node.full_name === "string" ||
        typeof node.profile_pic_url === "string" ||
        typeof node.profile_pic_url_hd === "string")
    );
  }

  function readPaginationCandidate(node) {
    if (node.page_info && typeof node.page_info === "object") {
      return {
        hasNextPage: Boolean(node.page_info.has_next_page),
        nextCursor: typeof node.page_info.end_cursor === "string" ? node.page_info.end_cursor : "",
        cursorField: "after"
      };
    }

    if (typeof node.next_max_id === "string" || typeof node.next_max_id === "number") {
      return {
        hasNextPage: Boolean(node.next_max_id),
        nextCursor: String(node.next_max_id || ""),
        cursorField: "max_id"
      };
    }

    if (typeof node.next_cursor === "string") {
      return {
        hasNextPage: Boolean(node.next_cursor),
        nextCursor: node.next_cursor,
        cursorField: "cursor"
      };
    }

    if (typeof node.has_next_page === "boolean" || typeof node.end_cursor === "string") {
      return {
        hasNextPage: Boolean(node.has_next_page),
        nextCursor: typeof node.end_cursor === "string" ? node.end_cursor : "",
        cursorField: "after"
      };
    }

    return null;
  }

  function pickPaginationCandidate(candidates) {
    if (!candidates.length) {
      return null;
    }

    return candidates.sort((left, right) => {
      const leftScore = (left.nextCursor ? 2 : 0) + (left.hasNextPage ? 1 : 0);
      const rightScore = (right.nextCursor ? 2 : 0) + (right.hasNextPage ? 1 : 0);
      return rightScore - leftScore;
    })[0];
  }

  function scoreCaptureCandidate(request, analysis, relationship) {
    const requestText = [request?.url || "", request?.body || ""].join(" ").toLowerCase();
    let score = 0;

    if (requestText.includes(relationship)) {
      score += 45;
    }
    if (requestText.includes("friendship") || requestText.includes("follow")) {
      score += 35;
    }
    if (requestText.includes("graphql") || requestText.includes("/api/")) {
      score += 15;
    }
    if (BLOCKED_CAPTURE_HINTS.some((hint) => requestText.includes(hint))) {
      score -= 40;
    }

    score += Math.min(analysis.usernames.length, 25) * 4;
    if (analysis.pagination) {
      score += 20;
    }

    return score;
  }

  function buildReplayTemplate(request, pagination) {
    if (!request?.url || !request?.method) {
      return null;
    }

    const headers = sanitizeReplayHeaders(request.headers || {});
    const url = new URL(request.url, window.location.origin);
    const bodyPayload = parseRequestPayload(request.body || "", headers["content-type"] || "");
    const queryPayload = parseKeyValuePayload(url.searchParams);

    return {
      method: request.method,
      url: `${url.origin}${url.pathname}`,
      headers,
      cursorField: pagination?.cursorField || "after",
      queryPayload,
      bodyPayload
    };
  }

  function sanitizeReplayHeaders(headers) {
    const output = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (!value) {
        continue;
      }
      if (["content-length", "cookie", "host", "origin", "referer"].includes(lower)) {
        continue;
      }
      output[lower] = String(value);
    }
    return output;
  }

  function parseRequestPayload(body, contentType) {
    if (!body) {
      return { kind: "none", value: null };
    }

    const trimmed = String(body).trim();
    if (!trimmed) {
      return { kind: "none", value: null };
    }

    if (contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { kind: "json", value: JSON.parse(trimmed) };
      } catch (error) {
        return { kind: "text", value: trimmed };
      }
    }

    if (contentType.includes("application/x-www-form-urlencoded") || trimmed.includes("=")) {
      return { kind: "form", value: parseKeyValuePayload(new URLSearchParams(trimmed)) };
    }

    return { kind: "text", value: trimmed };
  }

  function parseKeyValuePayload(searchParams) {
    const output = {};
    for (const [key, value] of searchParams.entries()) {
      output[key] = parseMaybeJson(value);
    }
    return output;
  }

  function parseMaybeJson(value) {
    const trimmed = String(value).trim();
    if (!trimmed) {
      return trimmed;
    }
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return trimmed;
      }
    }
    return trimmed;
  }

  function materializeReplayRequest(template, cursor) {
    const url = new URL(template.url);
    const queryPayload = deepClone(template.queryPayload);
    const bodyPayload = deepClone(template.bodyPayload);

    applyCursorMutation(queryPayload, template.cursorField, cursor);
    applyCountMutation(queryPayload);

    applyCursorMutation(bodyPayload.value, template.cursorField, cursor);
    applyCountMutation(bodyPayload.value);

    for (const [key, value] of Object.entries(queryPayload)) {
      url.searchParams.set(key, serializePayloadValue(value));
    }

    let body = null;
    if (bodyPayload.kind === "json") {
      body = JSON.stringify(bodyPayload.value);
    } else if (bodyPayload.kind === "form") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(bodyPayload.value || {})) {
        params.set(key, serializePayloadValue(value));
      }
      body = params.toString();
    } else if (bodyPayload.kind === "text") {
      body = String(bodyPayload.value);
    }

    return {
      url: url.toString(),
      method: template.method,
      headers: template.headers,
      body
    };
  }

  function applyCursorMutation(value, cursorField, cursor) {
    if (!value || typeof value !== "object") {
      return false;
    }

    const mutated = mutateExistingCursorFields(value, cursor);
    if (mutated) {
      return true;
    }

    if (value.variables && typeof value.variables === "object" && !Array.isArray(value.variables)) {
      value.variables[cursorField] = cursor;
      return true;
    }

    if (typeof value.variables === "string" && looksLikeJsonString(value.variables)) {
      try {
        const parsed = JSON.parse(value.variables);
        parsed[cursorField] = cursor;
        value.variables = JSON.stringify(parsed);
        return true;
      } catch (error) {
        // ignore malformed JSON fragments
      }
    }

    value[cursorField] = cursor;
    return true;
  }

  function mutateExistingCursorFields(value, cursor) {
    if (!value || typeof value !== "object") {
      return false;
    }

    let mutated = false;

    for (const key of Object.keys(value)) {
      if (CURSOR_FIELD_CANDIDATES.includes(key)) {
        value[key] = cursor;
        mutated = true;
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && looksLikeJsonString(child)) {
        try {
          const parsed = JSON.parse(child);
          if (mutateExistingCursorFields(parsed, cursor)) {
            value[key] = JSON.stringify(parsed);
            mutated = true;
          }
        } catch (error) {
          // ignore malformed JSON fragments
        }
      } else if (child && typeof child === "object" && mutateExistingCursorFields(child, cursor)) {
        mutated = true;
      }
    }

    return mutated;
  }

  function applyCountMutation(value) {
    if (!value || typeof value !== "object") {
      return false;
    }

    let mutated = false;

    for (const key of Object.keys(value)) {
      if (COUNT_FIELD_CANDIDATES.includes(key) && typeof value[key] !== "object") {
        value[key] = 50;
        mutated = true;
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && looksLikeJsonString(child)) {
        try {
          const parsed = JSON.parse(child);
          if (applyCountMutation(parsed)) {
            value[key] = JSON.stringify(parsed);
            mutated = true;
          }
        } catch (error) {
          // ignore malformed JSON fragments
        }
      } else if (child && typeof child === "object" && applyCountMutation(child)) {
        mutated = true;
      }
    }

    return mutated;
  }

  function looksLikeJsonString(value) {
    const trimmed = String(value).trim();
    return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
  }

  function buildRequestSignature(request) {
    return `${request?.method || "GET"} ${request?.url || ""} ${request?.body || ""}`;
  }

  function addEntriesToCollector(collector, entries) {
    addUsernames(
      collector,
      entries.map((entry) => entry.username)
    );
  }

  function addUsernames(collector, usernames) {
    let addedUsers = 0;
    for (const username of usernames) {
      if (!looksLikeUsername(username)) {
        continue;
      }

      const normalized = username.trim();
      const lower = normalized.toLowerCase();
      if (!collector.userMap.has(lower)) {
        collector.userMap.set(lower, normalized);
        addedUsers += 1;
      }
      collector.lastSeenUsername = normalized;
    }
    return addedUsers;
  }

  function waitForCollectorActivity(collector, baselineCounter, timeoutMs) {
    if (collector.eventCounter > baselineCounter) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let finished = false;
      const timeoutId = window.setTimeout(() => {
        finished = true;
        resolve(false);
      }, timeoutMs);

      const poll = () => {
        if (finished) {
          return;
        }
        if (collector.eventCounter > baselineCounter) {
          finished = true;
          window.clearTimeout(timeoutId);
          resolve(true);
          return;
        }
        window.setTimeout(poll, 120);
      };

      poll();
    });
  }

  function bumpCollectorActivity(collector) {
    collector.eventCounter += 1;
  }

  async function emitCollectorProgress(profileUsername, relationship, knownFollowers, collector, note, force = false) {
    const now = Date.now();
    if (!force && now - lastProgressAt < 450) {
      return;
    }

    lastProgressAt = now;
    const currentList = collectorToSortedArray(collector);
    const followers = relationship === "followers" ? currentList : knownFollowers;
    const following = relationship === "following" ? currentList : [];
    const followerSet = new Set(followers.map((entry) => entry.toLowerCase()));
    const notFollowingBack =
      relationship === "following"
        ? following.filter((username) => !followerSet.has(username.toLowerCase()))
        : [];

    await notifyProgress({
      status: "running",
      profileUsername,
      currentList: relationship,
      strategy: collector.strategy,
      phase: collector.phase,
      pagesFetched: collector.strategy === "request-first" ? collector.pagesFetched : collector.scrollPasses,
      stopReason: collector.stopReason,
      lastSeenUsername: collector.lastSeenUsername,
      partialCounts: {
        followers: followers.length,
        following: following.length,
        notFollowingBack: notFollowingBack.length,
        scrollPasses: collector.scrollPasses,
        requestEvents: collector.requestEvents
      },
      note,
      followers,
      following,
      notFollowingBack,
      counts: {
        followers: followers.length,
        following: following.length,
        notFollowingBack: notFollowingBack.length
      },
      updatedAt: new Date().toISOString()
    });
  }

  async function notifyProgress(payload) {
    await chrome.runtime.sendMessage({
      type: "SCRAPE_PROGRESS",
      payload
    });
  }

  function reportError(error) {
    const collector = activeCollector;

    void chrome.runtime.sendMessage({
      type: "SCRAPE_ERROR",
      error: error.message,
      note: collector?.stopReason || "The scrape stopped before completion. Instagram may have interrupted the session.",
      strategy: collector?.strategy || "request-first",
      phase: "error",
      pagesFetched: collector ? (collector.strategy === "request-first" ? collector.pagesFetched : collector.scrollPasses) : 0,
      stopReason: collector?.stopReason || error.message,
      lastSeenUsername: collector?.lastSeenUsername || "",
      partialCounts: {
        followers: 0,
        following: 0,
        notFollowingBack: 0,
        scrollPasses: collector?.scrollPasses || 0,
        requestEvents: collector?.requestEvents || 0
      }
    });
  }

  async function ensureBridgeInstalled() {
    if (bridgeReadyPromise) {
      return bridgeReadyPromise;
    }

    bridgeReadyPromise = new Promise((resolve, reject) => {
      const existing = document.getElementById("instascrape-page-bridge");
      if (existing) {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.id = "instascrape-page-bridge";
      script.src = chrome.runtime.getURL("page-bridge.js");
      script.async = false;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to install the page bridge."));
      (document.head || document.documentElement).appendChild(script);
    });

    return bridgeReadyPromise;
  }

  function sendBridgeControl(type, payload) {
    window.postMessage(
      {
        source: BRIDGE_INPUT_SOURCE,
        type,
        payload
      },
      window.location.origin
    );
  }

  async function openRelationshipDialog(relationship, profileUsername) {
    const trigger = await waitForElement(() => findRelationshipTrigger(relationship, profileUsername), 10000);
    trigger.click();
    return await waitForElement(() => findRelationshipDialog(relationship), 10000);
  }

  function findRelationshipTrigger(relationship, profileUsername) {
    const expectedPath = `/${profileUsername}/${relationship}/`;
    const header = document.querySelector("header") || document.querySelector("main");
    const candidates = Array.from((header || document).querySelectorAll("a[href], button"));

    const exactAnchor = candidates.find((candidate) => {
      if (candidate.tagName !== "A") {
        return false;
      }
      const url = normalizeUrl(candidate.getAttribute("href"));
      return url?.pathname === expectedPath;
    });

    if (exactAnchor) {
      return exactAnchor;
    }

    const fallback = candidates
      .filter((candidate) => {
        const label = candidate.textContent?.replace(/\s+/g, " ").trim().toLowerCase();
        return Boolean(label && label.includes(relationship));
      })
      .sort((left, right) => scoreRelationshipTrigger(right, relationship) - scoreRelationshipTrigger(left, relationship))[0];

    return fallback || null;
  }

  function scoreRelationshipTrigger(candidate, relationship) {
    const label = candidate.textContent?.replace(/\s+/g, " ").trim().toLowerCase() || "";
    const hasDigits = /\d/.test(label);
    const startsWithRelationship = label.startsWith(relationship);
    return (hasDigits ? 100 : 0) + (startsWithRelationship ? 20 : 0) + (candidate.tagName === "A" ? 10 : 0);
  }

  function findRelationshipDialog(relationship) {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    for (const dialog of dialogs.reverse()) {
      const headingText = Array.from(dialog.querySelectorAll("h1, h2, h3, [role='heading']"))
        .map((node) => node.textContent?.trim().toLowerCase() || "")
        .join(" ");
      if (headingText.includes(relationship)) {
        return dialog;
      }
    }

    return dialogs.at(-1) || null;
  }

  function resolveModalContext(dialog) {
    const entries = getRelationshipEntries(dialog);
    const scroller = detectListScroller(dialog, entries);
    return {
      dialog,
      entries,
      scroller,
      fingerprint: createBottomFingerprint(scroller, entries),
      tailUsernames: entries.slice(-2).map((entry) => entry.username)
    };
  }

  function getRelationshipEntries(root) {
    const entries = [];
    const seen = new Set();

    for (const anchor of root.querySelectorAll("a[href]")) {
      const username = readUsernameFromAnchor(anchor);
      if (!username || !anchor.getClientRects().length) {
        continue;
      }

      const lower = username.toLowerCase();
      if (seen.has(lower)) {
        continue;
      }

      seen.add(lower);
      const rect = anchor.getBoundingClientRect();
      entries.push({
        anchor,
        username,
        top: rect.top,
        left: rect.left
      });
    }

    return entries.sort((left, right) => {
      if (left.top !== right.top) {
        return left.top - right.top;
      }
      return left.left - right.left;
    });
  }

  function detectListScroller(dialog, entries) {
    const candidateScores = new Map();

    for (const entry of entries) {
      let current = entry.anchor.parentElement;
      while (current && current !== dialog) {
        if (isScrollableElement(current)) {
          candidateScores.set(current, (candidateScores.get(current) || 0) + 1);
        }
        current = current.parentElement;
      }
    }

    if (candidateScores.size) {
      return Array.from(candidateScores.entries())
        .sort((left, right) => scoreScrollerCandidate(right[0], right[1]) - scoreScrollerCandidate(left[0], left[1]))[0][0];
    }

    const descendantCandidates = Array.from(dialog.querySelectorAll("div, section, ul, ol")).filter((element) =>
      isScrollableElement(element)
    );

    return descendantCandidates.sort((left, right) => scoreScrollerCandidate(right, 0) - scoreScrollerCandidate(left, 0))[0] || null;
  }

  function isScrollableElement(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    return (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay" || element.scrollHeight > element.clientHeight + 16) &&
      element.clientHeight > 140
    );
  }

  function scoreScrollerCandidate(element, anchorHits) {
    const area = Math.max(element.clientWidth * element.clientHeight, 1);
    return anchorHits * 1000 + Math.round(area / 2000);
  }

  async function hardScrollDialog(context) {
    const lastAnchor = context.entries.at(-1)?.anchor || null;
    if (lastAnchor) {
      lastAnchor.scrollIntoView({
        block: "end",
        inline: "nearest"
      });
      await sleep(160);
    }

    if (!context.scroller) {
      return Boolean(lastAnchor);
    }

    const beforeScrollTop = context.scroller.scrollTop;
    context.scroller.scrollTop = context.scroller.scrollHeight;
    context.scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(120);

    if (context.scroller.scrollTop === beforeScrollTop && !isAtScrollEnd(context.scroller)) {
      context.scroller.scrollTop = Math.min(
        beforeScrollTop + Math.max(context.scroller.clientHeight * 1.5, 960),
        context.scroller.scrollHeight
      );
      context.scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    return context.scroller.scrollTop !== beforeScrollTop || !isAtScrollEnd(context.scroller);
  }

  function createBottomFingerprint(scroller, entries) {
    return {
      scrollTop: Math.round(scroller?.scrollTop || 0),
      scrollHeight: Math.round(scroller?.scrollHeight || 0),
      tailKey: entries
        .slice(-2)
        .map((entry) => entry.username.toLowerCase())
        .join("|")
    };
  }

  function isAtScrollEnd(scroller) {
    if (!scroller) {
      return false;
    }

    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
  }

  async function waitForDomAdvance(dialog, scroller, beforeFingerprint, timeoutMs) {
    let mutationSeen = false;
    const observer = new MutationObserver(() => {
      mutationSeen = true;
    });

    observer.observe(dialog, {
      childList: true,
      subtree: true
    });

    try {
      const startedAt = Date.now();
      let spinnerWasVisible = isSpinnerVisible(dialog);

      while (Date.now() - startedAt < timeoutMs) {
        const currentFingerprint = createBottomFingerprint(scroller, getRelationshipEntries(dialog));
        const spinnerVisible = isSpinnerVisible(dialog);

        if (
          mutationSeen ||
          spinnerWasVisible !== spinnerVisible ||
          currentFingerprint.scrollTop !== beforeFingerprint.scrollTop ||
          currentFingerprint.scrollHeight !== beforeFingerprint.scrollHeight ||
          currentFingerprint.tailKey !== beforeFingerprint.tailKey
        ) {
          await sleep(260);
          return;
        }

        spinnerWasVisible = spinnerVisible;
        await sleep(160);
      }
    } finally {
      observer.disconnect();
    }

    await sleep(220);
  }

  function isSpinnerVisible(dialog) {
    return Boolean(
      dialog.querySelector('[role="progressbar"], [aria-busy="true"], svg[aria-label*="Loading"], svg[aria-label*="loading"]')
    );
  }

  async function closeDialogIfOpen() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      return;
    }

    const closeButton =
      Array.from(dialog.querySelectorAll("button")).find((button) => {
        const label = [button.getAttribute("aria-label"), button.textContent]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return label.includes("close");
      }) || null;

    if (closeButton) {
      closeButton.click();
      await waitFor(() => !document.querySelector('[role="dialog"]'), 3000);
      return;
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !document.querySelector('[role="dialog"]'), 3000);
  }

  function readUsernameFromAnchor(anchor) {
    const url = normalizeUrl(anchor.getAttribute("href"));
    if (!url) {
      return "";
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) {
      return "";
    }

    const candidate = segments[0].trim();
    if (!looksLikeUsername(candidate) || RESERVED_SEGMENTS.has(candidate.toLowerCase())) {
      return "";
    }

    return candidate;
  }

  function looksLikeUsername(value) {
    return typeof value === "string" && /^[a-z0-9._]{1,30}$/i.test(value.trim());
  }

  function normalizeUrl(href) {
    if (!href) {
      return null;
    }

    try {
      return new URL(href, window.location.origin);
    } catch (error) {
      return null;
    }
  }

  function getProfileUsername() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) {
      return "";
    }

    const username = segments[0].trim();
    return RESERVED_SEGMENTS.has(username.toLowerCase()) ? "" : username;
  }

  function makeRunId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function serializePayloadValue(value) {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  function deepClone(value) {
    if (value === null || value === undefined) {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function buildCaptureNote(collector, context) {
    return `Capturing ${collector.relationship}: ${collectorUserCount(collector)} users, ${collector.pagesFetched} request page${collector.pagesFetched === 1 ? "" : "s"}, tail ${context.tailUsernames.join(" -> ") || "none"}.`;
  }

  function buildFallbackNote(collector, context) {
    return `Fallback scroll ${collector.scrollPasses}: ${collectorUserCount(collector)} users, tail ${context.tailUsernames.join(" -> ") || "none"}, request pages ${collector.pagesFetched}.`;
  }

  async function waitForElement(getElement, timeoutMs) {
    const result = await waitFor(() => getElement(), timeoutMs);
    if (!result) {
      throw new Error("Instagram did not render the expected panel in time.");
    }
    return result;
  }

  async function waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = predicate();
      if (value) {
        return value;
      }
      await sleep(150);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function collectorToSortedArray(collector) {
    if (!collector?.userMap || !(collector.userMap instanceof Map)) {
      return [];
    }
    return Array.from(collector.userMap.values()).sort((left, right) => left.localeCompare(right));
  }

  function collectorUserCount(collector) {
    if (!collector?.userMap || !(collector.userMap instanceof Map)) {
      return 0;
    }
    return collector.userMap.size;
  }
})();
