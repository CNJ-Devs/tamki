export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number; partial: boolean } | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end, partial: true };
}
export function mediaType(file: string): string {
  const extension = file.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        mp4: "video/mp4",
        m4v: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
        mkv: "video/x-matroska",
        ts: "video/mp2t",
        m2ts: "video/mp2t",
      } as Record<string, string>
    )[extension || ""] || "application/octet-stream"
  );
}
