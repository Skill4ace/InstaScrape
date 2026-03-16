(() => {
  if (window.__instaScrapePageBridgeInstalled) {
    return;
  }
  window.__instaScrapePageBridgeInstalled = true;

  const BRIDGE_INPUT_SOURCE = "INSTASCRAPE_EXTENSION";
  const BRIDGE_OUTPUT_SOURCE = "INSTASCRAPE_PAGE_BRIDGE";
  const state = {
    active: false,
    runId: "",
    relationship: "",
    requestCounter: 0
  };

  const originalFetch = window.fetch.bind(window);
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  window.fetch = async function patchedFetch(resource, init) {
    const request = await normalizeFetchRequest(resource, init);
    const response = await originalFetch(resource, init);
    if (state.active) {
      void inspectResponse(request, response);
    }
    return response;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__instaScrapeRequest = {
      method: String(method || "GET").toUpperCase(),
      url: new URL(String(url || ""), window.location.origin).toString(),
      headers: {},
      body: ""
    };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__instaScrapeRequest) {
      this.__instaScrapeRequest.headers[String(name).toLowerCase()] = String(value);
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__instaScrapeRequest) {
      this.__instaScrapeRequest.body = body ? String(body) : "";
      this.addEventListener("loadend", () => {
        if (!state.active) {
          return;
        }

        const contentType = String(this.getResponseHeader("content-type") || "");
        if (!contentType.includes("json")) {
          return;
        }

        try {
          const json = JSON.parse(this.responseText);
          emit("INSTASCRAPE_CAPTURE_EVENT", {
            runId: state.runId,
            kind: "network-response",
            request: this.__instaScrapeRequest,
            response: {
              status: this.status,
              url: this.responseURL,
              json
            }
          });
        } catch (error) {
          // ignore non-JSON responses
        }
      });
    }
    return originalSend.call(this, body);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== BRIDGE_INPUT_SOURCE) {
      return;
    }

    if (data.type === "INSTASCRAPE_CAPTURE_START") {
      state.active = true;
      state.runId = data.payload?.runId || "";
      state.relationship = data.payload?.relationship || "";
      state.requestCounter = 0;
      emit("INSTASCRAPE_CAPTURE_EVENT", {
        runId: state.runId,
        kind: "capture-started"
      });
      return;
    }

    if (data.type === "INSTASCRAPE_CAPTURE_STOP") {
      emit("INSTASCRAPE_CAPTURE_EVENT", {
        runId: state.runId,
        kind: "capture-stopped"
      });
      state.active = false;
      state.runId = "";
      state.relationship = "";
      return;
    }

    if (data.type === "INSTASCRAPE_REQUEST_PAGE") {
      void replayRequest(data.payload);
    }
  });

  async function replayRequest(payload) {
    try {
      const request = payload?.request;
      if (!request?.url || !request?.method) {
        throw new Error("Missing replay request details.");
      }

      const response = await originalFetch(request.url, {
        method: request.method,
        headers: request.headers || {},
        body: request.body || null,
        credentials: "include"
      });

      await inspectResponse(
        {
          method: request.method,
          url: request.url,
          headers: request.headers || {},
          body: request.body || ""
        },
        response
      );
    } catch (error) {
      emit("INSTASCRAPE_CAPTURE_EVENT", {
        runId: state.runId,
        kind: "replay-error",
        error: error.message
      });
    }
  }

  async function inspectResponse(request, response) {
    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.includes("json")) {
      return;
    }

    try {
      const json = await response.clone().json();
      emit("INSTASCRAPE_CAPTURE_EVENT", {
        runId: state.runId,
        kind: "network-response",
        request,
        response: {
          status: response.status,
          url: response.url || request.url,
          json
        }
      });
    } catch (error) {
      // ignore non-JSON bodies
    }
  }

  async function normalizeFetchRequest(resource, init) {
    const headers = {};
    let method = "GET";
    let url = "";
    let body = "";

    if (resource instanceof Request) {
      method = resource.method || method;
      url = resource.url || url;
      resource.headers.forEach((value, key) => {
        headers[String(key).toLowerCase()] = String(value);
      });
      if (!init?.body) {
        try {
          body = await resource.clone().text();
        } catch (error) {
          body = "";
        }
      }
    } else {
      url = new URL(String(resource || ""), window.location.origin).toString();
    }

    if (init?.method) {
      method = init.method;
    }
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[String(key).toLowerCase()] = String(value);
      });
    }
    if (init?.body) {
      body = String(init.body);
    }

    return {
      method: String(method || "GET").toUpperCase(),
      url,
      headers,
      body
    };
  }

  function emit(type, payload) {
    window.postMessage(
      {
        source: BRIDGE_OUTPUT_SOURCE,
        type,
        payload
      },
      window.location.origin
    );
  }
})();
