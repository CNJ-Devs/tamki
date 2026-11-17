import type { Candidate } from "../shared/recognition";
import type { Work } from "../shared/model";
import { parseFilename, type FilenameParser } from "./filename";

const numerals: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};
export function titleIdentity(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase();
  let season: number | undefined;
  const title = normalized
    .replace(
      /(?:第\s*([\d一二三四五六七八九十]+)\s*季|\bseason\s*(\d+)\b|\bs(\d{1,2})\b|\b(\d+)(?:st|nd|rd|th)\s+season\b)/g,
      (_, cn, en, short, ordinal) => {
        const number = cn || en || short || ordinal;
        season = numerals[number] || Number(number);
        return "";
      },
    )
    .replace(/[\p{P}\p{Z}\s]/gu, "");
  return { title, season };
}
/** Never choose a search hit merely because it ranks first. */
export function automaticCandidate(
  work: Work,
  candidates: Candidate[],
  parser: FilenameParser,
): string | undefined {
  const wanted = titleIdentity(work.title);
  const seasons = new Set(
    work.episodes
      .map((e) => parseFilename(e.fileName, parser).season)
      .filter((n): n is number => n !== null),
  );
  if (
    seasons.size > 1 ||
    (wanted.season && seasons.size && !seasons.has(wanted.season))
  )
    return;
  const season = wanted.season ?? [...seasons][0];
  if (candidates.length && candidates.every((c) => c.season !== undefined)) {
    const matched = candidates.filter((c) =>
      season === undefined ? c.season! > 0 : c.season === season,
    );
    return matched.length === 1 ? matched[0].id : undefined;
  }
  const matched = candidates.filter((c) =>
    [c.title, ...(c.aliases || [])].some((name) => {
      const actual = titleIdentity(name);
      return (
        actual.title === wanted.title &&
        ((/^tmdb:tv:\d+$/.test(c.id) && actual.season === undefined) ||
          (actual.season ?? 1) === (season ?? 1))
      );
    }),
  );
  return matched.length === 1 ? matched[0].id : undefined;
}
