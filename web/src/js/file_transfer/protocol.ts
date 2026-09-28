export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
}

export type ControlMessage =
  | { type: "manifest_offer"; files: FileMetadata[] }
  | { type: "manifest_revoke"; fileIds: string[] }
  | { type: "request_file"; fileId: string; offset?: number }
  | {
    type: "file_start";
    fileId: string;
    name: string;
    size: number;
    mime: string;
    offset?: number;
  }
  | { type: "file_ready"; fileId: string }
  | { type: "file_end"; fileId: string }
  | { type: "transfer_cancel"; fileId: string }
  | { type: "transfer_error"; fileId: string; error: string };

export interface TransferProgress {
  fileId: string;
  filename: string;
  bytesTransferred: number;
  totalBytes: number;
  progress: number; // 0.0 to 1.0
  speedBps: number; // Bytes per second
  direction: "sending" | "receiving";
}

export interface WebRTCEvents {
  onPeerJoined?: (peerId: string, metadata?: any) => void;
  onPeerMetadataUpdated?: (peerId: string, metadata: any) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelState?: (isOpen: boolean) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onMessage?: (data: string) => void;
  onRemoteManifest?: (files: FileMetadata[]) => void;
  onTransferProgress?: (progress: TransferProgress) => void;
  onFileReceived?: (file: File) => void;
}

export const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
];
