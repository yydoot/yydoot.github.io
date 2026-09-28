import {
  type FileMetadata,
  type ControlMessage,
  type TransferProgress,
  type WebRTCEvents,
} from "./protocol";
import { FileConnectionManager } from "./connection";
import { SenderManager } from "./sender";
import { ReceiverManager } from "./receiver";
import { PEER_ID } from "../peerId";

export * from "./protocol";
export * from "./storage";
export * from "./sender";
export * from "./receiver";
export * from "./connection";
export * from "./fileUtils";
export { PEER_ID };

let connection: FileConnectionManager | null = null;
const sender = new SenderManager();
const receiver = new ReceiverManager();
let events: WebRTCEvents = {};

export function initWebRTC(
  roomId: string,
  eventHandlers: WebRTCEvents = {},
  metadata?: any,
): FileConnectionManager {
  events = eventHandlers;

  if (connection) {
    connection.disconnect();
  }

  connection = new FileConnectionManager(PEER_ID, roomId, {
    onPeerJoined: (peerId, meta) => events.onPeerJoined?.(peerId, meta),
    onPeerMetadataUpdated: (peerId, meta) => events.onPeerMetadataUpdated?.(peerId, meta),
    onPeerLeft: (peerId) => {
      receiver.reset();
      events.onPeerLeft?.(peerId);
      events.onRemoteManifest?.([]);
    },
    onChannelState: (isOpen) => {
      events.onChannelState?.(isOpen);
      if (isOpen) {
        broadcastManifest();
      }
    },
    onConnectionState: (state) => events.onConnectionState?.(state),
    onControlMessage: (msg) => handleControl(msg),
    onTransferChunk: async (chunk) => {
      await receiver.ingestChunk(chunk, (p) => events.onTransferProgress?.(p));
    },
  });

  connection.connect(metadata);
  return connection;
}

async function handleControl(msg: ControlMessage | string): Promise<void> {
  if (typeof msg === "string") {
    events.onMessage?.(msg);
    return;
  }

  switch (msg.type) {
    case "manifest_offer": {
      const remote = receiver.handleManifestOffer(msg.files);
      events.onRemoteManifest?.(remote);
      break;
    }

    case "manifest_revoke": {
      const remote = receiver.handleManifestRevoke(msg.fileIds);
      events.onRemoteManifest?.(remote);
      break;
    }

    case "request_file": {
      if (connection) {
        sender.handleFileRequest(
          msg.fileId,
          msg.offset || 0,
          connection.getTransferChannel(),
          (ctrl) => connection?.sendControl(ctrl),
          (p) => events.onTransferProgress?.(p),
        );
      }
      break;
    }

    case "file_start": {
      const ok = await receiver.handleFileStart(
        msg.fileId,
        msg.name,
        msg.size,
        msg.mime,
        msg.offset || 0,
      );
      if (ok) {
        connection?.sendControl({
          type: "file_ready",
          fileId: msg.fileId,
        });
      } else {
        cancelTransfer(msg.fileId);
      }
      break;
    }

    case "file_ready": {
      sender.handleFileReady(msg.fileId);
      break;
    }

    case "file_end": {
      const file = await receiver.handleFileEnd(msg.fileId);
      if (file) {
        events.onFileReceived?.(file);
      }
      break;
    }

    case "transfer_cancel": {
      sender.cancel(msg.fileId);
      await receiver.cancel(msg.fileId);
      break;
    }
  }
}

export function offerLocalFiles(files: FileList | File[]): FileMetadata[] {
  const manifest = sender.offerFiles(files);
  broadcastManifest();
  return manifest;
}

export function revokeLocalFile(fileId: string): void {
  sender.revokeFile(fileId);
  connection?.sendControl({
    type: "manifest_revoke",
    fileIds: [fileId],
  });
}

export function getLocalManifest(): FileMetadata[] {
  return sender.getLocalManifest();
}

export function getRemoteManifest(): FileMetadata[] {
  return receiver.getRemoteManifest();
}

export function broadcastManifest(): void {
  connection?.sendControl({
    type: "manifest_offer",
    files: sender.getLocalManifest(),
  });
}

export function requestRemoteFile(fileId: string): void {
  const offset = receiver.getReceivedBytes(fileId);
  connection?.sendControl({
    type: "request_file",
    fileId,
    offset,
  });
}

export async function saveReceivedFile(fileId: string): Promise<boolean> {
  return await receiver.saveReceivedFile(fileId);
}

export function cancelTransfer(fileId: string): void {
  sender.cancel(fileId);
  receiver.cancel(fileId);
  connection?.sendControl({
    type: "transfer_cancel",
    fileId,
  });
}

export function sendDataMessage(message: string): boolean {
  if (connection && connection.isReady()) {
    connection.sendControl(message);
    return true;
  }
  return false;
}

export function isDataChannelReady(): boolean {
  return connection !== null && connection.isReady();
}
