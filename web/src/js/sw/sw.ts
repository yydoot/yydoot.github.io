import { openDB, type IDBPDatabase } from "idb";
import {
  REQUEST_BODY_CHUNK,
  REQUEST_END,
  REQUEST_ERROR,

  RESPONSE_HEADER,
  RESPONSE_BODY_CHUNK,
  RESPONSE_END,
  RESPONSE_ERROR,

  parseResponseHead,
  serializeRequestHeader,
} from "../proxy/http";
import { ProxyHubRequiredHtml, BadGatewayHtml } from "./templates";

import {
  TUNNEL_PARAM,
  getClientRoom,
  saveClientRoom,
  extractTunnel,
} from "./roomRegistry";

const sw = self as unknown as ServiceWorkerGlobalScope & typeof globalThis;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(sw.clients.claim());
});

//control message
export const PROXY_REQUEST_START = "PROXY_REQUEST_START";

async function getProxyClient(roomId?: string | null): Promise<Client | null> {
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  // 1. Try matching by roomId in name or room query param
  if (roomId) {
    const match = clients.find((c) => {
      const u = new URL(c.url);
      const name = u.searchParams.get("name") || u.searchParams.get("room");
      return u.pathname.includes("/proxy") && (name === roomId || decodeURIComponent(u.search.slice(1)) === roomId);
    });
    if (match) return match;
  }
  // 2. Fallback: match any active proxy hub window
  return clients.find((c) => new URL(c.url).pathname.includes("/proxy")) || null;
}


sw.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin != sw.location.origin) return;

  // Not intercept the service worker script itself
  if (url.pathname == "/sw.js") return;

  ev.respondWith(handleFetch(ev, url));
});

async function handleFetch(ev: FetchEvent, url: URL): Promise<Response> {
  let roomId: string | null = null;
  let targetPath: string = url.pathname + url.search;

  const tunnel = extractTunnel(url);
  if (tunnel) {
    roomId = tunnel.roomId;
    targetPath = tunnel.targetPath;
  } else if (ev.clientId) {
    roomId = await getClientRoom(ev.clientId);
  }

  // If this is a known static Doot page and NOT a tunnel request, let it pass through
  const isDootPage =
    (url.pathname === "/" && !tunnel) ||
    url.pathname.startsWith("/room") ||
    url.pathname.startsWith("/proxy");

  if (!roomId) {
    if (isDootPage) {
      return fetch(ev.request);
    }
    // If not a Doot page, check if any proxy client exists
    const fallbackClient = await getProxyClient(null);
    if (!fallbackClient) {
      return fetch(ev.request);
    }
    // Try to extract room from fallback client
    const u = new URL(fallbackClient.url);
    roomId = u.searchParams.get("name") || u.searchParams.get("room") || "proxy-room";
  }

  const targetClientId = ev.resultingClientId || ev.clientId;
  if (targetClientId) {
    saveClientRoom(targetClientId, roomId);
  }

  if (ev.request.mode == "navigate" && !url.searchParams.has(TUNNEL_PARAM)) {
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set(TUNNEL_PARAM, roomId);
    return Response.redirect(nextUrl.toString(), 302);
  }

  const proxyClient = await getProxyClient(roomId);

  if (!proxyClient) {
    const proxyUrl = `${url.origin}/proxy?name=${encodeURIComponent(roomId)}&mode=client`;
    return new Response(ProxyHubRequiredHtml(roomId, proxyUrl), {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return tunnelRequest(ev, proxyClient, targetPath, roomId);
}

function getBridgeScript(roomId: string): string {
  return `<script id="__doot_tunnel_bridge__">
(() => {
  const ROOM_ID = ${JSON.stringify(roomId)};
  const TUNNEL_PARAM = "__tunnel";

  // 1. Hook history to preserve ?__tunnel on SPA client routing
  const preserveTunnel = (urlStr) => {
    try {
      const u = new URL(urlStr, window.location.href);
      if (!u.searchParams.has(TUNNEL_PARAM)) {
        u.searchParams.set(TUNNEL_PARAM, ROOM_ID);
        return u.pathname + u.search + u.hash;
      }
    } catch (_) {}
    return urlStr;
  };

  const origPush = history.pushState;
  history.pushState = function(state, title, url) {
    return origPush.call(this, state, title, url ? preserveTunnel(url) : url);
  };

  const origReplace = history.replaceState;
  history.replaceState = function(state, title, url) {
    return origReplace.call(this, state, title, url ? preserveTunnel(url) : url);
  };

  if (!new URLSearchParams(window.location.search).has(TUNNEL_PARAM)) {
    origReplace.call(history, history.state, document.title, preserveTunnel(window.location.href));
  }

  // 2. Hub <-> Tab lifecycle awareness via BroadcastChannel
  const channel = new BroadcastChannel("doot_tunnel");
  channel.postMessage({ type: "TAB_OPENED", roomId: ROOM_ID });

  channel.onmessage = (e) => {
    if (e.data?.roomId && e.data.roomId !== ROOM_ID) return;
    if (e.data?.type === "HUB_CLOSED") {
      showHubDisconnectedBanner();
    } else if (e.data?.type === "ready" || e.data?.type === "HUB_READY") {
      window.location.reload();
    }
  };

  window.addEventListener("beforeunload", () => {
    channel.postMessage({ type: "TAB_CLOSED", roomId: ROOM_ID });
  });

  function showHubDisconnectedBanner() {
    if (document.getElementById("__doot_disconnected_banner__")) return;
    const banner = document.createElement("div");
    banner.id = "__doot_disconnected_banner__";
    banner.innerHTML = \`
      <div style="position:fixed;bottom:16px;right:16px;z-index:999999;background:#1e1e2e;color:#cdd6f4;padding:12px 18px;border-radius:8px;border:1px solid #f38ba8;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:sans-serif;font-size:13px;display:flex;align-items:center;gap:12px;">
        <span>⚠️ Proxy Hub disconnected</span>
        <button onclick="window.open('/proxy?name=\${encodeURIComponent(ROOM_ID)}&mode=client','_blank')" style="background:#89b4fa;color:#11111b;border:none;border-radius:4px;padding:4px 10px;font-weight:600;cursor:pointer;">Reopen Hub</button>
      </div>
    \`;
    document.body?.appendChild(banner);
  }
})();
</script>`;
}

function createHtmlInjectTransform(roomId: string) {
  let injected = false;
  const scriptBytes = new TextEncoder().encode(getBridgeScript(roomId));
  const headPattern = /<head[^>]*>/i;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk);
        return;
      }

      const text = new TextDecoder().decode(chunk);
      const match = text.match(headPattern);

      if (match && match.index !== undefined) {
        const insertPos = match.index + match[0].length;
        const before = new TextEncoder().encode(text.slice(0, insertPos));
        const after = new TextEncoder().encode(text.slice(insertPos));

        controller.enqueue(before);
        controller.enqueue(scriptBytes);
        controller.enqueue(after);
        injected = true;
      } else {
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      // Fallback: If no <head> tag was found, inject at the very start
      if (!injected) {
        controller.enqueue(scriptBytes);
        injected = true;
      }
    },
  });
}

