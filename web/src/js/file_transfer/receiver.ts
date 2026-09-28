import {
  type FileMetadata,
  type TransferProgress,
} from "./protocol";
import { FileDestinationWriter, saveFileToDisk } from "./storage";

interface ActiveIncomingFile {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  receivedBytes: number;
  startTime: number;
  writer: FileDestinationWriter;
}

export class ReceiverManager {
  private remoteManifest = new Map<string, FileMetadata>();
  private activeIncoming: ActiveIncomingFile | null = null;
  private partialFiles = new Map<string, { writer: FileDestinationWriter; receivedBytes: number }>();
  private completedFiles = new Map<string, File>();

  public getReceivedBytes(fileId: string): number {
    if (this.activeIncoming && this.activeIncoming.fileId === fileId) {
      return this.activeIncoming.receivedBytes;
    }
    const partial = this.partialFiles.get(fileId);
    return partial ? partial.receivedBytes : 0;
  }

  public handleManifestOffer(files: FileMetadata[]): FileMetadata[] {
    this.remoteManifest.clear();
    for (const file of files) {
      this.remoteManifest.set(file.id, file);
    }
    return this.getRemoteManifest();
  }

  public handleManifestRevoke(fileIds: string[]): FileMetadata[] {
    for (const id of fileIds) {
      this.remoteManifest.delete(id);
      this.completedFiles.delete(id);
      const partial = this.partialFiles.get(id);
      if (partial) {
        partial.writer.cleanup();
        this.partialFiles.delete(id);
      }
    }
    return this.getRemoteManifest();
  }

  public getRemoteManifest(): FileMetadata[] {
    return Array.from(this.remoteManifest.values());
  }

  public async handleFileStart(
    fileId: string,
    name: string,
    size: number,
    mime: string,
    offset = 0
  ): Promise<boolean> {
    let writer: FileDestinationWriter;
    const partial = this.partialFiles.get(fileId);

    if (partial && offset > 0) {
      writer = partial.writer;
    } else {
      if (partial) {
        await partial.writer.cleanup();
        this.partialFiles.delete(fileId);
      }
      writer = new FileDestinationWriter(name, mime, fileId);
    }

    const initialized = await writer.init(offset);
    if (!initialized) {
      return false;
    }

    this.activeIncoming = {
      fileId,
      name,
      size,
      mime,
      receivedBytes: offset,
      startTime: performance.now(),
      writer,
    };
    return true;
  }

  public async ingestChunk(
    chunk: ArrayBuffer,
    onProgress?: (progress: TransferProgress) => void
  ): Promise<void> {
    if (!this.activeIncoming) return;

    await this.activeIncoming.writer.writeChunk(chunk);
    this.activeIncoming.receivedBytes += chunk.byteLength;

    const elapsedSec = (performance.now() - this.activeIncoming.startTime) / 1000;
    const speedBps = elapsedSec > 0 ? this.activeIncoming.receivedBytes / elapsedSec : 0;
    const progress = this.activeIncoming.size > 0
      ? this.activeIncoming.receivedBytes / this.activeIncoming.size
      : 1;

    onProgress?.({
      fileId: this.activeIncoming.fileId,
      filename: this.activeIncoming.name,
      bytesTransferred: this.activeIncoming.receivedBytes,
      totalBytes: this.activeIncoming.size,
      progress,
      speedBps,
      direction: "receiving",
    });
  }

  public async handleFileEnd(fileId: string): Promise<File | null> {
    if (!this.activeIncoming || this.activeIncoming.fileId !== fileId) {
      return null;
    }

    const file = await this.activeIncoming.writer.finish();
    if (file) {
      this.completedFiles.set(fileId, file);
      this.partialFiles.delete(fileId);
    }
    this.activeIncoming = null;
    return file;
  }

  public async saveReceivedFile(fileId: string): Promise<boolean> {
    const file = this.completedFiles.get(fileId);
    if (!file) return false;
    return await saveFileToDisk(file);
  }

  public async cancel(fileId: string): Promise<void> {
    if (this.activeIncoming && this.activeIncoming.fileId === fileId) {
      await this.activeIncoming.writer.pause();
      this.partialFiles.set(fileId, {
        writer: this.activeIncoming.writer,
        receivedBytes: this.activeIncoming.receivedBytes,
      });
      this.activeIncoming = null;
    }
  }

  public reset(): void {
    this.remoteManifest.clear();
    if (this.activeIncoming) {
      this.activeIncoming.writer.cleanup();
      this.activeIncoming = null;
    }
    for (const partial of this.partialFiles.values()) {
      partial.writer.cleanup();
    }
    this.partialFiles.clear();
    this.completedFiles.clear();
  }
}
