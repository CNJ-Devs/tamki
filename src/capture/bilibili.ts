import { videoQualityLabel } from "../shared/capture";
import { randomUUID } from "node:crypto";
import {
  captureResourceSchema,
  type CaptureResource,
  type CaptureResult,
  type CaptureGroup,
  type CaptureSeries,
  type CaptureMetadata,
} from "../shared/capture";
import { ProviderError } from "../providers/provider";
import { traced, logEvent } from "../diagnostics";

const endpoint = "https://api.bilibili.com";
const maxItems = 10000;
const limit = 12 * 1024 * 1024;
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown) =>
  typeof v === "string" ? v.trim().slice(0, 500) : "";
const description = (v: unknown) =>
  typeof v === "string" ? v.trim().slice(0, 20000) : "";
// Official CDN artwork only; protocol-relative/legacy HTTP API values are
// normalized here, before reaching the application's public HTTPS image cache.
function coverURL(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !["hdslb.com", "biliimg.com"].some(
        (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
      )
    )
      return;
    url.protocol = "https:";
    return url.href.length <= 2048 ? url.href : undefined;
  } catch {
    return;
  }
}
function workMetadata(
  data: any,
  kind: "season" | "video" | "collection",
): CaptureMetadata {
  const id =
    kind === "season" ? data.season_id : kind === "video" ? data.aid : data.id;
  return {
    id: `bilibili:${kind}:${id}`,
    url:
      kind === "season"
        ? `https://www.bilibili.com/bangumi/play/ss${id}`
        : kind === "video"
          ? `https://www.bilibili.com/video/av${id}`
          : `https://space.bilibili.com/${data.mid}/lists/${id}`,
    title: text(data.title || data.name),
    description: description(data.evaluate || data.desc || data.description),
    tags: (Array.isArray(data.styles) ? data.styles : [])
      .filter((t: unknown) => typeof t === "string")
      .slice(0, 50)
      .map((t: string) => t.slice(0, 100)),
    ...(coverURL(data.cover || data.pic)
      ? { cover: coverURL(data.cover || data.pic) }
      : {}),
  };
}
export type BiliPage =
  | { kind: "video"; bvid?: string; aid?: number; part: number }
  | { kind: "season"; episodeId?: number; seasonId?: number; mediaId?: number }
  | { kind: "collection"; owner: number; collection: number; series: boolean };
