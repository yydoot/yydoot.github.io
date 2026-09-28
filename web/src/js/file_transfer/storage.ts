export type StorageTier = "opfs" | "memory";

export class FileDestinationWriter {
  public tier: StorageTier = "memory";
  private filename: string;
  private mime: string;
  private fileId: string;

  private writable: FileSystemWritableFileStream | null = null;
  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private opfsFileHandle: FileSystemFileHandle | null = null;
  private opfsTempName: string;

  // Memory Fallback
  private memoryChunks: ArrayBuffer[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filename: string, mime = "application/octet-stream", fileId: string) {
    this.filename = filename;
    this.mime = mime;
    this.fileId = fileId;
    this.opfsTempName = `doot_opfs_${fileId}_${filename}`;
  }

  public async init(offset = 0): Promise<boolean> {
    // 🍏 TIER 1: OPFS Sandbox Stream (Background network stream without prompt blocks)
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      try {
        this.opfsRoot = await navigator.storage.getDirectory();
        this.opfsFileHandle = await this.opfsRoot.getFileHandle(this.opfsTempName, { create: true });
        this.writable = await this.opfsFileHandle.createWritable({ keepExistingData: offset > 0 });
        if (offset > 0) {
          await this.writable.seek(offset);
        }
        this.tier = "opfs";
        return true;
      } catch (err) {
        console.warn("[Storage] OPFS stream failed, falling back to memory:", err);
      }
    }

    // 🚨 TIER 2: Memory Blob Stream Fallback
    this.tier = "memory";
    if (offset === 0) {
      this.memoryChunks = [];
    }
    return true;
  }

  public async writeChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.writable) {
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.writable) {
          await this.writable.write(chunk);
        }
      });
      await this.writeQueue;
    } else {
      this.memoryChunks.push(chunk);
    }
  }

  public async pause(): Promise<void> {
    await this.writeQueue;
    if (this.writable) {
      try {
        await this.writable.close();
      } catch { }
      this.writable = null;
    }
  }

  public async finish(): Promise<File | null> {
    await this.writeQueue;
    // 🍏 OPFS Complete -> Get completed File object
    if (this.tier === "opfs" && this.writable && this.opfsFileHandle) {
      await this.writable.close();
      this.writable = null;

      const opfsFile = await this.opfsFileHandle.getFile();
      const file = new File([opfsFile], this.filename, {
        type: this.mime,
        lastModified: Date.now(),
      });
      return file;
    }

    // 🚨 Memory Complete -> Get completed File object
    const blob = new Blob(this.memoryChunks, { type: this.mime });
    this.memoryChunks = [];
    const file = new File([blob], this.filename, {
      type: this.mime,
      lastModified: Date.now(),
    });
    return file;
  }

  public async cleanup(): Promise<void> {
    this.memoryChunks = [];
    if (this.writable) {
      try {
        await this.writable.abort();
      } catch { }
      this.writable = null;
    }

    if (this.opfsRoot && this.opfsTempName) {
      try {
        await this.opfsRoot.removeEntry(this.opfsTempName);
      } catch { }
    }
  }
}

/**
 * Save a received file using the best available API:
 * 1. showSaveFilePicker (Direct-to-Disk on user click with folder selection)
 * 2. Standard browser download fallback
 */
export async function saveFileToDisk(file: File): Promise<boolean> {
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: file.name,
      });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("[Storage] User cancelled file save dialog.");
        return false;
      }
      console.warn("[Storage] showSaveFilePicker failed, triggering standard download:", err);
    }
  }

  // Fallback: standard browser download
  triggerBrowserDownload(file);
  return true;
}

export function triggerBrowserDownload(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}