async function tunnelRequest(
  ev: FetchEvent,
  proxyClient: Client,
  targetPath: string,
  roomId: string,
): Promise<Response> {
  const headBytes = serializeRequestHeader(ev.request, targetPath);
  const msgChannel = new MessageChannel();
  const localPort = msgChannel.port1;
  const remotePort = msgChannel.port2;
  const body = ev.request.body;

  proxyClient.postMessage(
    {
      type: PROXY_REQUEST_START,
      head: headBytes.buffer,
      hasBody: body != null,
    },
    [remotePort, headBytes.buffer],
  );

  if (body) {
    readLoop(body.getReader(), localPort);
  }

  return responsePromise(localPort, body, roomId);
}

async function readLoop(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  localPort: MessagePort,
) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        localPort.postMessage({ type: REQUEST_END });
        break;
      }
      localPort.postMessage(
        { type: REQUEST_BODY_CHUNK, buffer: value.buffer },
        [value.buffer],
      );
    }
  } catch (e) {
    localPort.postMessage({ type: REQUEST_ERROR });
  }
}

function responsePromise(
  port: MessagePort,
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  roomId: string,
) {
  return new Promise<Response>((resolve, reject) => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const rawResponseStream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
    });

    port.onmessage = (event) => {
      switch (event.data.type) {
        case RESPONSE_HEADER: {
          const data = new Uint8Array(event.data.buffer);
          const parsed = parseResponseHead(data);
          if (parsed) {
            const contentType = parsed.headers.get("content-type") || "";
            const isHtml = contentType.toLowerCase().includes("text/html");

            let finalStream: ReadableStream<Uint8Array> = rawResponseStream;
            const newHeaders = new Headers(parsed.headers);

            if (isHtml) {
              // Delete content-length because injection changes payload length
              newHeaders.delete("content-length");
              finalStream = rawResponseStream.pipeThrough(
                createHtmlInjectTransform(roomId),
              );
            }

            resolve(
              new Response(finalStream, {
                status: parsed.status,
                headers: newHeaders,
              }),
            );
          }
          break;
        }

        case RESPONSE_BODY_CHUNK: {
          streamController?.enqueue(new Uint8Array(event.data.buffer));
          break;
        }

        case RESPONSE_END: {
          streamController?.close();
          port.close();
          break;
        }

        case RESPONSE_ERROR: {
          if (streamController) {
            streamController.error(new Error("P2P Stream Error"));
          }
          port.close();
          resolve(
            new Response(BadGatewayHtml(), {
              status: 502,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
          );
          break;
        }
      }
    };
    port.start();
  });
}

