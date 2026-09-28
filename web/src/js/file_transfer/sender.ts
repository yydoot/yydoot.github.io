import {
  type FileMetadata,
  type ControlMessage,
  type TransferProgress,
} from "./protocol";

export const CHUNK_SIZE = 64 * 1024; // 64 KB

export class SenderManager {
  private localFiles = new Map<string, File>();
  private senderQueue: string[] = [];
  private fileOffsets = new Map<string, number>();
  private isStreaming = false;
  private activeFileId: string | null = null;
  private readyResolvers = new Map<string, () => void>();

  public offerFiles(files: FileList | File[]): FileMetadata[] {
    this.localFiles.clear();
    this.fileOffsets.clear();
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      const id = crypto.randomUUID();
      this.localFiles.set(id, file);
    }
    return this.getLocalManifest();
  }

  public revokeFile(fileId: string): void {
    this.localFiles.delete(fileId);
    this.fileOffsets.delete(fileId);
  }

  public clearAllFiles(): void {
    this.localFiles.clear();
    this.fileOffsets.clear();
  }

  public getLocalManifest(): FileMetadata[] {
    const list: FileMetadata[] = [];
    for (const [id, file] of this.localFiles.entries()) {
      list.push({
        id,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified,
      });
    }
    return list;
  }

  public handleFileRequest(
    fileId: string,
    offset: number = 0,
    transferChannel: RTCDataChannel | null,
    sendControl: (msg: ControlMessage) => void,
    onProgress?: (progress: TransferProgress) => void
  ): void {
    if (!this.localFiles.has(fileId)) return;
    this.fileOffsets.set(fileId, offset);
    if (!this.senderQueue.includes(fileId)) {
      this.senderQueue.push(fileId);
    }
    this.processQueue(transferChannel, sendControl, onProgress);
  }

  public handleFileReady(fileId: string): void {
    const resolve = this.readyResolvers.get(fileId);
    if (resolve) {
      this.readyResolvers.delete(fileId);
      resolve();
    }
  }

  public cancel(fileId: string): void {
    if (this.activeFileId === fileId) {
      this.activeFileId = null;
    }
    const resolve = this.readyResolvers.get(fileId);
    if (resolve) {
      this.readyResolvers.delete(fileId);
      resolve();
    }
    const idx = this.senderQueue.indexOf(fileId);
    if (idx !== -1) {
      this.senderQueue.splice(idx, 1);
    }
  }

  private async processQueue(
    transferChannel: RTCDataChannel | null,
    sendControl: (msg: ControlMessage) => void,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    if (this.isStreaming || this.senderQueue.length === 0) return;
    this.isStreaming = true;

    while (this.senderQueue.length > 0) {
      const fileId = this.senderQueue.shift()!;
      const file = this.localFiles.get(fileId);

      if (!file || !transferChannel || transferChannel.readyState !== "open") {
        continue;
      }

      this.activeFileId = fileId;
      const offset = this.fileOffsets.get(fileId) || 0;

      // 1. Notify receiver about incoming file with starting offset
      sendControl({
        type: "file_start",
        fileId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        offset,
      });

      // 2. Wait for receiver to acknowledge storage initialization (with 5s timeout fallback)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.readyResolvers.delete(fileId);
          resolve();
        }, 5000);

        this.readyResolvers.set(fileId, () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (this.activeFileId !== fileId) continue;

      const startTime = performance.now();
      let bytesSent = offset;
      const slicedFile = offset > 0 ? file.slice(offset) : file;
      const stream = slicedFile.stream();
      const reader = stream.getReader();

      try {
        let remainder = new Uint8Array(0);

        while (this.activeFileId === fileId) {
          const { done, value } = await reader.read();
          if (done && remainder.byteLength === 0) break;

          if (value) {
            const combined = new Uint8Array(remainder.byteLength + value.byteLength);
            combined.set(remainder, 0);
            combined.set(value, remainder.byteLength);
            remainder = combined;
          }

          while (remainder.byteLength >= CHUNK_SIZE || (done && remainder.byteLength > 0)) {
            if (this.activeFileId !== fileId) break;

            const sliceSize = Math.min(remainder.byteLength, CHUNK_SIZE);
            const chunkData = remainder.slice(0, sliceSize);
            remainder = remainder.slice(sliceSize);

            // Flow control: backpressure if buffer exceeds 256 KB
            if (transferChannel.bufferedAmount > 256 * 1024) {
              await this.waitForBufferDrain(transferChannel);
            }

            if (transferChannel.readyState !== "open" || this.activeFileId !== fileId) break;
            transferChannel.send(chunkData.buffer);
            bytesSent += chunkData.byteLength;

            const elapsedSec = (performance.now() - startTime) / 1000;
            const speedBps = elapsedSec > 0 ? (bytesSent - offset) / elapsedSec : 0;
            const progress = file.size > 0 ? bytesSent / file.size : 1;

            onProgress?.({
              fileId,
              filename: file.name,
              bytesTransferred: bytesSent,
              totalBytes: file.size,
              progress,
              speedBps,
              direction: "sending",
            });

            if (done && remainder.byteLength === 0) break;
          }
        }

        if (this.activeFileId === fileId) {
          sendControl({ type: "file_end", fileId });
        }
      } catch (err) {
        console.error("[Sender] Streaming error:", err);
        sendControl({
          type: "transfer_error",
          fileId,
          error: String(err),
        });
      } finally {
        reader.releaseLock();
        this.activeFileId = null;
      }
    }

    this.isStreaming = false;
  }

  private waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      if (channel.bufferedAmount <= 64 * 1024) {
        resolve();
        return;
      }
      const onLow = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
      setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      }, 50);
    });
  }
}
