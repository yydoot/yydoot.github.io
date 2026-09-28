import { setupSW } from "../sw/setup";
import { deserializeRequest, serializeResponse } from "../proxy/http";
import {
  REQUEST_BODY_CHUNK,
  REQUEST_END as REQUEST_BODY_END,
  PROXY_RESPONSE_PLACEHOLDER,
} from "../proxy/http";
import { PEER_ID } from "../peerId";
import { STUN_SERVERS } from "../file_transfer/protocol";
import { type Signal } from "../signaling";
import { SIGNAL_SERVER_URL } from "../signaling";

export type PeerRole = "proxy" | "client";

export interface ProxyPeerMetadata {
  peerId: string;
  role: PeerRole;
  serverName?: string;
  targetHost?: string;
}

const MTU = 16384; // 16KB chunk size
const HEADER_SIZE = 12; // 4 bytes reqId, 4 bytes totalLen, 4 bytes offset
const CHUNK_PAYLOAD_SIZE = MTU - HEADER_SIZE;
const HIGH_WATER_MARK = 64 * 1024; // 64KB backpressure threshold
const LOW_WATER_MARK = 32 * 1024; // 32KB resume threshold

const encoder = new TextEncoder();
const TUNNEL_UNAVAILABLE_RESPONSE =
  "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0f111a;color:#e2e8f0;\"><h1 style=\"color:#f87171;\">503 Service Unavailable</h1><p>No active WebRTC Proxy Host connected. Ensure the Host tab is active in the room.</p></body></html>";
const TUNNEL_ERROR_RESPONSE =
  "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0f111a;color:#e2e8f0;\"><h1 style=\"color:#f87171;\">502 Bad Gateway</h1><p>P2P Tunnel transmission error.</p></body></html>";

export interface ProxyManagerCallbacks {
  onSignalingState?: (state: string) => void;
  onWebRTCState?: (state: string) => void;
  onPeerJoined?: (peerId: string) => void;
  onRoleAssigned?: (role: PeerRole) => void;
  onTunnelReady?: () => void;
  onPeersUpdated?: (peers: ProxyPeerMetadata[]) => void;
  onRequestLogged?: (req: { id: number; method: string; url: string; status?: number }) => void;
}

interface BufferAssemblyState {
  buffer: Uint8Array;
  received: number;
  total: number;
}

export class P2PProxyManager {
  private peerId: string;
  private roomId: string;
  private role: PeerRole;
  private targetHost: string;
  private serverName: string;
  private autoRole: boolean;
  private requestCounter: number = 0;
  private clientRequestId: number = 1;

  private socket: WebSocket | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private peerMetadataMap = new Map<string, ProxyPeerMetadata>();
  private iceCandidateQueue = new Map<string, any[]>();

  // Persistent WebRTC Channels
  private controlChannels = new Map<string, RTCDataChannel>();
  private tunnelChannels = new Map<string, RTCDataChannel>();
  private pendingRequests = new Map<number, (res: ArrayBuffer) => void>();
  private incomingBuffers = new Map<string, BufferAssemblyState>();

  private callbacks: ProxyManagerCallbacks;
  private requestsEl?: HTMLElement | null;
  private swStatusEl?: HTMLElement | null;

  constructor(
    roomId: string,
    initialRole: PeerRole = "client",
    options: {
      autoRole?: boolean;
      targetHost?: string;
      serverName?: string;
      callbacks?: ProxyManagerCallbacks;
      requestsEl?: HTMLElement | null;
      swStatusEl?: HTMLElement | null;
    } = {}
  ) {
    this.peerId = PEER_ID;
    this.roomId = roomId.trim().length < 5 ? roomId.trim().padEnd(5, "-") : roomId.trim();
    this.role = initialRole;
    this.autoRole = options.autoRole !== false;
    this.targetHost = options.targetHost || "http://localhost:4321";
    this.serverName = options.serverName || `ProxyServer-${this.peerId.slice(0, 4)}`;
    this.callbacks = options.callbacks || {};
    this.requestsEl = options.requestsEl;
    this.swStatusEl = options.swStatusEl;

    // Register Service Worker for streaming request interception
    setupSW(
      (reqId, head, port, hasBody) => this.handleClientProxyRequest(reqId, head, port, hasBody),
      this.swStatusEl,
    );
  }

  public getRole(): PeerRole {
    return this.role;
  }

