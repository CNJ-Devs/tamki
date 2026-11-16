import { randomUUID } from "node:crypto";
import type { Work, OnlineWork } from "../shared/model";
import type { CaptureResource, CaptureResult } from "../shared/capture";
import { mediaURL, type ResolvedMedia } from "./bilibili";
import { ProviderError } from "../providers/provider";

import { logEvent, diagnosticError } from "../diagnostics";

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export class CapturePlayback {
  private works = new Map<
    string,
    {
      work: Work;
      resources: CaptureResource[];
      controller: AbortController;
      generation?: number;
    }
  >();
  private streams = new Map<string, { workId: string; media: ResolvedMedia }>();
  constructor(
    private resolve: (
      resource: CaptureResource,
      signal: AbortSignal,
    ) => Promise<ResolvedMedia>,
    private request: typeof fetch,
  ) {}
  create(title: string, resources: CaptureResource[]): Work {
    const id = randomUUID();
    const work: Work = {
      id,
      title,
      connectionId: "",
      root: "",
      path: "",
      description: "",
      tags: [],
      createdAt: Date.now(),
      order: 0,
      resumeId: null,
      episodes: resources.map((resource, index) => ({
        id: `${id}:${index}`,
        workId: id,
        connectionId: "",
        path: "",
        fileName: resource.title,
        number: resource.metadata?.number || "",
        title: resource.metadata?.title || resource.title,
        description: resource.metadata?.description || "",
        size: 0,
        modified: 0,
        duration: resource.duration || null,
        position: 0,
        order: index,
        missing: false,
      })),
    };
    this.works.set(id, { work, resources, controller: new AbortController() });
    return work;
  }
  createContext(
    result: CaptureResult,
    selected: CaptureResource,
    title?: string,
  ): OnlineWork {
    const resources = [
      ...new Map(
        [...result.groups.flatMap((g) => g.resources), selected].map((r) => [
          r.id,
          r,
        ]),
      ).values(),
    ];
    const group = result.groups.find((g) =>
      g.resources.some((r) => r.id === selected.id),
    );
    const work: OnlineWork = this.create(
      title || group?.title || selected.title,
      resources,
    );
    const metadata =
      selected.workMetadata || group?.metadata || result.metadata;
    work.description = metadata?.description || "";
    work.tags = metadata?.tags || [];
    const episodeIds = new Map(
      resources.map((r, i) => [r.id, work.episodes[i].id]),
    );
    work.resumeId = episodeIds.get(selected.id)!;
    work.playbackGroups = result.groups.map((g) => ({
      id: g.id,
      title: g.title,
      episodeIds: g.resources.map((r) => episodeIds.get(r.id)!),
    }));
    if (!group)
      work.playbackGroups.push({
        id: selected.id,
        title: selected.title,
        episodeIds: [work.resumeId],
      });
    work.pageURL = result.pageURL;
    work.collectionError = result.collectionError;
    return work;
  }
  close(workId: string) {
    this.works.get(workId)?.controller.abort();
    this.works.delete(workId);
    for (const [token, value] of this.streams)
      if (value.workId === workId) this.streams.delete(token);
  }
  async source(episodeId: string, quality?: number) {
    const [workId, index] = episodeId.split(":");
    const entry = this.works.get(workId);
    if (!entry || !/^\d+$/.test(index) || !entry.resources[Number(index)])
      throw new ProviderError("mediaMissing");
    const generation = (entry.generation = (entry.generation || 0) + 1);
    const media = await this.resolve(
      { ...entry.resources[Number(index)], ...(quality ? { quality } : {}) },
      entry.controller.signal,
    );
    entry.controller.signal.throwIfAborted();
    if (generation !== entry.generation) throw new ProviderError("cancelled");
    logEvent("playback.resolved", {
      workId,
      reason: media.kind,
      quality: media.quality,
      durationMs: media.duration * 1000,
      eventCount: media.streams.length,
      codecs: media.streams.map((s) => s.dash?.codecs || "unknown").join(","),
    });
    if (media.kind === "segments" && media.streams.length !== 1)
      throw new ProviderError("captureUnavailable");
    if (media.kind === "dash" && media.streams.some((stream) => !stream.dash))
      throw new ProviderError("captureInvalid");
    for (const [token, value] of this.streams)
      if (value.workId === workId) this.streams.delete(token);
    const token = randomUUID();
    this.streams.set(token, { workId, media });
    return {
      url: `tamki-stream://media/${token}/${media.kind === "dash" ? "manifest.mpd" : "0"}`,
      dash: media.kind === "dash",
      qualities: media.qualities || [],
      quality: media.quality,
    };
  }
  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        [, token, part] = url.pathname.split("/");
      const entry = this.streams.get(token);
      if (
        url.hostname !== "media" ||
        !entry ||
        !["GET", "HEAD"].includes(request.method)
      )
        return new Response(null, { status: 403 });
      if (part === "manifest.mpd" && entry.media.kind === "dash") {
        const adaptations = entry.media.streams
          .map((stream, i) => {
            const d = stream.dash!;
            return `<AdaptationSet mimeType="${xml(d.mime)}" segmentAlignment="true"><Representation id="${i}" bandwidth="${d.bandwidth}" codecs="${xml(d.codecs)}"><BaseURL>tamki-stream://media/${token}/${i}</BaseURL><SegmentBase indexRange="${d.indexRange}"><Initialization range="${d.initialization}"/></SegmentBase></Representation></AdaptationSet>`;
          })
          .join("");
        return new Response(
          `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" mediaPresentationDuration="PT${entry.media.duration}S" minBufferTime="PT1.5S"><Period start="PT0S">${adaptations}</Period></MPD>`,
          {
            headers: {
              "Content-Type": "application/dash+xml",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      if (!/^\d+$/.test(part)) return new Response(null, { status: 404 });
      const stream = entry.media.streams[Number(part)];
      if (!stream) return new Response(null, { status: 404 });
      const headers: Record<string, string> = {
        Referer: "https://www.bilibili.com/",
      };
      const range = request.headers.get("Range");
      if (range) {
        if (!/^bytes=\d*-\d*$/.test(range))
          return new Response(null, { status: 416 });
        headers.Range = range;
      }
      let target = mediaURL(stream.url);
      for (let i = 0; i < 5; i++) {
        const response = await this.request(target, {
          headers,
          method: request.method,
          credentials: "omit",
          redirect: "manual",
          signal: request.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new ProviderError("captureInvalid");
          target = mediaURL(new URL(location, target).href);
          continue;
        }
        if (![200, 206].includes(response.status)) {
          logEvent(
            "playback.stream-failed",
            { status: response.status, origin: new URL(target).origin },
            "error",
          );
          await response.body?.cancel();
          return new Response(null, { status: 502 });
        }
        const output = new Headers({
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers":
            "Content-Range, Content-Length, Accept-Ranges",
          "Content-Type": stream.dash?.mime || "video/mp4",
        });
        for (const key of [
          "content-length",
          "content-range",
          "accept-ranges",
        ]) {
          const value = response.headers.get(key);
          if (value) output.set(key, value);
        }
        return new Response(response.body, {
          status: response.status,
          headers: output,
        });
      }
    } catch (error) {
      logEvent("playback.stream-failed", diagnosticError(error), "error");
      return new Response(null, { status: 502 });
    }
    return new Response(null, { status: 502 });
  }
}
