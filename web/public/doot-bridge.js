(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const TUNNEL_PARAM = "__tunnel";
  const roomId = urlParams.get(TUNNEL_PARAM);

  if (!roomId) return;

  // 1. Hook history to preserve ?__tunnel on client-side routing
  const preserveTunnel = (urlStr) => {
    const u = new URL(urlStr, window.location.href);
    if (!u.searchParams.has(TUNNEL_PARAM)) {
      u.searchParams.set(TUNNEL_PARAM, roomId);
      return u.pathname + u.search + u.hash;
    }
    return urlStr;
  };

  const origPush = history.pushState;
  history.pushState = function (state, title, url) {
    return origPush.call(this, state, title, url ? preserveTunnel(url) : url);
  };

  const origReplace = history.replaceState;
  history.replaceState = function (state, title, url) {
    return origReplace.call(this, state, title, url ? preserveTunnel(url) : url);
  };

  // 2. Hub <-> Tab lifecycle awareness via BroadcastChannel
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel("doot_tunnel");
    channel.postMessage({ type: "TAB_OPENED", roomId });

    channel.onmessage = (e) => {
      if (e.data?.roomId && e.data.roomId !== roomId) return;
      if (e.data?.type === "HUB_CLOSED") {
        showHubDisconnectedBanner();
      } else if (e.data?.type === "ready" || e.data?.type === "HUB_READY") {
        window.location.reload();
      }
    };

    window.addEventListener("beforeunload", () => {
      channel.postMessage({ type: "TAB_CLOSED", roomId });
    });
  }

  function showHubDisconnectedBanner() {
    if (document.getElementById("__doot_disconnected_banner__")) return;
    const banner = document.createElement("div");
    banner.id = "__doot_disconnected_banner__";
    banner.innerHTML = `
      <div style="position:fixed;bottom:16px;right:16px;z-index:999999;background:#1e1e2e;color:#cdd6f4;padding:12px 18px;border-radius:8px;border:1px solid #f38ba8;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:system-ui,sans-serif;font-size:13px;display:flex;align-items:center;gap:12px;">
        <span>⚠️ Proxy Hub disconnected</span>
        <button onclick="window.open('/proxy?name=' + encodeURIComponent(${JSON.stringify(roomId)}) + '&mode=client','_blank')" style="background:#89b4fa;color:#11111b;border:none;border-radius:4px;padding:4px 10px;font-weight:600;cursor:pointer;">Reopen Hub</button>
      </div>
    `;
    document.body?.appendChild(banner);
  }
})();
