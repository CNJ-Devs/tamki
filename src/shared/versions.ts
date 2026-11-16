import type { Episode, EpisodeVersion } from "./model";

export const mediaSelection = (episode: Episode) => ({
  id: episode.id,
  ...(episode.activeVersionId ? { versionId: episode.activeVersionId } : {}),
  ...(episode.activeFileId ? { fileId: episode.activeFileId } : {}),
});

export function episodeVersions(episode: Episode): EpisodeVersion[] {
  return (
    episode.versions || [
      {
        id: episode.id,
        label: "",
        releaseKey: "",
        files: [episode],
      },
    ]
  );
}
export const episodeFiles = (episode: Episode) =>
  episodeVersions(episode).flatMap((v) => v.files);
