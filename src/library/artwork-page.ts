import { artworkURL } from "./artwork-fetch";
const decode = (s: string) =>
  s.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (full, key: string) => {
      if (key[0] === "#") {
        const n =
          key[1].toLowerCase() === "x"
            ? parseInt(key.slice(2), 16)
            : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
      }
      return (
        (
          { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<
            string,
            string
          >
        )[key.toLowerCase()] || full
      );
    },
  );
/** Metadata only: no page scripts, arbitrary inline images, icons or screenshots. */
export function pageArtwork(html: string, page: string): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    try {
      const url = artworkURL(new URL(decode(value), page).href);
      if (!candidates.includes(url)) candidates.push(url);
    } catch {}
  };
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  const tags = clean.match(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) || [];
  const properties = new Map<string, string[]>();
  for (const tag of tags) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    ))
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (attrs.content)
      properties.set(key, [...(properties.get(key) || []), attrs.content]);
  }
  for (const key of [
    "og:image:secure_url",
    "og:image",
    "twitter:image",
    "twitter:image:src",
  ])
    for (const value of properties.get(key) || []) add(value);
  // Structured work records can supply the poster when social metadata is absent.
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    try {
      const visit = (item: unknown, depth = 0) => {
        if (depth > 5 || !item || typeof item !== "object") return;
        if (Array.isArray(item)) {
          item.slice(0, 100).forEach((v) => visit(v, depth + 1));
          return;
        }
        const obj = item as Record<string, unknown>,
          types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
        if (
          types.some((t) =>
            [
              "Movie",
              "TVSeries",
              "TVSeason",
              "TVEpisode",
              "CreativeWork",
              "VideoObject",
            ].includes(String(t)),
          )
        ) {
          for (const image of Array.isArray(obj.image)
            ? obj.image
            : [obj.image])
            add(
              typeof image === "object" && image
                ? image.url || image.contentUrl
                : image,
            );
          add(obj.thumbnailUrl);
        }
        visit(obj["@graph"], depth + 1);
      };
      visit(JSON.parse(match[1]));
    } catch {}
  }
  // AMP sharing widgets declare the page's share image explicitly. Unlike
  // arbitrary inline images, this does not select recommendation thumbnails.
  for (const tag of clean.match(
    /<amp-social-share\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi,
  ) || []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    ))
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    if (attrs.type?.toLowerCase() === "pinterest")
      add(attrs["data-param-media"]);
  }
  return candidates.slice(0, 4);
}
