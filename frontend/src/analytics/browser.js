// Daniel Analytics SDK v1. Copy with browser.d.ts; canonical source is Analytics/shared.
// Call sites pass static event names and route templates only. There is no content API.
export function createAnalytics(config) {
  let visitorId, sessionId, sent = 0, lastTimestamp = 0;
  let lastPage = null;
  const events = new Set(["page_viewed", ...config.events]);
  const pages = new Set(config.pages || ["/"]);
  const endpoint = config.endpoint || "https://www.danielnash.co/api/analytics/events";
  const enabledOrigin = () => {
    if (typeof window === "undefined" || config.enabled === false) return false;
    const origin = window.location.origin;
    return config.origins.includes(origin) ||
      new RegExp("^https://" + config.previewPrefix + "-[a-z0-9-]+-danash1611-3756s-projects\\.vercel\\.app$").test(origin);
  };
  const optedOut = () => {
    if (typeof navigator === "undefined") return true;
    if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true) return true;
    try { return window.localStorage.getItem("daniel-analytics:disabled") === "true"; }
    catch { return false; }
  };
  const identity = () => {
    if (visitorId && sessionId) return true;
    try {
      const key = "daniel-analytics:" + config.app;
      const read = (suffix, prefix) => {
        let id;
        try { id = window.sessionStorage.getItem(key + suffix); } catch { /* memory fallback */ }
        if (!new RegExp("^" + prefix + "_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i").test(id || "")) {
          id = prefix + "_" + crypto.randomUUID();
          try { window.sessionStorage.setItem(key + suffix, id); } catch { /* memory fallback */ }
        }
        return id;
      };
      // Both identifiers last for a tab session. No cross-product or account identity.
      visitorId = read(":visitor", "visitor");
      sessionId = read(":session", "session");
      return true;
    } catch { return false; }
  };
  const track = async (eventName, pagePath = "/") => {
    if (!enabledOrigin() || optedOut() || !events.has(eventName) || !pages.has(pagePath) || sent >= 120 || !identity()) return false;
    let body;
    try {
      lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
      body = JSON.stringify({
        app: config.app, clientEventId: crypto.randomUUID(), occurredAt: new Date(lastTimestamp).toISOString(),
        visitorId, sessionId, eventName, pagePath,
        deviceClass: window.innerWidth < 768 ? "mobile" : window.innerWidth < 1024 ? "tablet" : "desktop",
        properties: {}
      });
    } catch { return false; }
    sent += 1;
    try {
      if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return true;
    } catch { /* use fetch when beacon is blocked */ }
    try {
      const response = await fetch(endpoint, {
        method: "POST", body, headers: { "Content-Type": "text/plain;charset=UTF-8" },
        credentials: "omit", mode: "cors", keepalive: true, signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch { return false; }
  };
  return {
    track,
    isHosted: enabledOrigin,
    isEnabled: () => enabledOrigin() && !optedOut(),
    page(pagePath = "/") {
      if (pagePath === lastPage || !pages.has(pagePath)) return;
      lastPage = pagePath;
      void track("page_viewed", pagePath);
    },
    disable() {
      config.enabled = false;
      try { window.localStorage.setItem("daniel-analytics:disabled", "true"); } catch { /* disabled in memory */ }
    }
  };
}

export function mountPrivacyControl(container, analytics) {
  if (!container || !analytics.isHosted()) return;
  const render = () => {
    container.replaceChildren();
    const text = document.createTextNode(analytics.isEnabled()
      ? "Usage analytics counts actions, without private content. " : "Usage analytics is off.");
    container.append(text);
    if (analytics.isEnabled()) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Turn off";
      button.className = "text-action";
      button.addEventListener("click", () => { analytics.disable(); render(); });
      container.append(button);
    }
    container.hidden = false;
  };
  render();
}
