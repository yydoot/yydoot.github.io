// HTML templates for Service Worker error & status pages
// Sharp, concise developer layout matching the original 502 template

export function ProxyHubRequiredHtml(roomId: string, proxyUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Proxy Hub Required - Doot</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:36px;background:#292d3e;color:#eef0f7;margin:0;line-height:1.4;">
  <h2 style="color:#89b4fa;margin:0 0 12px;font-size:20px;font-weight:600;">Proxy Hub Required</h2>
  <p style="margin:0 0 4px;font-size:14px;color:#eef0f7;">No active WebRTC peer connection was found in this browser.</p>
  <p style="color:#a3a8c2;font-size:13px;margin:0 0 20px;">Open the client proxy hub in another tab to connect.</p>
  <p style="margin:0;">
    <a style="display:inline-block;padding:8px 16px;background:#89b4fa;color:#11111b;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;text-decoration:none;" href="${proxyUrl}" target="_blank" rel="noreferrer">Open Proxy Client Hub</a>
  </p>
  <script>
    const channel = new BroadcastChannel("doot_tunnel");
    channel.onmessage = (e) => {
      if (e.data?.type === "ready" && (!e.data.roomId || e.data.roomId === "${roomId}")) {
        window.location.reload();
      }
    };
  </script>
</body>
</html>`;
}

export function BadGatewayHtml(message?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>502 Bad Gateway</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:36px;background:#292d3e;color:#eef0f7;margin:0;line-height:1.4;">
  <h2 style="color:#f38ba8;margin:0 0 12px;font-size:20px;font-weight:600;">502 Bad Gateway</h2>
  <p style="margin:0 0 4px;font-size:14px;color:#eef0f7;">The proxy request over WebRTC failed or the local server refused the connection.</p>
  <p style="color:#a3a8c2;font-size:13px;margin:0 0 20px;">${message || "Make sure your local application is running and the host tab is active."}</p>
  <p style="margin:0;">
    <button style="padding:8px 16px;background:#89b4fa;color:#11111b;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;" onclick="window.location.reload()">Retry</button>
  </p>
  <script>
    const channel = new BroadcastChannel("doot_tunnel");
    channel.onmessage = (e) => {
      if (e.data?.type === "ready") {
        window.location.reload();
      }
    };
  </script>
</body>
</html>`;
}
