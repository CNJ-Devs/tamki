export function isWebURL(value: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export function resolveAddress(input: string): string {
  const value = input.trim();
  if (!value) return "about:blank";
  if (isWebURL(value)) return new URL(value).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[\w.-]+:\d+(?:\/|$)/.test(value))
    throw new Error("Unsupported URL protocol");
  if (/^(localhost|(?:[\w-]+\.)+[\w-]+)(:\d+)?(?:[/?#].*)?$/.test(value))
    return new URL(
      `${value.startsWith("localhost") ? "http" : "https"}://${value}`,
    ).href;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
