import {
  progress,
  type Collection,
  type LibraryState,
  type Series,
  type Work,
} from "./model";

export function collectionWorkIds(
  collection: Collection,
  state: LibraryState,
): string[] {
  return [
    ...new Set([
      ...collection.workIds,
      ...(collection.seriesIds || []).flatMap(
        (id) => state.series?.find((s) => s.id === id)?.workIds || [],
      ),
    ]),
  ];
}
export function seriesWorks(series: Series, state: LibraryState): Work[] {
  return series.workIds.flatMap((id) => {
    const work = state.works.find((w) => w.id === id);
    return work ? [work] : [];
  });
}
export function seriesTarget(
  series: Series,
  state: LibraryState,
): Work | undefined {
  const works = seriesWorks(series, state);
  return (
    works.find((w) => progress(w) > 0 && progress(w) < 0.999) ||
    works.find((w) => progress(w) < 0.999) ||
    works[0]
  );
}
/** Projection only: never persist a series as a work or merge its episodes. */
export function libraryEntries(
  state: LibraryState,
  collection?: Collection,
): Work[] {
  const allowed = collection
    ? new Set(collectionWorkIds(collection, state))
    : undefined;
  const works = state.works.filter((w) => !allowed || allowed.has(w.id));
  const represented = new Set<string>();
  const entries: Work[] = [];
  for (const series of state.series || []) {
    const members = seriesWorks(series, state);
    if (
      !members.length ||
      (allowed && !members.every((w) => allowed.has(w.id)))
    )
      continue;
    members.forEach((w) => represented.add(w.id));
    entries.push({
      ...members[0],
      id: series.id,
      title: series.name,
      cover: members.find((w) => w.cover)?.cover,
      recognition: undefined,
      episodes: members.flatMap((w) => w.episodes),
      tags: [...new Set(members.flatMap((w) => w.tags))],
      order: Math.min(...members.map((w) => w.order)),
      createdAt: Math.max(...members.map((w) => w.createdAt)),
    });
  }
  return [...works.filter((w) => !represented.has(w.id)), ...entries];
}
export function entryProgress(work: Work, state: LibraryState): number {
  const series = state.series?.find((s) => s.id === work.id);
  if (!series) return progress(work);
  const members = seriesWorks(series, state);
  // Equal work weights until all durations are known; never assume another work watched.
  const known = members.every((w) => w.episodes.every((e) => !!e.duration));
  const weights = members.map((w) =>
    known ? w.episodes.reduce((n, e) => n + e.duration!, 0) : 1,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  return total
    ? members.reduce((n, w, i) => n + progress(w) * weights[i], 0) / total
    : 0;
}
