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

  // If there is no __tunnel parameter and this tab wasn't spawned by a tunnel,
  // this is a regular request. Pass straight to the network.
  if (!roomId) {
    return fetch(ev.request);
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

  return tunnelRequest(ev, proxyClient, targetPath);
}

const BRIDGE_TAG_BYTES = new TextEncoder().encode(
  '<script src="/doot-bridge.js"></script>'
);

function createHtmlInjectTransform() {
  let injected = false;
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
        controller.enqueue(BRIDGE_TAG_BYTES);
        controller.enqueue(after);
        injected = true;
      } else {
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (!injected) {
        controller.enqueue(BRIDGE_TAG_BYTES);
        injected = true;
      }
    },
  });
}

async function tunnelRequest(
  ev: FetchEvent,
  proxyClient: Client,
  targetPath: string,
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

  return responsePromise(localPort, body);
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
                createHtmlInjectTransform(),
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

