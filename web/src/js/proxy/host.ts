import { BUFFER_LOW_THRESHOLD, CRLF, createDataChannelSink, parseRequestHead } from "./utils";
const encoder = new TextEncoder();

let targetHost = "http://localhost:4321";
let hostReqCounter = 0;


export function setTargetHost(host: string): void {
  targetHost = host.replace(/\/+$/, "");
}

export function getTargetHost(): string {
  return targetHost;
}

export function setupHostChannel(
  dc: RTCDataChannel,
): void {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

  let isHeaderParsed = false;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;

  dc.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const data = new Uint8Array(ev.data);

    if (!isHeaderParsed) {
      isHeaderParsed = true;

      const parsed = parseRequestHead(data);
      if (!parsed) {
        console.warn("[ProxyHost] Failed to parse request head, closing DataChannel");
        dc.close();
        return;
      }

      const { method, path, headers, hasBody } = parsed;

      if (!hasBody) {
        executeHostFetch(dc, targetHost, method, path, headers);
        return;
      }

      const bodyStream = new ReadableStream<Uint8Array>({
        start(c) { bodyController = c },
      });

      executeHostFetch(dc, targetHost, method, path, headers, bodyStream);
      return;
    }

    if (data.byteLength == 0) {
      bodyController?.close();
      bodyController = null;
      return;
    }

    bodyController?.enqueue(data);
  };

  dc.onclose = () => {
    bodyController?.error(new Error("RTCDataChannel closed unexpectedly"));
    bodyController = null;
  };
  dc.onerror = (err) => {
    console.error(`[ProxyHost] DataChannel (${dc.label}) error:`, err);
  };
}

async function executeHostFetch(
  dc: RTCDataChannel,
  targetHost: string,
  method: string,
  path: string,
  headers: Headers,
  body?: BodyInit,
): Promise<void> {
  try {
    const targetUrl = `${targetHost}${path}`;

    // Sanitize headers: strip internal control headers, forbidden headers, and preflight triggers
    const fetchHeaders = new Headers();
    const FORBIDDEN_OR_PREFLIGHT_HEADERS = new Set([
      "host",
      "origin",
      "connection",
      "x-doot-has-body",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-user",
    ]);

    headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (!FORBIDDEN_OR_PREFLIGHT_HEADERS.has(lower)) {
        fetchHeaders.set(k, v);
      }
    });

    const referer = headers.get("referer");
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const tunnelMatch = refUrl.pathname.match(/^\/tunnel\/[^\/]+(.*)$/);
        const refPath = tunnelMatch ? (tunnelMatch[1] || "/") : refUrl.pathname;
        fetchHeaders.set("Referer", `${targetHost}${refPath}${refUrl.search}`);
      } catch {
        fetchHeaders.set("Referer", `${targetHost}/`);
      }
    } else {
      fetchHeaders.set("Referer", `${targetHost}/`);
    }

    const startTime = performance.now();
    const localResponse = await fetch(targetUrl, {
      method,
      headers: fetchHeaders,
      body,
      // @ts-ignore
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });

    const durationMs = Math.round(performance.now() - startTime);
    RequestLogs.add({
      id: String(++hostReqCounter),
      method,
      path,
      status: localResponse.status,
      time: new Date().toLocaleTimeString(),
      durationMs,
    });

    // HTTP/1.1 {status} {statusText}\r\n...
    const statusLine = `HTTP/1.1 ${localResponse.status} ${localResponse.statusText}`;
    const headerLines: string[] = [statusLine];

    localResponse.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (
        lower === "content-length" ||
        lower === "transfer-encoding" ||
        lower === "content-encoding"
      ) {
        return;
      }
      headerLines.push(`${k}: ${v}`);
    });

    const headerStr = headerLines.join(CRLF) + CRLF + CRLF;
    if (dc.readyState === "connecting") {
      await new Promise<void>((res) => {
        dc.onopen = () => res();
      });
    }

    if (dc.readyState === "open") {
      dc.send(encoder.encode(headerStr));
    }

    if (localResponse.body) {
      await localResponse.body.pipeTo(createDataChannelSink(dc));
    }

  } catch (err: any) {
    console.error("[ProxyHost] Fetch error connecting to target:", err);
    try {
      if (dc.readyState === "connecting") {
        await new Promise<void>((res) => {
          dc.onopen = () => res();
        });
      }
      if (dc.readyState === "open") {
        const currentOrigin = window.location.origin;
        const errorHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>502 Bad Gateway</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:36px;background:#292d3e;color:#eef0f7;margin:0;line-height:1.4;">
  <h2 style="color:#f38ba8;margin:0 0 12px;font-size:20px;font-weight:600;">502 Bad Gateway</h2>
  <p style="margin:0 0 4px;font-size:14px;color:#eef0f7;">The host server is currently unreachable or refused the connection.</p>
  <p style="color:#a3a8c2;font-size:13px;margin:0 0 20px;">Please check with the host or retry in a moment.</p>
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
        const bodyBuf = encoder.encode(errorHtml);
        const errHead = `HTTP/1.1 502 Bad Gateway${CRLF}Content-Type: text/html; charset=utf-8${CRLF}Content-Length: ${bodyBuf.byteLength}${CRLF}Connection: close${CRLF}${CRLF}`;
        dc.send(encoder.encode(errHead));
        dc.send(bodyBuf);
      }
    } catch { }
  } finally {
    dc.close();
  }
}

export interface RequestLogEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  time: string;
  durationMs: number;
}

export const RequestLogs = {
  entries: [] as RequestLogEntry[],
  listeners: new Set<(logs: RequestLogEntry[]) => void>(),

  onchange(listener: (logs: RequestLogEntry[]) => void) {
    RequestLogs.listeners.add(listener);
    listener(RequestLogs.entries);
    return () => {
      RequestLogs.listeners.delete(listener);
    };
  },

  notifyListeners() {
    for (const listener of RequestLogs.listeners) {
      try {
        listener(RequestLogs.entries);
      } catch { }
    }
  },

  add(entry: RequestLogEntry) {
    RequestLogs.entries.unshift(entry);
    if (RequestLogs.entries.length > 50) {
      RequestLogs.entries.pop();
    }
    RequestLogs.notifyListeners();
  },

  clear() {
    RequestLogs.entries = [];
    RequestLogs.notifyListeners();
  },
};