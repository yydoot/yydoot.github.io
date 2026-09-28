import {
  type ControlMessage,
  STUN_SERVERS,
} from "./protocol";
import { SS, type Signal } from "../signaling";

export { STUN_SERVERS };

export interface FileConnectionCallbacks {
  onPeerJoined?: (peerId: string, metadata?: any) => void;
  onPeerMetadataUpdated?: (peerId: string, metadata: any) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelState?: (isOpen: boolean) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onControlMessage?: (msg: ControlMessage | string) => void;
  onTransferChunk?: (chunk: ArrayBuffer) => void;
}

export class FileConnectionManager {
  private peerId: string;
  private roomId: string;
  private callbacks: FileConnectionCallbacks;
  private peerConnection: { peer_id: string; conn: RTCPeerConnection } | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private transferChannel: RTCDataChannel | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor(
    peerId: string,
    roomId: string,
    callbacks: FileConnectionCallbacks = {},
  ) {
    this.peerId = peerId;
    this.roomId = roomId;
    this.callbacks = callbacks;
  }

  public connect(metadata?: any): void {
    // 1. Subscribe to signaling events via SS
    const u1 = SS.on("room_joined", (msg) => {
      if (msg.room_id !== this.roomId) return;
      if (msg.peers && msg.peers.length > 0) {
        const first = msg.peers[0];
        const peerId = typeof first === "string" ? first : first?.peer_id;
        const meta = typeof first === "object" ? first?.metadata : undefined;
        if (peerId) {
          this.callbacks.onPeerJoined?.(peerId, meta);
        }
      }
    });

    const u2 = SS.on("peer_joined", async (msg) => {
      if (msg.room_id !== this.roomId) return;
      this.callbacks.onPeerJoined?.(msg.peer_id, msg.metadata);
      await this.handleInitiatorHandshake(msg.peer_id);
    });

    const u3 = SS.on("peer_metadata_updated", (msg) => {
      if (msg.room_id !== this.roomId) return;
      this.callbacks.onPeerMetadataUpdated?.(msg.peer_id, msg.metadata);
    });

    const u4 = SS.on("peer_offer", async (msg) => {
      this.callbacks.onPeerJoined?.(msg.from_peer);
      await this.handleReceiverHandshake(msg.from_peer, msg.sdp);
    });

    const u5 = SS.on("peer_answer", async (msg) => {
      if (
        this.peerConnection &&
        this.peerConnection.peer_id === msg.from_peer
      ) {
        await this.peerConnection.conn.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
        );
      }
    });

    const u6 = SS.on("peer_ice_candidate", async (msg) => {
      if (
        this.peerConnection &&
        this.peerConnection.peer_id === msg.from_peer
      ) {
        try {
          await this.peerConnection.conn.addIceCandidate(
            new RTCIceCandidate(msg.candidate),
          );
        } catch (err) {
          console.error("[FileConnection] ICE candidate error:", err);
        }
      }
    });

    const u7 = SS.on("peer_left", (msg) => {
      if (msg.room_id !== this.roomId) return;
      this.callbacks.onPeerLeft?.(msg.peer_id);
      this.closePeerConnection(msg.peer_id);
    });

    this.unsubscribers = [u1, u2, u3, u4, u5, u6, u7];

    // 2. Join room on signaling server
    SS.joinRoom(this.roomId, metadata);
  }

  public disconnect(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.peerConnection) {
      this.closePeerConnection(this.peerConnection.peer_id);
    }
  }

  public sendControl(msg: ControlMessage | string): void {
    if (this.controlChannel && this.controlChannel.readyState === "open") {
      const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
      this.controlChannel.send(payload);
    }
  }

  public getTransferChannel(): RTCDataChannel | null {
    return this.transferChannel;
  }

  public isReady(): boolean {
    return (
      this.controlChannel !== null &&
      this.controlChannel.readyState === "open" &&
      this.transferChannel !== null &&
      this.transferChannel.readyState === "open"
    );
  }

  private createPeerConnection(remotePeerId: string): {
    peer_id: string;
    conn: RTCPeerConnection;
  } {
    if (this.peerConnection) return this.peerConnection;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: STUN_SERVERS }],
    });

    this.peerConnection = { peer_id: remotePeerId, conn: pc };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        SS.sendSignal({
          type: "ice_candidate",
          peer_id: remotePeerId,
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionState?.(pc.connectionState);
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        this.checkReadiness();
      }
    };

    return this.peerConnection;
  }

  private async handleInitiatorHandshake(remotePeerId: string): Promise<void> {
    const peerConn = this.createPeerConnection(remotePeerId);
    const pc = peerConn.conn;

    const ctrl = pc.createDataChannel("control", { ordered: true });
    this.setupControlChannel(ctrl);

    const trans = pc.createDataChannel("transfer", { ordered: true });
    this.setupTransferChannel(trans);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (offer.sdp) {
      SS.sendSignal({
        type: "offer",
        peer_id: remotePeerId,
        sdp: offer.sdp,
      });
    }
  }

  private async handleReceiverHandshake(
    fromPeer: string,
    sdp: string,
  ): Promise<void> {
    const peerConn = this.createPeerConnection(fromPeer);
    const pc = peerConn.conn;

    pc.ondatachannel = (event) => {
      if (event.channel.label === "control") {
        this.setupControlChannel(event.channel);
      } else if (event.channel.label === "transfer") {
        this.setupTransferChannel(event.channel);
      }
    };

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp }),
    );
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (answer.sdp) {
      SS.sendSignal({
        type: "answer",
        peer_id: fromPeer,
        sdp: answer.sdp,
      });
    }
  }

  private setupControlChannel(channel: RTCDataChannel): void {
    this.controlChannel = channel;

    channel.onopen = () => this.checkReadiness();
    channel.onclose = () => this.checkReadiness();

    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data) as ControlMessage;
        this.callbacks.onControlMessage?.(msg);
      } catch {
        this.callbacks.onControlMessage?.(event.data);
      }
    };
  }

  private setupTransferChannel(channel: RTCDataChannel): void {
    this.transferChannel = channel;
    this.transferChannel.binaryType = "arraybuffer";
    this.transferChannel.bufferedAmountLowThreshold = 512 * 1024;

    channel.onopen = () => this.checkReadiness();
    channel.onclose = () => this.checkReadiness();

    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) {
        this.callbacks.onTransferChunk?.(event.data);
      }
    };
  }

  private checkReadiness(): void {
    this.callbacks.onChannelState?.(this.isReady());
  }

  private closePeerConnection(remotePeerId: string): void {
    if (this.peerConnection && this.peerConnection.peer_id === remotePeerId) {
      this.controlChannel?.close();
      this.controlChannel = null;
      this.transferChannel?.close();
      this.transferChannel = null;
      this.peerConnection.conn.close();
      this.peerConnection = null;
      this.callbacks.onChannelState?.(false);
    }
  }
}
