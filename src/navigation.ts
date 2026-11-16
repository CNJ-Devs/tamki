export function isWebURL(value: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export const searchEngines = {
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  duckduckgo: "https://duckduckgo.com/?q=",
};
export type SearchEngine = keyof typeof searchEngines;
export function searchURL(query: string, engine: SearchEngine = "google") {
  return searchEngines[engine] + encodeURIComponent(query);
}
export function resolveAddress(
  input: string,
  engine: SearchEngine = "google",
): string {
  const value = input.trim();
  if (!value) return "about:blank";
  if (isWebURL(value)) return new URL(value).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[\w.-]+:\d+(?:\/|$)/.test(value))
    throw new Error("Unsupported URL protocol");
  if (/^(localhost|(?:[\w-]+\.)+[\w-]+)(:\d+)?(?:[/?#].*)?$/.test(value))
    return new URL(
      `${value.startsWith("localhost") ? "http" : "https"}://${value}`,
    ).href;
  return searchURL(value, engine);
}
