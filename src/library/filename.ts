import { filenameParse } from "@ctrl/video-filename-parser";
import { parse } from "anitomy";
export type FilenameParser = "release" | "anitomy";
export function parseFilename(filename: string, parser: FilenameParser) {
  const bare = filename.replace(/\.[^.]+$/, "");
  const result: {
    title: string | null;
    number: string | null;
    episodeTitle: string | null;
    season: number | null;
  } = { title: null, number: null, episodeTitle: null, season: null };
  try {
    if (parser === "anitomy") {
      const info = parse(filename);
      if (!info) return result;
      result.title = info.title || null;
      result.number =
        info.episode?.number == null ? null : String(info.episode.number);
      result.episodeTitle = info.episode?.title || null;
      result.season = info.season == null ? null : Number(info.season);
    } else {
      const info = filenameParse(bare, true);
      result.title = info.title || null;
      if ("episodeNumbers" in info && info.episodeNumbers?.length === 1)
        result.number = String(info.episodeNumbers[0]);
      if ("seasons" in info && info.seasons?.length === 1)
        result.season = info.seasons[0];
      if ("remainder" in info && typeof info.remainder === "string")
        result.episodeTitle = info.remainder || null;
    }
    // Plain numbered files and Chinese episode labels are unambiguous; never infer by order.
    const number =
      bare.match(/^\d+(?:\.\d+)?$/)?.[0] ||
      bare.match(/第\s*(\d+(?:\.\d+)?)\s*[集话話期]/)?.[1];
    if (number) result.number = String(Number(number));
  } catch {}
  if (result.season !== null && !Number.isFinite(result.season))
    result.season = null;
  return result;
}