  public setRole(role: PeerRole): void {
    this.role = role;
    const meta = {
      role: this.role,
      serverName: this.serverName,
      targetHost: this.targetHost,
    };

    // 1. Send update to signaling server
    this.sendSignal({
      type: "update_metadata",
      room_id: this.roomId,
      metadata: meta,
    });

    // 2. Broadcast directly across established WebRTC control channels
    this.broadcastMetadata();
    this.callbacks.onRoleAssigned?.(this.role);
  }

  public setTargetHost(host: string): void {
    this.targetHost = host;
    this.setRole(this.role);
  }

  public connect(): void {
    this.callbacks.onSignalingState?.("connecting");
    const signalUrl = SIGNAL_SERVER_URL;
    this.socket = new WebSocket(`${signalUrl}?peer_id=${this.peerId}`);

    this.socket.onopen = () => {
      this.callbacks.onSignalingState?.("connected");
      this.sendSignal({
        type: "join",
        room_id: this.roomId,
        metadata: {
          role: this.role,
          serverName: this.serverName,
          targetHost: this.targetHost,
        },
      });
    };

    this.socket.onmessage = async (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const message: Signal = JSON.parse(event.data);
        await this.handleSignal(message);
      } catch (err) {
        console.error("[ProxyManager] Signal parse error:", err);
      }
    };

    this.socket.onclose = (ev) => {
      this.callbacks.onSignalingState?.(`disconnected (code ${ev.code})`);
    };

