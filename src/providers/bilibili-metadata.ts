import { z } from "zod";
import type {
  RecognitionInput,
  RecognitionResponse,
} from "../shared/recognition";
import { matchEpisodes } from "./metadata";
import { metadataJSON } from "./metadata-http";
import { ProviderError } from "./provider";
import type { FilenameParser } from "../library/filename";

const endpoint = "https://api.bilibili.com";
const identifier = z.number().int().positive().safe();
const text = z.string().max(30000).nullish();
const plain = (value: string | null | undefined) =>
  (value || "")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|#39|#x27);/g,
      (s) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&#39;": "'",
          "&#x27;": "'",
        })[s] || s,
    )
    .trim();
const poster = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !["hdslb.com", "biliimg.com"].some(
        (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
      )
    )
      return null;
    url.protocol = "https:";
    return url.href.length <= 8192 ? url.href : null;
  } catch {
    return null;
  }
};
const hit = z.object({
  season_id: identifier,
  title: text,
  org_title: text,
  alias: text,
  desc: text,
  description: text,
  pubtime: z.number().finite().optional(),
});
const episode = z.object({
  id: identifier,
  title: z.string().max(500),
  long_title: text,
});

/** Public catalogue only. Never uses the browser's login session or playback APIs. */
export async function bilibiliRecognition(
  input: RecognitionInput,
  candidate: string | undefined,
  parser: FilenameParser,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<RecognitionResponse> {
  const get = async (route: string, visitor?: string) => {
    const data = await metadataJSON(
      endpoint + route,
      {
        signal,
        credentials: "omit",
        headers: {
          "User-Agent": "Mozilla/5.0 Tamki/0.1.0",
          Referer: "https://www.bilibili.com/",
          ...(visitor ? { Cookie: `buvid3=${visitor}` } : {}),
        },
      },
      (async (url, init) => {
        const response = await request(url, init);
        if (response.status === 412) {
          await response.body?.cancel();
          throw new ProviderError("sourceRateLimited");
        }
        return response;
      }) as typeof fetch,
    );
    if (data?.code !== 0)
      throw new ProviderError(
        [-352, -412, -509].includes(data?.code)
          ? "sourceRateLimited"
          : "recognitionFailed",
      );
    return data;
  };
  // A supplied official page is an exact locator, not an arbitrary fetch target.
  let seasonId: number | undefined,
    episodeId: number | undefined,
    mediaId: number | undefined;
  if (candidate) {
    if (!/^bilibili:season:[1-9]\d*$/.test(candidate))
      throw new ProviderError("invalidInput");
    seasonId = identifier.parse(Number(candidate.split(":")[2]));
  } else {
    try {
      const url = new URL(input.title);
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.port &&
        ["www.bilibili.com", "m.bilibili.com", "bilibili.com"].includes(
          url.hostname,
        )
      ) {
        const play = /^\/bangumi\/play\/(ss|ep)([1-9]\d*)\/?$/.exec(
          url.pathname,
        );
        const media = /^\/bangumi\/media\/md([1-9]\d*)\/?$/.exec(url.pathname);
        if (play?.[1] === "ss") seasonId = identifier.parse(Number(play[2]));
        if (play?.[1] === "ep") episodeId = identifier.parse(Number(play[2]));
        if (media) mediaId = identifier.parse(Number(media[1]));
      }
    } catch {
      /* An ordinary search title is not a URL. */
    }
  }
  if (mediaId) {
    const data = await get(`/pgc/review/user?media_id=${mediaId}`);
    seasonId = identifier.parse(data?.result?.media?.season_id);
  }
  if (!seasonId && !episodeId) {
    // Search requires an anonymous visitor identifier, not account authentication.
    // It lives only for this search; it is never saved or taken from logged-in tabs.
    const guest = await get("/x/frontend/finger/spi");
    const visitor = z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .parse(guest?.data?.b_3);
    const results = await Promise.all(
      ["media_bangumi", "media_ft"].map(async (type) => {
        const data = await get(
          `/x/web-interface/search/type?search_type=${type}&page=1&page_size=20&keyword=${encodeURIComponent(input.title)}`,
          visitor,
        );
        return (
          z
            .object({ result: z.array(hit).max(100).optional() })
            .parse(data.data).result || []
        );
      }),
    );
    const unique = new Map(
      results.flat().map((item) => [item.season_id, item]),
    );
    return {
      kind: "candidates",
      candidates: [...unique.values()].map((item) => ({
        id: `bilibili:season:${item.season_id}`,
        title: plain(item.title).slice(0, 500) || String(item.season_id),
        aliases: [
          item.title,
          item.org_title,
          ...(item.alias || "").split(/[\n/]/),
        ]
          .map(plain)
          .filter(Boolean),
        description: plain(item.desc || item.description),
        date:
          item.pubtime && item.pubtime > 0
            ? new Date(item.pubtime * 1000).toISOString().slice(0, 10)
            : "",
      })),
    };
  }
  const payload = await get(
    `/pgc/view/web/season?${seasonId ? `season_id=${seasonId}` : `ep_id=${episodeId}`}`,
  );
  const work = z
    .object({
      season_id: identifier,
      title: z.string().min(1).max(500),
      evaluate: text,
      cover: text,
      styles: z.array(z.string().max(100)).max(100).optional(),
      episodes: z.array(episode).max(10000),
    })
    .parse(payload.result);
  if (seasonId && work.season_id !== seasonId)
    throw new ProviderError("recognitionInvalid");
  if (episodeId && !work.episodes.some((e) => e.id === episodeId))
    throw new ProviderError("recognitionInvalid");
  const numbered = work.episodes.flatMap((e) => {
    const number = /^(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:话|話|集)?$/.exec(
      plain(e.title),
    )?.[1];
    return number
      ? [{ number, title: plain(e.long_title) || null, description: null }]
      : [];
  });
  const files =
    work.episodes.length === 1 && input.files.length === 1
      ? [
          {
            id: input.files[0].id,
            number: numbered[0]?.number || null,
            title: plain(work.episodes[0].long_title) || null,
            description: null,
          },
        ]
      : matchEpisodes(input, numbered, parser);
  const page = `https://www.bilibili.com/bangumi/play/ss${work.season_id}`;
  return {
    kind: "result",
    result: {
      work:
        input.scope === "file"
          ? null
          : {
              title: plain(work.title),
              description: plain(work.evaluate) || null,
              tags: work.styles?.map(plain).filter(Boolean) || null,
              cover: poster(work.cover),
              coverPage: page,
            },
      files,
    },
    citations: [{ title: "Bilibili", url: page }],
  };
}
