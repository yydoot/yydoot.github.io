import { INVALID_MESSAGE } from "./errors";
import {
  ActivePeers,
  Rooms,
  type PeerId,
  type PeerState,
} from "./state";

export type ClientMessage =
  | { type: "join"; room_id: string; metadata?: unknown }
  | { type: "leave"; room_id: string }
  | { type: "update_metadata"; room_id: string; metadata: unknown }
  | { type: "offer"; peer_id: PeerId; sdp: string }
  | { type: "answer"; peer_id: PeerId; sdp: string }
  | { type: "ice_candidate"; peer_id: PeerId; candidate: unknown };

export function ParseMessage(message: any): Result<ClientMessage> {
  if (typeof message != "object" || message === null || !message.type) {
    return ErrorResult("invalid message");
  }

  switch (message.type) {
    case "join": {
      if (
        typeof message.room_id !== "string" ||
        message.room_id.trim().length === 0 ||
        message.room_id.length > 100
      ) {
        return ErrorResult("invalid room_id");
      }
      return Result({
        type: "join",
        room_id: message.room_id.trim().toLowerCase(),
        metadata: message.metadata,
      });
    }
    case "leave": {
      if (
        typeof message.room_id !== "string" ||
        message.room_id.trim().length === 0 ||
        message.room_id.length > 100
      ) {
        return ErrorResult("invalid room_id");
      }
      return Result({ type: message.type, room_id: message.room_id.trim().toLowerCase() });
    }
    case "update_metadata": {
      if (
        typeof message.room_id !== "string" ||
        message.room_id.trim().length === 0 ||
        message.room_id.length > 100
      ) {
        return ErrorResult("invalid room_id");
      }
      if (message.metadata === undefined) {
        return ErrorResult("missing metadata");
      }
      return Result({
        type: "update_metadata",
        room_id: message.room_id.trim().toLowerCase(),
        metadata: message.metadata,
      });
    }
    case "offer":
    case "answer":
      if (
        typeof message.peer_id != "string" ||
        typeof message.sdp != "string"
      ) {
        return ErrorResult("invalid message");
      }

      return Result({
        type: message.type,
        peer_id: message.peer_id,
        sdp: message.sdp,
      });

    case "ice_candidate": {
      const cand = message.candidate;
      if (
        typeof message.peer_id != "string" ||
        typeof cand != "object" ||
        cand == null ||
        typeof cand.candidate != "string"
      ) {
        return ErrorResult("invalid ice_candidate");
      }

      return Result({
        type: "ice_candidate",
        peer_id: message.peer_id,
        candidate: message.candidate,
      });
    }

    default:
      return ErrorResult("invalid message");
  }
}

export type PeerInfo = {
  peer_id: PeerId;
  metadata?: unknown;
};

export type Signal =
  | { type: "room_joined"; room_id: string; peers: PeerInfo[] }
  | { type: "peer_joined"; room_id: string; peer_id: PeerId; metadata?: unknown }
  | { type: "peer_metadata_updated"; room_id: string; peer_id: PeerId; metadata: unknown }
  | { type: "peer_left"; room_id: string; peer_id: PeerId }
  | { type: "peer_offer"; from_peer: PeerId; sdp: string }
  | { type: "peer_answer"; from_peer: PeerId; sdp: string }
  | { type: "peer_ice_candidate"; from_peer: PeerId; candidate: unknown }
  | { type: "error"; code: number; message?: string };

type SignalType = Signal["type"];
type Payload<T extends SignalType> = Omit<Extract<Signal, { type: T }>, "type">;

export function Signal<T extends SignalType>(
  type: T,
  payload: Payload<T>,
): Extract<Signal, { type: T }> {
  return { type, ...payload } as any;
}

export function SendMessage(
  conn: Bun.ServerWebSocket<PeerState>,
  message: Signal,
) {
  conn.send(JSON.stringify(message));
}

export function PublishMessage(
  ws: Bun.ServerWebSocket<PeerState>,
  room_id: string,
  message: Signal,
) {
  ws.publish(room_id, JSON.stringify(message));
}

export function HandleMessage(
  ws: Bun.ServerWebSocket<PeerState>,
  message: ClientMessage,
) {
  const { id, rooms } = ws.data;

  switch (message.type) {
    case "join": {
      const room_id = message.room_id;

      if (rooms.has(room_id)) return;
      if (rooms.size >= 69) {
        SendMessage(ws, Signal("error", { code: 69 }));
        return;
      }

      if (message.metadata !== undefined) {
        ws.data.metadata = message.metadata;
      }

      let peers = Rooms.get(room_id);
      if (!peers) {
        peers = new Set<PeerId>();
        Rooms.set(room_id, peers);
      }

      const existingPeers: PeerInfo[] = [];
      for (const peer_id of peers) {
        const peerWs = ActivePeers.get(peer_id);
        existingPeers.push({
          peer_id,
          metadata: peerWs?.data.metadata,
        });
      }

      SendMessage(
        ws,
        Signal("room_joined", { room_id, peers: existingPeers }),
      );

      ws.subscribe(room_id);
      rooms.add(room_id);
      peers.add(id);

      console.log(
        `Peer ${id} joined room "${room_id}". Room peers: ${peers.size}`,
      );

      const msg = Signal("peer_joined", {
        room_id,
        peer_id: id,
        metadata: ws.data.metadata,
      });
      PublishMessage(ws, room_id, msg);
      return;
    }

    case "update_metadata": {
      const room_id = message.room_id;
      if (!rooms.has(room_id)) {
        SendMessage(ws, Signal("error", { code: INVALID_MESSAGE, message: "Not in room" }));
        return;
      }

      ws.data.metadata = message.metadata;

      const msg = Signal("peer_metadata_updated", {
        room_id,
        peer_id: id,
        metadata: message.metadata,
      });
      PublishMessage(ws, room_id, msg);
      return;
    }

    case "leave": {
      const room_id = message.room_id;
      if (!rooms.has(room_id)) return;

      rooms.delete(room_id);
      ws.unsubscribe(room_id);

      const peers = Rooms.get(room_id);
      if (peers) {
        peers.delete(id);
        if (peers.size === 0) {
          Rooms.delete(room_id);
        }
      }

      const msg = Signal("peer_left", { room_id, peer_id: id });
      PublishMessage(ws, room_id, msg);
      return;
    }

    case "offer":
    case "answer": {
      const peer_id = message.peer_id;
      const socket = ActivePeers.get(peer_id);
      if (!socket) return;

      let msg = Signal(message.type == "offer" ? "peer_offer" : "peer_answer", {
        from_peer: id,
        sdp: message.sdp,
      });

      SendMessage(socket, msg);
      return;
    }

    case "ice_candidate": {
      const peer_id = message.peer_id;
      const socket = ActivePeers.get(peer_id);
      if (!socket) return;

      let msg = Signal("peer_ice_candidate", {
        from_peer: id,
        candidate: message.candidate,
      });

      SendMessage(socket, msg);
      return;
    }
  }
}



type ErrorResult = {
  ok: false;
  result: string;
};

type Result<T> =
  | {
    ok: true;
    result: T;
  }
  | ErrorResult;

function Result<T>(result: T): Result<T> {
  return { ok: true, result: result };
}

function ErrorResult(reason: string): ErrorResult {
  return {
    ok: false,
    result: reason,
  };
}

