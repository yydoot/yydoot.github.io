export function iconForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    // images
    png: "vscode-icons:file-type-image",
    jpg: "vscode-icons:file-type-image",
    jpeg: "vscode-icons:file-type-image",
    gif: "vscode-icons:file-type-image",
    svg: "vscode-icons:file-type-svg",
    webp: "vscode-icons:file-type-image",
    tif: "vscode-icons:file-type-image",
    raw: "vscode-icons:file-type-image",
    ico: "vscode-icons:file-type-image",
    // video
    mp4: "vscode-icons:file-type-video",
    avi: "vscode-icons:file-type-video",
    mov: "vscode-icons:file-type-video",
    mpeg: "vscode-icons:file-type-video",
    flv: "vscode-icons:file-type-video",
    wmv: "vscode-icons:file-type-video",
    vob: "vscode-icons:file-type-video",
    mkv: "vscode-icons:file-type-video",
    webm: "vscode-icons:file-type-video",
    // audio
    mp3: "catppuccin:audio",
    wav: "catppuccin:audio",
    wma: "catppuccin:audio",
    midi: "catppuccin:audio",
    flac: "catppuccin:audio",
    acc: "catppuccin:audio",
    aac: "catppuccin:audio",
    ogg: "catppuccin:audio",
    m3u: "catppuccin:audio",
    aif: "catppuccin:audio",
    m4a: "catppuccin:audio",
    mpa: "catppuccin:audio",
    pls: "catppuccin:audio",
    opus: "catppuccin:audio",
    // documents & markdown
    md: "material-icon-theme:markdown",
    markdown: "material-icon-theme:markdown",
    mdown: "material-icon-theme:markdown",
    doc: "vscode-icons:file-type-word",
    docx: "vscode-icons:file-type-word",
    txt: "vscode-icons:file-type-text",
    odt: "vscode-icons:file-type-word",
    rtf: "vscode-icons:file-type-text",
    csv: "vscode-icons:file-type-excel",
    xls: "vscode-icons:file-type-excel",
    xlsx: "vscode-icons:file-type-excel",
    ppt: "vscode-icons:file-type-powerpoint",
    pptx: "vscode-icons:file-type-powerpoint",
    pdf: "vscode-icons:file-type-pdf2",
    // archives & binaries
    zip: "catppuccin:zip",
    rar: "catppuccin:zip",
    "7z": "catppuccin:zip",
    tar: "catppuccin:zip",
    gz: "catppuccin:zip",
    dmg: "vscode-icons:file-type-binary",
    exe: "vscode-icons:file-type-binary",
    iso: "vscode-icons:file-type-binary",
    // code & design
    psd: "vscode-icons:file-type-photoshop",
    eps: "vscode-icons:file-type-illustrator",
    ai: "vscode-icons:file-type-illustrator",
    js: "vscode-icons:file-type-js",
    ts: "vscode-icons:file-type-typescript",
    jsx: "vscode-icons:file-type-reactjs",
    tsx: "vscode-icons:file-type-reactts",
    html: "vscode-icons:file-type-html",
    css: "vscode-icons:file-type-css",
    py: "vscode-icons:file-type-python",
    json: "vscode-icons:file-type-json",
    astro: "vscode-icons:file-type-astro",
  };
  return map[ext] || "vscode-icons:default-file";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