export function biliPage(value: string): BiliPage | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "www.bilibili.com",
      "m.bilibili.com",
      "bilibili.com",
      "space.bilibili.com",
      "player.bilibili.com",
    ].includes(url.hostname)
  )
    return;
  if (url.hostname === "player.bilibili.com") {
    if (url.pathname !== "/player.html") return;
    const bvid = url.searchParams.get("bvid");
    const aid = Number(url.searchParams.get("aid"));
    if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid || "") && !positive(aid)) return;
    return {
      kind: "video",
      ...(/^BV[a-zA-Z0-9]{10}$/.test(bvid || "") ? { bvid: bvid! } : { aid }),
      part: Math.max(
        1,
        Math.min(
          maxItems,
          Math.floor(Number(url.searchParams.get("page"))) || 1,
        ),
      ),
    };
  }
  const video = url.pathname.match(
    /^\/video\/(BV[a-zA-Z0-9]{10}|av\d+)(?:\/|$)/,
  );
  if (
    video &&
    (video[1].startsWith("BV") || positive(Number(video[1].slice(2))))
  )
    return {
      kind: "video",
      ...(video[1].startsWith("BV")
        ? { bvid: video[1] }
        : { aid: Number(video[1].slice(2)) }),
      part: Math.max(
        1,
        Math.min(maxItems, Math.floor(Number(url.searchParams.get("p"))) || 1),
      ),
    };
  const season = url.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)(?:\/|$)/);
  if (season && positive(Number(season[2])))
    return {
      kind: "season",
      ...(season[1] === "ep"
        ? { episodeId: Number(season[2]) }
        : { seasonId: Number(season[2]) }),
    };
  const media = url.pathname.match(/^\/bangumi\/media\/md(\d+)(?:\/|$)/);
  if (media && positive(Number(media[1])))
    return { kind: "season", mediaId: Number(media[1]) };
  const currentList =
    url.hostname === "space.bilibili.com"
      ? url.pathname.match(/^\/(\d+)\/lists\/(\d+)(?:\/|$)/)
      : null;
  if (
    currentList &&
    positive(Number(currentList[1])) &&
    positive(Number(currentList[2]))
  )
    return {
      kind: "collection",
      owner: Number(currentList[1]),
      collection: Number(currentList[2]),
      series:
        url.searchParams.get("type") === "series" ||
        url.searchParams.get("business") === "space_series",
    };
  const list =
    url.pathname.match(/^\/lists\/(\d+)(?:\/|$)/) ||
    url.pathname.match(/^\/(\d+)\/lists(?:\/|$)/) ||
    url.pathname.match(
      /^\/(\d+)\/channel\/(?:collectiondetail|seriesdetail)(?:\/|$)/,
    );
  if (
    list &&
    positive(Number(list[1])) &&
    /^\d+$/.test(url.searchParams.get("sid") || "") &&
    positive(Number(url.searchParams.get("sid")))
  )
    return {
      kind: "collection",
      owner: Number(list[1]),
      collection: Number(url.searchParams.get("sid")),
      series:
        url.searchParams.get("type") === "series" ||
        url.pathname.includes("/seriesdetail"),
    };
  const oldList = url.pathname.match(
    /^\/medialist\/(?:play|detail)\/(\d+)(?:\/|$)/,
  );
  if (
    oldList &&
    positive(Number(oldList[1])) &&
    /^\d+$/.test(url.searchParams.get("business_id") || "") &&
    positive(Number(url.searchParams.get("business_id"))) &&
    ["space_collection", "space_series"].includes(
      url.searchParams.get("business") || "",
    )
  )
    return {
      kind: "collection",
      owner: Number(oldList[1]),
      collection: Number(url.searchParams.get("business_id")),
      series: url.searchParams.get("business") === "space_series",
    };
}
export function mediaURL(value: unknown): string {
  if (typeof value !== "string") throw new ProviderError("captureInvalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("captureInvalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "bilivideo.com",
      "bilivideo.cn",
      "bilivideo.net",
      "hdslb.com",
      "acgvideo.com",
    ].some((h) => url.hostname === h || url.hostname.endsWith("." + h))
  )
    throw new ProviderError("captureInvalid");
  return url.href;
}
function streamURL(stream: any): string {
  const candidates = [
    stream.baseUrl || stream.base_url || stream.url,
    ...(Array.isArray(stream.backupUrl || stream.backup_url)
      ? stream.backupUrl || stream.backup_url
      : []),
  ];
  for (const candidate of candidates) {
    try {
      return mediaURL(candidate);
    } catch {
      let origin = "invalid";
      try {
        origin = new URL(candidate).origin;
      } catch {}
      logEvent("capture.media-address-rejected", {
        origin,
        reason: "unapproved-address",
      });
    }
  }
  throw new ProviderError("captureInvalid");
}
export interface MediaStream {
  dash?: {
    mime: string;
    codecs: string;
    bandwidth: number;
    indexRange: string;
    initialization: string;
  };
  url: string;
  key: string;
  bytes?: number;
}
export interface ResolvedMedia {
  kind: "dash" | "segments";
  streams: MediaStream[];
  duration: number;
  quality?: number;
  qualityLabel?: string;
  qualities?: { id: number; label: string }[];
}
export function parsePlayback(
  data: any,
  requestedQuality?: number,
): ResolvedMedia {
  if (
    data?.is_drm ||
    data?.drm_tech_type ||
    data?.is_preview ||
    data?.is_ugc_pay_preview ||
    data?.play_video_type === "preview" ||
    data?.play_check?.play_detail === "PLAY_PREVIEW"
  ) {
    logEvent("capture.playback-restricted", {
      reason: data?.is_drm || data?.drm_tech_type ? "drm" : "preview",
    });
    throw new ProviderError("captureRestricted");
  }
  const duration = Number(data?.timelength || 0) / 1000;
  if (!Number.isFinite(duration) || duration < 0)
    throw new ProviderError("captureInvalid");
  const descriptions = new Map<number, string>(
    (data.accept_quality || []).map((q: number, i: number) => [
      q,
      String(data.accept_description?.[i] || q),
    ]),
  );
  const label = (q: number) => descriptions.get(q) || videoQualityLabel(q);
  if (data?.dash) {
    const videos = Array.isArray(data.dash.video) ? data.dash.video : [];
    const audios = Array.isArray(data.dash.audio) ? data.dash.audio : [];
    const eligible = videos.filter(
      (v: any) =>
        positive(v.id) &&
        !v.drm &&
        !v.drm_tech_type &&
        (!data.quality || v.id <= data.quality),
    );
    // Prefer H.264 for the application's Chromium player, keeping available quality first.
    eligible.sort(
      (a: any, b: any) =>
        b.id - a.id ||
        Number(b.codecid === 7) - Number(a.codecid === 7) ||
        (b.bandwidth || 0) - (a.bandwidth || 0),
    );
    const qualities = [...new Set<number>(eligible.map((v: any) => v.id))].map(
      (id) => ({ id, label: label(id) }),
    );
    const video = requestedQuality
      ? eligible.find((v: any) => v.id === requestedQuality)
      : eligible[0];
    const audio = audios
      .filter((v: any) => !v.drm && !v.drm_tech_type)
      .sort((a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (!video) throw new ProviderError("captureUnavailable");
    return {
      kind: "dash",
      quality: video.id,
      qualityLabel: label(video.id),
      qualities,
      duration,
      streams: [video, ...(audio ? [audio] : [])].map((v: any) => ({
        url: streamURL(v),
        key: [v.id, v.codecid, v.codecs, v.bandwidth].join(":"),
        ...(() => {
          const base = v.SegmentBase || v.segment_base;
          const indexRange = base?.indexRange || base?.index_range;
          const initialization = base?.Initialization || base?.initialization;
          const mime = v.mimeType || v.mime_type;
          return /^(video|audio)\/mp4$/.test(mime || "") &&
            typeof v.codecs === "string" &&
            /^[a-zA-Z0-9., -]+$/.test(v.codecs) &&
            /^\d+-\d+$/.test(indexRange || "") &&
            /^\d+-\d+$/.test(initialization || "") &&
            positive(v.bandwidth)
            ? {
                dash: {
                  mime,
                  codecs: v.codecs,
                  bandwidth: v.bandwidth,
                  indexRange,
                  initialization,
                },
              }
            : {};
        })(),
      })),
    };
  }
  if (
    Array.isArray(data?.durl) &&
    data.durl.length &&
    data.durl.length <= 1000
  ) {
    if (requestedQuality && data.quality !== requestedQuality)
      throw new ProviderError("captureRestricted");
    return {
      kind: "segments",
      quality: data.quality,
      qualityLabel: data.quality ? label(data.quality) : undefined,
      qualities: data.quality
        ? [{ id: data.quality, label: label(data.quality) }]
        : [],
      duration,
      streams: data.durl.map((v: any, i: number) => ({
        url: streamURL(v),
        key: `segment:${i}:${v.size}:${v.length}`,
        bytes: positive(v.size) ? v.size : undefined,
      })),
    };
  }
  throw new ProviderError("captureUnavailable");
}
export class Bilibili {
  readonly id = "bilibili" as const;
  supports(url: string) {
    return !!biliPage(url);
  }
  constructor(private request: typeof fetch) {}
  private async api(
    path: string,
    params: Record<string, string | number>,
    signal: AbortSignal,
  ): Promise<any> {
    const url = new URL(path, endpoint);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, String(value));
    return traced(
      "capture.api",
      { provider: "bilibili", operation: path },
      async () => {
        const response = await this.request(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          redirect: "error",
          credentials: "include",
          headers: {
            Referer: "https://www.bilibili.com/",
            Accept: "application/json",
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderError(
            response.status === 412 || response.status === 429
              ? "captureRateLimited"
              : "captureNetwork",
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError("captureNetwork");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new ProviderError("captureTooLarge");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        let result: any;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ProviderError("captureInvalid");
        }
        if (result.code !== 0)
          throw new ProviderError(
            [-101, -10403, -403, 10015002, 10015003].includes(result.code)
              ? "captureRestricted"
              : [-412, -799, 429].includes(result.code)
                ? "captureRateLimited"
                : "captureUnavailable",
          );
        const data = result.data ?? result.result;
        if (!data || typeof data !== "object")
          throw new ProviderError("captureInvalid");
        return data;
      },
    );
  }
  private resource(
    video: any,
    page: any,
    title?: string,
    episodeId?: number,
  ): CaptureResource {
    const parsed = captureResourceSchema.safeParse({
      provider: "bilibili",
      id: `bili:${video.aid}:${page.cid}`,
      aid: video.aid,
      bvid: video.bvid,
      cid: page.cid,
      title: text(title) || text(page.part) || text(video.title),
      duration: Number.isFinite(page.duration)
        ? Math.max(0, page.duration)
        : null,
      ...(episodeId ? { episodeId } : {}),
      metadata: {
        title: text(
          episodeId
            ? video.long_title || video.title
            : page.part || video.title,
        ),
        number: text(episodeId ? video.title : String(page.page || "")).slice(
          0,
          100,
        ),
        description: description(
          episodeId ? video.desc : video.pages?.length === 1 ? video.desc : "",
        ),
        ...(coverURL(episodeId ? video.cover : page.first_frame)
          ? { cover: coverURL(episodeId ? video.cover : page.first_frame) }
          : {}),
      },
      ...(!episodeId ? { workMetadata: workMetadata(video, "video") } : {}),
    });
    if (!parsed.success) throw new ProviderError("captureInvalid");
    return parsed.data;
  }
  private parts(video: any): CaptureResource[] {
    if (
      !Array.isArray(video.pages) ||
      !video.pages.length ||
      video.pages.length > maxItems
    )
      throw new ProviderError("captureInvalid");
    if (
      (positive(video.videos) && video.videos !== video.pages.length) ||
      new Set(video.pages.map((p: any) => p.cid)).size !== video.pages.length
    )
      throw new ProviderError("captureIncomplete");
    return video.pages.map((p: any) =>
      this.resource(
        video,
        p,
        video.pages.length === 1
          ? video.title
          : `${text(video.title)} · ${text(p.part) || p.page}`,
      ),
    );
  }
  private async videoParts(video: any, signal: AbortSignal) {
    if (video.rights?.is_stein_gate === 1)
      throw new ProviderError("captureInteractive");
    if (
      !Array.isArray(video.pages) ||
      !video.pages.length ||
      (positive(video.videos) && video.videos !== video.pages.length)
    ) {
      const pages = await this.api(
        "/x/player/pagelist",
        { aid: video.aid },
        signal,
      );
      return this.parts({ ...video, pages });
    }
    return this.parts(video);
  }
  private seasonGroup(data: any, label = ""): CaptureGroup {
    if (
      !positive(data.season_id) ||
      (!Array.isArray(data.episodes) && !Array.isArray(data.section))
    )
      throw new ProviderError("captureInvalid");
    const title = text(data.title);
    const group: CaptureGroup = {
      id: `season:${data.season_id}`,
      title: label && !title.endsWith(label) ? `${title} · ${label}` : title,
      resources: [],
      metadata: workMetadata(data, "season"),
    };
    const ids = new Map<string, number>();
    const episodes = new Map<number, string>();
    let count = 0;
    const read = (items: unknown, target: CaptureGroup) => {
      if (!Array.isArray(items)) {
        group.incomplete = target.incomplete = true;
        return;
      }
      for (const episode of items) {
        if (++count > maxItems) throw new ProviderError("captureTooLarge");
        try {
          const episodeId = episode?.id ?? episode?.ep_id;
          if (!positive(episodeId)) throw new ProviderError("captureInvalid");
          const resource = this.resource(
            episode,
            {
              cid: episode.cid,
              duration:
                typeof episode.duration === "number"
                  ? episode.duration / 1000
                  : undefined,
            },
            [text(episode.title), text(episode.long_title)]
              .filter(Boolean)
              .join(" · "),
            episodeId,
          );
          // Sections sometimes repeat entries from the main episode list. Use
          // platform identities, never names, to deduplicate across sections.
          if (ids.has(resource.id) || episodes.has(episodeId)) {
            if (
              ids.get(resource.id) !== episodeId ||
              episodes.get(episodeId) !== resource.id
            )
              group.incomplete = target.incomplete = true;
            continue;
          }
          ids.set(resource.id, episodeId);
          episodes.set(episodeId, resource.id);
          target.resources.push(resource);
        } catch {
          group.incomplete = target.incomplete = true;
        }
      }
    };
    read(data.episodes ?? [], group);
    if (data.section !== undefined && !Array.isArray(data.section))
      group.incomplete = true;
    const sections = Array.isArray(data.section) ? data.section : [];
    if (sections.length > 100) throw new ProviderError("captureTooLarge");
    const sectionIds = new Set<string>();
    for (const section of sections) {
      if (!positive(section?.id) || sectionIds.has(String(section.id))) {
        group.incomplete = true;
        continue;
      }
      sectionIds.add(String(section.id));
      const child: CaptureGroup = {
        id: `${group.id}:section:${section.id}`,
        title: text(section.title) || group.title,
        resources: [],
        metadata: group.metadata,
      };
      read(section.episodes, child);
      if (child.resources.length) {
        (group.sections ||= []).push(child);
        group.resources.push(...child.resources);
      }
    }
    return group;
  }
  private async collection(
    owner: number,
    collection: number,
    series: boolean,
    signal: AbortSignal,
  ): Promise<CaptureGroup> {
    const archives: any[] = [];
    let title = "";
    let metadata: CaptureMetadata | undefined;
    let total = Infinity;
    for (let page = 1; archives.length < total; page++) {
      if (page > 200) throw new ProviderError("captureTooLarge");
      const data = await this.api(
        series
          ? "/x/series/archives"
          : "/x/polymer/web-space/seasons_archives_list",
        series
          ? {
              mid: owner,
              series_id: collection,
              pn: page,
              ps: 100,
              only_normal: 1,
              sort: "asc",
            }
          : {
              mid: owner,
              season_id: collection,
              page_num: page,
              page_size: 100,
            },
        signal,
      );
      const list = data.archives;
      const reportedTotal = Number(
        data.page?.total ?? data.page?.total_count ?? data.total,
      );
      if (Number.isFinite(total) && reportedTotal !== total)
        throw new ProviderError("captureIncomplete");
      total = reportedTotal;
      if (
        !Array.isArray(list) ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        total > maxItems ||
        (!list.length && archives.length < total)
      )
        throw new ProviderError("captureIncomplete");
      title ||= text(data.meta?.name) || text(data.meta?.title);
      if (!metadata && data.meta)
        metadata = workMetadata(
          { ...data.meta, id: collection, mid: owner },
          "collection",
        );
      archives.push(...list);
      if (archives.length > maxItems)
        throw new ProviderError("captureTooLarge");
    }
    if (
      new Set(archives.map((a) => a.aid)).size !== archives.length ||
      archives.length !== total
    )
      throw new ProviderError("captureIncomplete");
    if (series && !title) {
      const meta = await this.api(
        "/x/series/series",
        { series_id: collection },
        signal,
      );
      title = text(meta.meta?.name);
    }
    const parts: CaptureResource[][] = new Array(archives.length);
    let cursor = 0,
      count = 0,
      failed = false;
    await Promise.all(
      Array.from({ length: Math.min(4, archives.length) }, async () => {
        for (;;) {
          signal.throwIfAborted();
          if (failed) return;
          const i = cursor++;
          if (i >= archives.length) return;
          const item = archives[i];
          try {
            if (!positive(item.aid)) throw new ProviderError("captureInvalid");
            parts[i] = await this.videoParts(
              await this.api(
                "/x/web-interface/view",
                { aid: item.aid },
                signal,
              ),
              signal,
            );
            count += parts[i].length;
            if (count > maxItems) throw new ProviderError("captureTooLarge");
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }),
    );
    const resources = parts.flat();
    if (resources.length > maxItems) throw new ProviderError("captureTooLarge");
    return {
      id: `${series ? "series" : "collection"}:${collection}`,
      title: title || text(archives[0]?.title),
      resources,
      metadata,
    };
  }
  async discover(
    pageURL: string,
    signal: AbortSignal,
  ): Promise<CaptureResult | undefined> {
    let page = biliPage(pageURL);
    if (!page) return;
    let current: CaptureResource | undefined;
    let collectionError: string | undefined;
    const groups: CaptureGroup[] = [];
    const series: CaptureSeries[] = [];
    let metadata: CaptureMetadata | undefined;
    let video: any;
    if (page.kind === "video") {
      video = await this.api(
        "/x/web-interface/view",
        page.bvid ? { bvid: page.bvid } : { aid: page.aid! },
        signal,
      );
      // The view API can identify a PGC episode even when the browser has a
      // normal BV/AV URL. Follow only a validated platform episode identity.
      if (video.redirect_url) {
        let redirect: BiliPage | undefined;
        try {
          redirect = biliPage(
            new URL(video.redirect_url, "https://www.bilibili.com").href,
          );
        } catch {}
        if (redirect?.kind === "season" && redirect.episodeId) page = redirect;
      }
    }
    if (page.kind === "video") {
      metadata = workMetadata(video, "video");
      const interactive = video.rights?.is_stein_gate === 1;
      const parts = interactive
        ? this.parts(video)
        : await this.videoParts(video, signal);
      current = parts[page.part - 1];
      if (!current) collectionError = "captureIncomplete";
      if (interactive) collectionError = "captureInteractive";
      if (parts.length > 1 && !interactive)
        groups.push({
          id: `parts:${video.aid}`,
          title: text(video.title),
          resources: parts,
          metadata,
        });
      if (positive(video.ugc_season?.id) && positive(video.owner?.mid)) {
        try {
          groups.push(
            await this.collection(
              video.owner.mid,
              video.ugc_season.id,
              false,
              signal,
            ),
          );
        } catch (error) {
          signal.throwIfAborted();
          // A failed collection never hides the independently verified current video.
          collectionError =
            error instanceof ProviderError ? error.code : "captureNetwork";
        }
      }
    } else if (page.kind === "collection") {
      groups.push(
        await this.collection(page.owner, page.collection, page.series, signal),
      );
      const query = new URL(pageURL).searchParams;
      const selected = groups[0].resources.filter(
        (r) =>
          query.get("bvid") === r.bvid ||
          (positive(Number(query.get("aid") || query.get("oid"))) &&
            Number(query.get("aid") || query.get("oid")) === r.aid),
      );
      if (selected.length) {
        const part = Number(query.get("p")) || 1;
        current = selected[part - 1];
      }
    } else {
      if (page.mediaId) {
        const media = await this.api(
          "/pgc/review/user",
          { media_id: page.mediaId },
          signal,
        );
        if (!positive(media.media?.season_id))
          throw new ProviderError("captureInvalid");
        page = { kind: "season", seasonId: media.media.season_id };
      }
      const season = await this.api(
        "/pgc/view/web/season",
        page.episodeId
          ? { ep_id: page.episodeId }
          : { season_id: page.seasonId! },
        signal,
      );
      if (
        !positive(season.season_id) ||
        (page.seasonId && season.season_id !== page.seasonId)
      )
        throw new ProviderError("captureInvalid");
      // Only follow the originating page's explicit season switcher, never
      // recursively expand recommendations or the related seasons' own links.
      const related: { season_id: number; season_title?: string }[] = [];
      const seen = new Set<number>([season.season_id]);
      if (Array.isArray(season.seasons)) {
        for (const item of season.seasons) {
          if (!positive(item?.season_id)) {
            collectionError = "captureIncomplete";
            continue;
          }
          if (seen.has(item.season_id)) continue;
          seen.add(item.season_id);
          if (related.length >= 49) {
            collectionError = "captureTooLarge";
            break;
          }
          related.push(item);
        }
      }
      const currentLabel = Array.isArray(season.seasons)
        ? text(
            season.seasons.find((s: any) => s?.season_id === season.season_id)
              ?.season_title,
          )
        : "";
      const main = this.seasonGroup(season, currentLabel);
      metadata = main.metadata;
      if (main.incomplete) collectionError = "captureIncomplete";
      const requestedEpisode = page.episodeId;
      current = requestedEpisode
        ? main.resources.find((r) => r.episodeId === requestedEpisode)
        : main.resources.find(
            (r) => r.episodeId === season.user_status?.progress?.last_ep_id,
          ) || main.resources[0];
      if (requestedEpisode && !current) collectionError = "captureIncomplete";
      groups.push(main);
      const additional: (CaptureGroup | undefined)[] = new Array(
        related.length,
      );
      let cursor = 0,
        count = main.resources.length;
      await Promise.all(
        Array.from({ length: Math.min(3, related.length) }, async () => {
          for (;;) {
            const index = cursor++;
            if (index >= related.length) return;
            signal.throwIfAborted();
            const item = related[index];
            try {
              const data = await this.api(
                "/pgc/view/web/season",
                { season_id: item.season_id },
                signal,
              );
              if (data.season_id !== item.season_id)
                throw new ProviderError("captureInvalid");
              const group = this.seasonGroup(data, text(item.season_title));
              if (group.incomplete) collectionError = "captureIncomplete";
              if (count + group.resources.length > maxItems)
                throw new ProviderError("captureTooLarge");
              count += group.resources.length;
              additional[index] = group;
            } catch (error) {
              signal.throwIfAborted();
              collectionError =
                error instanceof ProviderError ? error.code : "captureNetwork";
            }
          }
        }),
      );
      for (const group of additional) if (group) groups.push(group);
      if (groups.length > 1 && !collectionError)
        series.push({
          id: `pgc-series:${positive(season.series?.series_id) ? season.series.series_id : season.season_id}`,
          title: text(season.series?.series_title) || text(season.title),
          groupIds: groups.map((g) => g.id),
        });
    }
    for (const group of groups)
      if (
        new Set(group.resources.map((r) => r.id)).size !==
        group.resources.length
      )
        throw new ProviderError("captureIncomplete");
    return {
      id: randomUUID(),
      pageURL,
      current,
      groups,
      metadata,
      ...(series.length ? { series } : {}),
      ...(collectionError ? { collectionError } : {}),
    };
  }
  async resolve(
    resource: CaptureResource,
    signal: AbortSignal,
  ): Promise<ResolvedMedia> {
    captureResourceSchema.parse(resource);
    const data = await this.api(
      resource.episodeId ? "/pgc/player/web/playurl" : "/x/player/playurl",
      {
        bvid: resource.bvid,
        cid: resource.cid,
        ...(resource.episodeId ? { ep_id: resource.episodeId } : {}),
        qn: resource.quality || 127,
        fnval: 4048,
        fourk: 1,
      },
      signal,
    );
    return parsePlayback(data, resource.quality);
  }
}