    this.socket.onerror = (err) => {
      console.error("[ProxyManager] WebSocket error:", err);
      this.callbacks.onSignalingState?.("error");
    };
  }

  private sendSignal(signal: any): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(signal));
    }
  }

  private async handleSignal(signal: Signal): Promise<void> {
    switch (signal.type) {
      case "room_joined": {
        const rawPeers = signal.peers || [];
        for (const p of rawPeers) {
          const peerId = typeof p === "string" ? p : p.peer_id;
          const meta: ProxyPeerMetadata =
            typeof p === "string"
              ? { peerId, role: "proxy" }
              : { peerId, role: p.metadata?.role || "proxy", ...p.metadata };
          this.peerMetadataMap.set(peerId, meta);
        }

        if (this.autoRole) {
          const hasHost = Array.from(this.peerMetadataMap.values()).some((m) => m.role === "proxy");
          const newRole = !hasHost && rawPeers.length === 0 ? "proxy" : "client";
          this.setRole(newRole);
        }

        this.updatePeersList();

        // Deterministic connection initiation: If this.peerId > peerId, we initiate
        for (const p of rawPeers) {
          const peerId = typeof p === "string" ? p : p.peer_id;
          this.callbacks.onPeerJoined?.(peerId);
          if (this.peerId > peerId) {
            await this.initiateConnection(peerId);
          }
        }
        break;
      }

      case "peer_joined": {
        if (signal.metadata) {
          this.peerMetadataMap.set(signal.peer_id, {
            peerId: signal.peer_id,
            role: signal.metadata.role || "client",
            ...signal.metadata,
          });
          this.updatePeersList();
        }
        this.callbacks.onPeerJoined?.(signal.peer_id);

        // Deterministic connection initiation: If this.peerId > peerId, we initiate
        if (this.peerId > signal.peer_id) {
          await this.initiateConnection(signal.peer_id);
        }
        break;
      }

      case "peer_metadata_updated": {
        if (signal.metadata) {
          this.peerMetadataMap.set(signal.peer_id, {
            peerId: signal.peer_id,
            role: signal.metadata.role || "client",
            ...signal.metadata,
          });
          this.updatePeersList();
          if (this.role === "client" && signal.metadata.role === "proxy") {
            this.callbacks.onTunnelReady?.();
          }
        }
        break;
      }

      case "peer_offer":
        await this.handleOffer(signal.from_peer, signal.sdp);
        break;

      case "peer_answer":
        await this.handleAnswer(signal.from_peer, signal.sdp);
        break;

      case "peer_ice_candidate":
        await this.handleCandidate(signal.from_peer, signal.candidate);
        break;

      case "peer_left":
        this.closePeer(signal.peer_id);
        break;
    }
  }

  private getOrCreatePeerConnection(remotePeerId: string): RTCPeerConnection {
    const existing = this.peerConnections.get(remotePeerId);
    if (existing && existing.connectionState !== "closed" && existing.signalingState !== "closed") {
      return existing;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: STUN_SERVERS }],
    });
    this.peerConnections.set(remotePeerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: "ice_candidate",
          peer_id: remotePeerId,
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState || "closed";
      this.callbacks.onWebRTCState?.(state);
      if (state === "connected") {
        this.callbacks.onTunnelReady?.();
      }
      this.updatePeersList();
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState || "closed";
      if (state === "connected" || state === "completed") {
        this.callbacks.onWebRTCState?.("connected");
        this.callbacks.onTunnelReady?.();
      }
      this.updatePeersList();
    };

    pc.ondatachannel = (event) => {
      this.setupIncomingDataChannel(remotePeerId, event.channel);
    };

    return pc;
  }

  private async initiateConnection(remotePeerId: string): Promise<void> {
    const pc = this.getOrCreatePeerConnection(remotePeerId);

    // 1. Control channel for metadata
    const ctrl = pc.createDataChannel("control", { ordered: true });
    this.setupControlChannel(remotePeerId, ctrl);

    // 2. Persistent tunnel channel for all HTTP requests/responses
    const tunnelDc = pc.createDataChannel("tunnel_data", { ordered: true });
    this.setupTunnelChannel(remotePeerId, tunnelDc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.sendSignal({
      type: "offer",
      peer_id: remotePeerId,
      sdp: offer.sdp,
    });
  }

  private async handleOffer(fromPeer: string, sdp: string): Promise<void> {
    const pc = this.getOrCreatePeerConnection(fromPeer);

    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
    await this.processIceQueue(fromPeer, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.sendSignal({
      type: "answer",
      peer_id: fromPeer,
      sdp: answer.sdp,
    });
  }

  private async handleAnswer(fromPeer: string, sdp: string): Promise<void> {
    const pc = this.peerConnections.get(fromPeer);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      await this.processIceQueue(fromPeer, pc);
    }
  }

  private async handleCandidate(fromPeer: string, candidate: any): Promise<void> {
    const pc = this.peerConnections.get(fromPeer);
    if (!pc || !pc.remoteDescription) {
      const queue = this.iceCandidateQueue.get(fromPeer) || [];
      queue.push(candidate);
      this.iceCandidateQueue.set(fromPeer, queue);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("[ProxyManager] Add ICE Candidate error:", err);
    }
  }

  private async processIceQueue(peerId: string, pc: RTCPeerConnection): Promise<void> {
    const queue = this.iceCandidateQueue.get(peerId);
    if (queue) {
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("[ProxyManager] Error processing queued candidate:", err);
        }
      }
      this.iceCandidateQueue.delete(peerId);
    }
  }

  private setupControlChannel(remotePeerId: string, channel: RTCDataChannel): void {
    this.controlChannels.set(remotePeerId, channel);

    const onOpen = () => {
      this.sendMetadataTo(channel);
      this.callbacks.onTunnelReady?.();
    };

    if (channel.readyState === "open") {
      onOpen();
    } else {
      channel.onopen = onOpen;
    }

    channel.onclose = () => {
      this.controlChannels.delete(remotePeerId);
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const meta: ProxyPeerMetadata = JSON.parse(event.data);
          if (meta && meta.role) {
            this.peerMetadataMap.set(remotePeerId, meta);
            this.updatePeersList();
            if (this.role === "client" && meta.role === "proxy") {
              this.callbacks.onTunnelReady?.();
            }
          }
        } catch {
          // Non-JSON control message
        }
      }
    };
  }

  private setupTunnelChannel(remotePeerId: string, dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    this.tunnelChannels.set(remotePeerId, dc);

    const onOpen = () => {
      this.callbacks.onTunnelReady?.();
    };

    if (dc.readyState === "open") {
      onOpen();
    } else {
      dc.onopen = onOpen;
    }

    dc.onclose = () => {
      this.tunnelChannels.delete(remotePeerId);
    };

    dc.onmessage = async (ev) => {
      if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength < HEADER_SIZE) return;

      const view = new DataView(ev.data);
      const reqId = view.getUint32(0);
      const totalLen = view.getUint32(4);
      const offset = view.getUint32(8);
      const chunk = new Uint8Array(ev.data, HEADER_SIZE);

      const bufferKey = `${remotePeerId}:${reqId}`;
      let state = this.incomingBuffers.get(bufferKey);
      if (!state) {
        state = { buffer: new Uint8Array(totalLen), received: 0, total: totalLen };
        this.incomingBuffers.set(bufferKey, state);
      }

      state.buffer.set(chunk, offset);
      state.received += chunk.byteLength;

      // When all chunks for this request ID are assembled
      if (state.received >= state.total) {
        this.incomingBuffers.delete(bufferKey);
        const completeBuffer = state.buffer.buffer as ArrayBuffer;

        if (this.role === "proxy") {
          // Host side: Fetch local app and stream response back with same reqId
          const responseBuffer = await this.handleLocalProxyFetch(completeBuffer);
          await this.sendFramedPayload(dc, reqId, responseBuffer);
        } else {
          // Client side: Match request ID and resolve pending response Promise
          const resolver = this.pendingRequests.get(reqId);
          if (resolver) {
            resolver(completeBuffer);
            this.pendingRequests.delete(reqId);
          }
        }
      }
    };
  }

  private setupIncomingDataChannel(fromPeerId: string, dc: RTCDataChannel): void {
    if (dc.label === "control") {
      this.setupControlChannel(fromPeerId, dc);
      return;
    }

    if (dc.label.startsWith("req-")) {
      this.setupIncomingRequestChannel(fromPeerId, dc);
      return;
    }

    if (dc.label === "tunnel_data" || dc.label === "http") {
      this.setupTunnelChannel(fromPeerId, dc);
      return;
    }
  }

  // Host: Handles a newly opened dynamic request channel from a client
  private setupIncomingRequestChannel(fromPeerId: string, dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    let isHeaderParsed = false;
    let method = "GET";
    let path = "/";
    let headers = new Headers();
    let bodyController: ReadableStreamDefaultController | null = null;

    dc.onmessage = async (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(ev.data);

      if (!isHeaderParsed) {
        // Find \r\n\r\n
        let headerEndIndex = -1;
        for (let i = 0; i < data.length - 3; i++) {
          if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
            headerEndIndex = i;
            break;
          }
        }

        if (headerEndIndex === -1) {
          console.warn("[ProxyHost] Invalid request header received on dynamic channel");
          dc.close();
          return;
        }

        const headStr = new TextDecoder().decode(data.subarray(0, headerEndIndex));
        const lines = headStr.split(/\r?\n/);
        const [reqMethod, reqPath] = (lines[0] || "").split(" ");
        method = reqMethod || "GET";
        path = reqPath || "/";

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const colonIdx = line.indexOf(":");
          if (colonIdx !== -1) {
            headers.append(line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim());
          }
        }

        isHeaderParsed = true;

        const bodyStream = (method !== "GET" && method !== "HEAD")
          ? new ReadableStream({
            start(controller) {
              bodyController = controller;
            },
          })
          : null;

        // Any initial body bytes that arrived with the header packet
        const initialBody = data.subarray(headerEndIndex + 4);
        if (initialBody.byteLength > 0 && bodyController) {
          bodyController.enqueue(initialBody);
        }

        // Execute fetch to target local app
        this.executeHostFetch(dc, method, path, headers, bodyStream);
      } else {
        // Subsequent body chunk
        if (bodyController) {
          bodyController.enqueue(data);
        }
      }
    };

    dc.onclose = () => {
      if (bodyController) {
        try {
          bodyController.close();
        } catch (e) { }
      }
    };
  }

  // Host: Executes fetch to local target app (e.g. http://localhost:4321)
  private async executeHostFetch(
    dc: RTCDataChannel,
    method: string,
    path: string,
    headers: Headers,
    bodyStream: ReadableStream | null,
  ): Promise<void> {
    try {
      const cleanHost = this.targetHost.replace(/\/+$/, "");
      const cleanPath = path.startsWith("/") ? path : "/" + path;
      const targetUrl = `${cleanHost}${cleanPath}`;

      this.requestCounter++;
      this.logHostRequestTable(this.requestCounter, method, cleanPath, headers);

      const cleanHeaders = new Headers();
      headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (
          lower === "host" ||
          lower === "origin" ||
          lower === "referer" ||
          lower === "content-length" ||
          lower === "connection" ||
          lower === "transfer-encoding" ||
          lower === "keep-alive" ||
          lower.startsWith("sec-") ||
          lower.startsWith("proxy-")
        ) {
          return;
        }
        try {
          cleanHeaders.set(k, v);
        } catch (e) { }
      });

      const localResponse = await fetch(targetUrl, {
        method,
        headers: cleanHeaders,
        body: bodyStream ? (bodyStream as any) : undefined,
        // @ts-ignore
        duplex: bodyStream ? "half" : undefined,
        mode: "cors",
      });

      console.log(`[ProxyHost] Fetched ${method} ${targetUrl} -> status ${localResponse.status}`);

      // PLACEHOLDER: Hollow stub for next phase (Response Proxying)
      // We will stream localResponse back across `dc` in the next phase!
    } catch (err: any) {
      console.error("[ProxyHost] Failed local fetch:", err);
      dc.close();
    }
  }

  private sendMetadataTo(channel: RTCDataChannel): void {
    if (channel.readyState === "open") {
      const meta: ProxyPeerMetadata = {
        peerId: this.peerId,
        role: this.role,
        serverName: this.serverName,
        targetHost: this.targetHost,
      };
      channel.send(JSON.stringify(meta));
    }
  }

  private broadcastMetadata(): void {
    const metaStr = JSON.stringify({
      peerId: this.peerId,
      role: this.role,
      serverName: this.serverName,
      targetHost: this.targetHost,
    });

    for (const [, ctrl] of this.controlChannels) {
      if (ctrl.readyState === "open") {
        try {
          ctrl.send(metaStr);
        } catch (e) { }
      }
    }
  }

  private updatePeersList(): void {
    const list: ProxyPeerMetadata[] = [];
    for (const [, meta] of this.peerMetadataMap) {
      list.push(meta);
    }
    this.callbacks.onPeersUpdated?.(list);
  }

  private logHostRequestTable(id: number, method: string, path: string, headers: Headers): void {
    if (!this.requestsEl) return;
    const tbody = this.requestsEl.querySelector("tbody");
    if (!tbody) return;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono-font">#${id}</td>
      <td><span class="method-badge ${method.toLowerCase()}">${method}</span></td>
      <td class="mono-font url-cell" title="${path}">${path}</td>
      <td class="mono-font">${Array.from(headers.keys()).length} headers</td>
    `;
    tbody.prepend(tr);
  }

  // Execute request on local target application (Host Mode)
  private async handleLocalProxyFetch(serializedReq: ArrayBuffer): Promise<ArrayBuffer> {
    try {
      const { method, url, headers, body } = deserializeRequest(serializedReq);
      const parsedUrl = new URL(url);

      const rawPath = parsedUrl.pathname.replace(/^\/(tunnel|p2p-tunnel)/, "") || "/";
      const cleanHost = this.targetHost.replace(/\/+$/, "");
      const cleanPath = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
      const targetUrl = `${cleanHost}${cleanPath}${parsedUrl.search}`;

      this.requestCounter++;
      this.logHostRequestTable(this.requestCounter, method, cleanPath + parsedUrl.search, headers);

      const cleanHeaders = new Headers();
      headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        // Remove headers forbidden or managed by browser fetch
        if (
          lower === "host" ||
          lower === "origin" ||
          lower === "referer" ||
          lower === "content-length" ||
          lower === "connection" ||
          lower === "transfer-encoding" ||
          lower === "keep-alive" ||
          lower.startsWith("sec-") ||
          lower.startsWith("proxy-")
        ) {
          return;
        }
        try {
          cleanHeaders.set(k, v);
        } catch (e) { }
      });
      cleanHeaders.set("X-Doot-Loopback", "true");

      const hasBody = method !== "GET" && method !== "HEAD" && body !== null;

      const localResponse = await fetch(targetUrl, {
        method,
        headers: cleanHeaders,
        body: hasBody && body ? (body as unknown as BodyInit) : undefined,
        mode: "cors",
      });

      const resHeaders = new Headers(localResponse.headers);
      resHeaders.delete("content-encoding");
      resHeaders.delete("transfer-encoding");

      const location = localResponse.headers.get("location");
      if (location) {
        try {
          const locUrl = new URL(location, targetUrl);
          if (locUrl.origin === new URL(cleanHost).origin || location.startsWith("/")) {
            const relPath = locUrl.pathname.startsWith("/tunnel") ? locUrl.pathname : "/tunnel" + locUrl.pathname;
            resHeaders.set("location", relPath + locUrl.search + locUrl.hash);
          }
        } catch (e) { }
      }

      const cleanRes = new Response(await localResponse.arrayBuffer(), {
        status: localResponse.status,
        statusText: localResponse.statusText,
        headers: resHeaders,
      });

      return await serializeResponse(cleanRes);
    } catch (err: any) {
      console.error("[ProxyHost] Failed to proxy local fetch:", err);
      const errMsg = err?.message || String(err);
      const errorHtml = `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;background:#0f111a;color:#e2e8f0;"><h1 style="color:#f87171;">502 Bad Gateway</h1><p><strong>Failed to reach target server:</strong> ${this.targetHost}</p><p><strong>Error details:</strong> ${errMsg}</p><p>Make sure your local application is running and the target port matches.</p></body></html>`;
      return encoder.encode(errorHtml).buffer;
    }
  }

  // Send framed chunks over persistent data channel with backpressure control
  private async sendFramedPayload(dc: RTCDataChannel, reqId: number, payload: ArrayBuffer): Promise<void> {
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

    const payloadArr = new Uint8Array(payload);
    const totalLen = payloadArr.byteLength;

    for (let offset = 0; offset < totalLen || (totalLen === 0 && offset === 0); offset += CHUNK_PAYLOAD_SIZE) {
      if (dc.bufferedAmount > HIGH_WATER_MARK) {
        await new Promise((resolve, reject) => {
          const onLow = () => {
            dc.removeEventListener("bufferedamountlow", onLow);
            resolve(null);
          };
          const onClose = () => {
            dc.removeEventListener("bufferedamountlow", onLow);
            reject(new Error("DataChannel closed during transfer"));
          };

          dc.addEventListener("bufferedamountlow", onLow);
          dc.addEventListener("close", onClose, { once: true });
        });
      }

      if (dc.readyState !== "open") {
        return;
      }

      const thisChunkSize = Math.min(CHUNK_PAYLOAD_SIZE, totalLen - offset);
      const packet = new Uint8Array(HEADER_SIZE + thisChunkSize);
      const view = new DataView(packet.buffer);

      view.setUint32(0, reqId);
      view.setUint32(4, totalLen);
      view.setUint32(8, offset);

      if (thisChunkSize > 0) {
        packet.set(payloadArr.subarray(offset, offset + thisChunkSize), HEADER_SIZE);
      }

      dc.send(packet.buffer);

      if (totalLen === 0) break;
    }
  }

  // Client Mode: Handles a new intercepted request from the Service Worker
  public handleClientProxyRequest(
    reqId: number,
    head: ArrayBuffer,
    port: MessagePort,
    hasBody: boolean
  ): void {
    const proxyPeerId = this.findAvailableProxyPeer();
    if (!proxyPeerId) {
      port.postMessage({ type: "PROXY_RESPONSE_PLACEHOLDER" });
      port.close();
      return;
    }

    const pc = this.peerConnections.get(proxyPeerId);
    if (!pc || pc.connectionState !== "connected") {
      port.postMessage({ type: "PROXY_RESPONSE_PLACEHOLDER" });
      port.close();
      return;
    }

    // 1. Create a dynamic DataChannel dedicated to this request
    const dc = pc.createDataChannel(`req-${reqId}`, { ordered: true });
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
      // Send the HTTP request header block first
      dc.send(head);

      // Listen for body chunks from the Service Worker port
      port.onmessage = (ev) => {
        if (ev.data.type === REQUEST_BODY_CHUNK) {
          if (dc.readyState === "open") {
            dc.send(ev.data.buffer);
          }
        } else if (ev.data.type === REQUEST_BODY_END) {
          // Request body finished
        }
      };
    };

    // PLACEHOLDER: Hollow stub for next phase (Response Proxying)
    // When host sends response chunks on `dc`, we will forward them to `port`
    dc.onmessage = (ev) => {
      // Hollow stub for response phase
    };

    dc.onclose = () => {
      port.close();
    };

    dc.onerror = () => {
      port.close();
    };
  }

  private findAvailableProxyPeer(): string | null {
    // 1. Prefer peer explicitly marked as proxy
    for (const [pid, meta] of this.peerMetadataMap) {
      if (meta.role === "proxy") {
        const dc = this.tunnelChannels.get(pid);
        if (dc && dc.readyState === "open") {
          return pid;
        }
      }
    }
    // 2. Fallback to any peer with an open tunnel data channel
    for (const [pid] of this.peerConnections) {
      const dc = this.tunnelChannels.get(pid);
      if (dc && dc.readyState === "open") {
        return pid;
      }
    }
    return null;
  }

  private closePeer(peerId: string): void {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    const dc = this.tunnelChannels.get(peerId);
    if (dc) {
      dc.close();
      this.tunnelChannels.delete(peerId);
    }
    const ctrl = this.controlChannels.get(peerId);
    if (ctrl) {
      ctrl.close();
      this.controlChannels.delete(peerId);
    }
    this.peerMetadataMap.delete(peerId);
    this.updatePeersList();
  }
}
