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
  let isRunning = false;
  let lastProgressAt = 0;

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

      const followers = await scrapeRelationshipList("followers", profileUsername);
      await notifyProgress({
        status: "running",
        profileUsername,
        currentList: "following",
        note: `Collected ${followers.length} followers. Opening following.`,
        followers,
        counts: {
          followers: followers.length
        },
        updatedAt: new Date().toISOString()
      });

      const following = await scrapeRelationshipList("following", profileUsername, followers);
      const followerSet = new Set(followers.map((entry) => entry.toLowerCase()));
      const notFollowingBack = following.filter((username) => !followerSet.has(username.toLowerCase()));

      await chrome.runtime.sendMessage({
        type: "SCRAPE_COMPLETE",
        payload: {
          status: "done",
          profileUsername,
          currentList: "",
          note: `Finished analyzing @${profileUsername}.`,
          followers,
          following,
          notFollowingBack,
          counts: {
            followers: followers.length,
            following: following.length,
            notFollowingBack: notFollowingBack.length
          }
        }
      });
    } finally {
      isRunning = false;
    }
  }

  async function scrapeRelationshipList(relationship, profileUsername, followers = []) {
    await closeDialogIfOpen();
    const dialog = await openRelationshipDialog(relationship, profileUsername);
    const collected = new Set();
    let stagnantPasses = 0;

    for (let iteration = 0; iteration < 800; iteration += 1) {
      const context = resolveListContext(dialog);
      collectEntries(context.entries, collected);
      await maybeSendListProgress(relationship, profileUsername, collected, followers, context);

      const before = captureScrollState(context.scroller, context.collectionRoot, collected.size);
      const moved = await nudgeRelationshipList(context);
      await waitForListAdvance(dialog, context.scroller, before, 1800);

      const refreshedContext = resolveListContext(dialog);
      collectEntries(refreshedContext.entries, collected);
      const after = captureScrollState(
        refreshedContext.scroller || context.scroller,
        refreshedContext.collectionRoot,
        collected.size
      );

      const advanced =
        after.collectedSize > before.collectedSize ||
        after.tailUsername !== before.tailUsername ||
        after.scrollTop > before.scrollTop ||
        after.scrollHeight > before.scrollHeight ||
        after.visibleCount !== before.visibleCount;

      stagnantPasses = advanced ? 0 : stagnantPasses + 1;

      if ((!moved && stagnantPasses >= 4) || stagnantPasses >= 10) {
        break;
      }

      if (isAtScrollEnd(refreshedContext.scroller || context.scroller) && stagnantPasses >= 4) {
        break;
      }
    }

    collectEntries(resolveListContext(dialog).entries, collected);
    await closeDialogIfOpen();
    return Array.from(collected).sort((left, right) => left.localeCompare(right));
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

  function collectEntries(entries, collected) {
    for (const entry of entries) {
      const username = entry.username;
      if (username) {
        collected.add(username);
      }
    }
  }

  function getProfileAnchorEntries(root) {
    const entries = [];
    const seen = new Set();

    for (const anchor of root.querySelectorAll("a[href]")) {
      const username = readUsernameFromAnchor(anchor);
      if (!username) {
        continue;
      }

      const key = username.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      entries.push({ anchor, username });
    }

    return entries;
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
    if (!candidate || RESERVED_SEGMENTS.has(candidate.toLowerCase())) {
      return "";
    }

    return candidate;
  }

  function resolveListContext(dialog) {
    const collectionRoot = dialog;
    const entries = getProfileAnchorEntries(collectionRoot);
    const lastAnchor = entries.at(-1)?.anchor || null;
    const scroller =
      findScrollableAncestor(lastAnchor, dialog) ||
      findBestScrollableDescendant(dialog) ||
      (isElementScrollable(collectionRoot) ? collectionRoot : null);

    return {
      collectionRoot,
      entries,
      scroller,
      visibleProfileCount: entries.length,
      tailUsername: entries.at(-1)?.username || ""
    };
  }

  function findBestScrollableDescendant(dialog) {
    const candidates = Array.from(dialog.querySelectorAll("div, section, ul, ol"))
      .filter((candidate) => isElementScrollable(candidate))
      .map((candidate) => ({
        element: candidate,
        score: rankCandidate(candidate, dialog, getProfileAnchorEntries(candidate).length, true)
      }))
      .sort((left, right) => right.score - left.score);

    return candidates[0]?.element || null;
  }

  function findScrollableAncestor(startNode, boundary) {
    if (!startNode) {
      return null;
    }

    const candidates = [];
    let current = startNode.parentElement;
    while (current && current !== boundary) {
      if (isElementScrollable(current)) {
        candidates.push(current);
      }
      current = current.parentElement;
    }

    if (isElementScrollable(boundary)) {
      candidates.push(boundary);
    }

    candidates.sort((left, right) => scoreScrollableElement(right) - scoreScrollableElement(left));
    return candidates[0] || null;
  }

  function rankCandidate(element, boundary, profileCount, scrollable) {
    const depth = getDepthFromBoundary(element, boundary);
    const area = Math.max(element.clientWidth * element.clientHeight, 1);
    const compactnessBoost = Math.round(500000 / Math.max(area, 5000));
    return profileCount * 1000 + (scrollable ? 120 : 0) + depth * 12 + compactnessBoost;
  }

  function getDepthFromBoundary(element, boundary) {
    let depth = 0;
    let current = element;
    while (current && current !== boundary) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function isElementScrollable(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const rect = element.getBoundingClientRect();
    return (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay" || element.scrollHeight > element.clientHeight + 12) &&
      element.clientHeight > 120 &&
      rect.height > 120
    );
  }

  function scoreScrollableElement(element) {
    const profileCount = getProfileAnchorEntries(element).length;
    const area = Math.max(element.clientWidth * element.clientHeight, 1);
    return profileCount * 1000 + Math.round(area / 1000);
  }

  async function nudgeRelationshipList(context) {
    const lastAnchor = context.entries.at(-1)?.anchor || null;

    if (lastAnchor) {
      lastAnchor.scrollIntoView({
        block: "end",
        inline: "nearest"
      });
      await sleep(140);
    } else {
      return false;
    }

    if (!context.scroller) {
      return true;
    }

    const beforeScrollTop = context.scroller.scrollTop;
    const step = Math.max(context.scroller.clientHeight * 0.95, 720);
    context.scroller.scrollTop = Math.min(beforeScrollTop + step, context.scroller.scrollHeight);
    context.scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    if (context.scroller.scrollTop === beforeScrollTop && !isAtScrollEnd(context.scroller)) {
      context.scroller.scrollTop = Math.min(beforeScrollTop + step + 160, context.scroller.scrollHeight);
      context.scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    return context.scroller.scrollTop > beforeScrollTop || !isAtScrollEnd(context.scroller);
  }

  function captureScrollState(scroller, collectionRoot, collectedSize) {
    const entries = getProfileAnchorEntries(collectionRoot);
    return {
      collectedSize,
      visibleCount: entries.length,
      tailUsername: entries.at(-1)?.username || "",
      scrollTop: scroller?.scrollTop || 0,
      scrollHeight: scroller?.scrollHeight || 0
    };
  }

  function isAtScrollEnd(scroller) {
    if (!scroller) {
      return true;
    }

    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
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

  async function maybeSendListProgress(relationship, profileUsername, collected, followers, context = null) {
    const now = Date.now();
    if (now - lastProgressAt < 900) {
      return;
    }

    lastProgressAt = now;
    const currentList = Array.from(collected).sort((left, right) => left.localeCompare(right));
    const following = relationship === "following" ? currentList : [];
    const followerSet = new Set(followers.map((entry) => entry.toLowerCase()));
    const notFollowingBack =
      relationship === "following"
        ? following.filter((username) => !followerSet.has(username.toLowerCase()))
        : [];
    const scrollNote =
      context?.scroller
        ? ` Visible now: ${context.visibleProfileCount}. Tail: ${context.tailUsername || "none"}. Scroll ${Math.round(
            context.scroller.scrollTop
          )} / ${Math.round(Math.max(context.scroller.scrollHeight - context.scroller.clientHeight, 0))}.`
        : ` Visible now: ${context?.visibleProfileCount || 0}. Tail: ${context?.tailUsername || "none"}.`;

    await notifyProgress({
      status: "running",
      profileUsername,
      currentList: relationship,
      note:
        relationship === "followers"
          ? `Scanning followers: ${currentList.length} collected so far.${scrollNote}`
          : `Scanning following: ${currentList.length} collected so far.${scrollNote}`,
      followers: relationship === "followers" ? currentList : followers,
      following,
      notFollowingBack,
      counts: {
        followers: relationship === "followers" ? currentList.length : followers.length,
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
    void chrome.runtime.sendMessage({
      type: "SCRAPE_ERROR",
      error: error.message,
      note: "The scrape stopped before completion. Instagram may have changed the page layout or interrupted the session."
    });
  }

  function getProfileUsername() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) {
      return "";
    }

    const username = segments[0].trim();
    return RESERVED_SEGMENTS.has(username.toLowerCase()) ? "" : username;
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

  async function waitForListAdvance(collectionRoot, scroller, beforeState, timeoutMs) {
    let mutationSeen = false;
    const observer = new MutationObserver(() => {
      mutationSeen = true;
    });

    observer.observe(collectionRoot, {
      childList: true,
      subtree: true
    });

    try {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const currentState = captureScrollState(scroller, collectionRoot, beforeState.collectedSize);
        const advanced =
          mutationSeen ||
          currentState.visibleCount !== beforeState.visibleCount ||
          currentState.tailUsername !== beforeState.tailUsername ||
          currentState.scrollTop !== beforeState.scrollTop ||
          currentState.scrollHeight !== beforeState.scrollHeight;

        if (advanced) {
          await sleep(320);
          return;
        }

        await sleep(180);
      }
    } finally {
      observer.disconnect();
    }

    await sleep(260);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
