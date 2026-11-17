import type {
  CaptureGroup,
  CaptureResource,
  DownloadChoice,
} from "../shared/capture";
import { ProviderError } from "../providers/provider";

export function downloadChoices(
  resources: CaptureResource[],
  groups?: CaptureGroup[],
): DownloadChoice[] {
  const leaf = (r: CaptureResource): DownloadChoice => ({
    id: r.id,
    title: r.title,
    resourceIds: [r.id],
  });
  const group = (g: CaptureGroup): DownloadChoice => {
    const nested = new Set(
      g.sections?.flatMap((s) => s.resources.map((r) => r.id)),
    );
    return {
      id: g.id,
      title: g.title,
      resourceIds: g.resources.map((r) => r.id),
      children: [
        ...g.resources.filter((r) => !nested.has(r.id)).map(leaf),
        ...(g.sections || []).map(group),
      ],
    };
  };
  return groups ? groups.map(group) : resources.map(leaf);
}

/** Resolve renderer IDs against the frozen main-process draft, preserving order. */
export function selectDownload(
  resources: CaptureResource[],
  groups: CaptureGroup[] | undefined,
  ids?: string[],
) {
  const selected = new Set(ids ?? resources.map((r) => r.id));
  const available = new Set(resources.map((r) => r.id));
  if (
    !selected.size ||
    (ids && selected.size !== ids.length) ||
    [...selected].some((id) => !available.has(id))
  )
    throw new ProviderError("captureChanged");
  const positions = new Map(resources.map((r, i) => [r.id, i]));
  const assigned = new Set<string>();
  if (groups)
    for (const group of groups)
      group.resources.forEach((r, i) => {
        if (!assigned.has(r.id)) positions.set(r.id, i);
        assigned.add(r.id);
      });
  const filter = (g: CaptureGroup): CaptureGroup => ({
    ...g,
    resources: g.resources.filter((r) => selected.has(r.id)),
    sections: g.sections?.map(filter).filter((s) => s.resources.length),
  });
  return {
    resources: resources.filter((r) => selected.has(r.id)),
    groups: groups?.map(filter).filter((g) => g.resources.length),
    positions,
  };
}
