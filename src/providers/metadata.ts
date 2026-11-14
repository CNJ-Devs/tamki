import { z } from "zod";
import { metadataJSON } from "./metadata-http";
import { parseFilename, type FilenameParser } from "../library/filename";
import type {
  RecognitionInput,
  RecognitionResponse,
  RecognitionResult,
} from "../shared/recognition";
import { ProviderError } from "./provider";
const text = z.string().max(30000).nullish();
const subject = z.object({
  id: z.number().int().positive(),
  name: text,
  name_cn: text,
  summary: text,
  date: text,
  tags: z.array(z.object({ name: z.string().max(100) })).optional(),
});
const ep = z.object({
  id: z.number().int().positive(),
  sort: z.number(),
  type: z.number(),
  name: text,
  name_cn: text,
  desc: text,
});
type RemoteEpisode = {
  number: string;
  title: string | null;
  description: string | null;
  season?: number;
};
const clean = (value: string | null | undefined) => value?.trim() || null;
export function matchEpisodes(
  input: RecognitionInput,
  episodes: RemoteEpisode[],
  parser: FilenameParser,
): RecognitionResult["files"] {
  return input.files.flatMap((file) => {
    const parsed = parseFilename(file.filename, parser);
    if (parsed.number === null) return [];
    const matches = episodes.filter(
      (e) =>
        Number(e.number) === Number(parsed.number) &&
        (e.season == null ||
          parsed.season == null ||
          e.season === parsed.season),
    );
    if (matches.length !== 1) return [];
    const match = matches[0];
    return [
      {
        id: file.id,
        number: match.number,
        title: match.title,
        description: match.description,
      },
    ];
  });
}
export async function builtinRecognition(
  source: "bangumi" | "tmdb",
  input: RecognitionInput,
  candidate: string | undefined,
  parser: FilenameParser,
  key: string,
  language: "en" | "zh",
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<RecognitionResponse> {
  const get = (url: string, body?: unknown, headers?: Record<string, string>) =>
    metadataJSON(
      url,
      {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers,
        signal,
      },
      request,
    );
  if (source === "bangumi") {
    if (!candidate) {
      const response = z
        .object({ data: z.array(subject).max(20) })
        .parse(
          await get("https://api.bgm.tv/v0/search/subjects?limit=20", {
            keyword: input.title,
            sort: "match",
            filter: { type: [2, 6] },
          }),
        );
      return {
        kind: "candidates",
        candidates: response.data.map((s) => ({
          id: `bangumi:${s.id}`,
          title: s.name_cn || s.name || String(s.id),
          description: s.summary || "",
          date: s.date || "",
        })),
      };
    }
    if (!/^bangumi:\d+$/.test(candidate))
      throw new ProviderError("invalidInput");
    const id = candidate.split(":")[1];
    const work = subject.parse(
      await get(`https://api.bgm.tv/v0/subjects/${id}`),
    );
    const episodes: z.infer<typeof ep>[] = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const page = z
        .object({
          data: z.array(ep).max(200),
          total: z.number().int().nonnegative(),
        })
        .parse(
          await get(
            `https://api.bgm.tv/v0/episodes?subject_id=${id}&limit=200&offset=${offset}&type=0`,
          ),
        );
      episodes.push(...page.data);
      if (episodes.length >= page.total) break;
      if (!page.data.length || offset === 9800)
        throw new ProviderError("recognitionTooLarge");
    }
    const mapped = matchEpisodes(
      input,
      episodes.map((e) => ({
        number: String(e.sort),
        title: clean(e.name_cn) || clean(e.name),
        description: clean(e.desc),
      })),
      parser,
    );
    // The list endpoint can omit synopses. Fetch details only for files confidently matched.
    const ids = [
      ...new Set(
        mapped
          .filter((f) => !f.description)
          .map((f) => episodes.find((e) => String(e.sort) === f.number)!.id),
      ),
    ];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) {
          const episodeId = ids[cursor++];
          const details = ep.parse(
            await get(`https://api.bgm.tv/v0/episodes/${episodeId}`),
          );
          for (const file of mapped)
            if (file.number === String(details.sort))
              file.description = clean(details.desc);
        }
      }),
    );
    return {
      kind: "result",
      result: {
        work:
          input.scope === "file"
            ? null
            : {
                title: clean(work.name_cn) || clean(work.name),
                description: clean(work.summary),
                tags: work.tags?.map((t) => t.name).slice(0, 12) || null,
              },
        files: mapped,
      },
      citations: [{ title: "Bangumi", url: `https://bgm.tv/subject/${id}` }],
    };
  }
  if (!key) throw new ProviderError("tmdbKeyRequired");
  const tmdb = (endpoint: string) =>
    get(
      `https://api.themoviedb.org/3${endpoint}${endpoint.includes("?") ? "&" : "?"}language=${language === "zh" ? "zh-CN" : "en-US"}`,
      undefined,
      { Authorization: `Bearer ${key}` },
    );
  if (!candidate) {
    const data = z
      .object({
        results: z
          .array(
            z.object({
              id: z.number().int(),
              media_type: z.string(),
              title: text,
              name: text,
              overview: text,
              release_date: text,
              first_air_date: text,
            }),
          )
          .max(100),
      })
      .parse(
        await tmdb(
          `/search/multi?query=${encodeURIComponent(input.title)}&include_adult=false`,
        ),
      );
    return {
      kind: "candidates",
      candidates: data.results
        .filter((s) => ["movie", "tv"].includes(s.media_type))
        .map((s) => ({
          id: `tmdb:${s.media_type}:${s.id}`,
          title: s.title || s.name || String(s.id),
          description: s.overview || "",
          date: s.release_date || s.first_air_date || "",
        })),
    };
  }
  if (!/^tmdb:(movie|tv):\d+(?::\d+)?$/.test(candidate))
    throw new ProviderError("invalidInput");
  const [, type, id, season] = candidate.split(":");
  const work = z
    .object({
      title: text,
      name: text,
      overview: text,
      genres: z.array(z.object({ name: z.string().max(100) })).optional(),
      seasons: z
        .array(
          z.object({
            season_number: z.number().int(),
            name: text,
            overview: text,
            air_date: text,
          }),
        )
        .optional(),
    })
    .parse(await tmdb(`/${type}/${id}`));
  if (type === "tv" && season === undefined) {
    return {
      kind: "candidates",
      candidates: (work.seasons || []).map((s) => ({
        id: `tmdb:tv:${id}:${s.season_number}`,
        title: [work.name, s.name].filter(Boolean).join(" · "),
        description: s.overview || "",
        date: s.air_date || "",
      })),
    };
  }
  let files: RecognitionResult["files"] = [],
    title = work.title || work.name || null,
    description = clean(work.overview);
  if (type === "tv") {
    const data = z
      .object({
        name: text,
        overview: text,
        episodes: z
          .array(
            z.object({
              episode_number: z.number(),
              season_number: z.number(),
              name: text,
              overview: text,
            }),
          )
          .max(10000),
      })
      .parse(await tmdb(`/tv/${id}/season/${season}`));
    title = [title, data.name].filter(Boolean).join(" · ");
    description = clean(data.overview) || description;
    files = matchEpisodes(
      input,
      data.episodes.map((e) => ({
        number: String(e.episode_number),
        season: e.season_number,
        title: clean(e.name),
        description: clean(e.overview),
      })),
      parser,
    );
  } else if (input.files.length === 1)
    files = [{ id: input.files[0].id, number: null, title, description }];
  return {
    kind: "result",
    result: {
      work:
        input.scope === "file"
          ? null
          : {
              title,
              description,
              tags: work.genres?.map((g) => g.name) || null,
            },
      files,
    },
    citations: [
      { title: "TMDB", url: `https://www.themoviedb.org/${type}/${id}` },
    ],
  };
}
