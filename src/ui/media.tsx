import { useEffect, useRef, useState } from "react";
import { FilmSlateIcon } from "@phosphor-icons/react";
import type { Episode, LibraryState } from "../shared/model";
const posters = new Map<string, string>();
let probes = 0;
const waiting: (() => void)[] = [];
export function useArtwork(key?: string) {
  const [value, setValue] = useState<{ key: string; url: string }>();
  useEffect(() => {
    let live = true;
    if (key)
      void window.tamki
        .library<string>("cover", key)
        .then((url) => {
          if (live) setValue({ key, url });
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return value?.key === key ? value?.url : undefined;
}
export function Artwork({ cover }: { cover?: string }) {
  const url = useArtwork(cover);
  return url ? (
    <img className="artwork-comparison" src={url} alt="" />
  ) : (
    <span>—</span>
  );
}
function acquire() {
  return new Promise<() => void>((resolve) => {
    const begin = () => {
      probes++;
      resolve(() => {
        probes--;
        waiting.shift()?.();
      });
    };
    if (probes < 2) begin();
    else waiting.push(begin);
  });
}
// Duration discovery is independent of which posters happen to be visible.
// Reuse the decoder queue, with two probes at most, including thumbnails.
export function useLibraryDurations(state?: LibraryState) {
  const attempted = useRef(new Set<string>());
  const pending = useRef(new Map<string, Episode>());
  const running = useRef(new Map<string, () => void>());
  const mounted = useRef(true);
  const start = useRef<() => void>(() => {});
  start.current = () => {
    if (!mounted.current || running.current.size >= 1) return;
    const item = pending.current.entries().next().value;
    if (!item) return;
    const [key, episode] = item;
    pending.current.delete(key);
    let media: HTMLVideoElement | undefined;
    let release: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (media) {
        media.onloadedmetadata = null;
        media.onerror = null;
        media.removeAttribute("src");
        media.load();
      }
      release?.();
      running.current.delete(key);
      start.current();
    };
    running.current.set(key, finish);
    void acquire().then(async (done) => {
      if (finished || !mounted.current) {
        done();
        finish();
        return;
      }
      release = done;
      try {
        const url = await window.tamki.library<string>("media", episode.id);
        if (finished || !mounted.current) {
          finish();
          return;
        }
        media = document.createElement("video");
        media.preload = "metadata";
        media.muted = true;
        media.onloadedmetadata = () => {
          const duration = media!.duration;
          if (Number.isFinite(duration) && duration > 0)
            void window.tamki
              .library("progress", {
                id: episode.id,
                position: 0,
                duration,
                resume: false,
              })
              .catch(() => {});
          finish();
        };
        media.onerror = finish;
        timeout = setTimeout(finish, 12000);
        media.src = url;
      } catch {
        finish();
      }
    });
  };
  useEffect(() => {
    const local = new Set(
      state?.connections.filter((c) => c.type === "local").map((c) => c.id),
    );
    const wanted = new Set<string>();
    for (const work of state?.works || [])
      for (const episode of work.episodes) {
        if (
          !local.has(episode.connectionId) ||
          episode.missing ||
          episode.duration !== null
        )
          continue;
        const key = `${episode.id}:${episode.modified}`;
        wanted.add(key);
        if (!attempted.current.has(key)) {
          attempted.current.add(key);
          pending.current.set(key, episode);
        }
      }
    for (const key of pending.current.keys())
      if (!wanted.has(key)) pending.current.delete(key);
    start.current();
  }, [state]);
  useEffect(
    () => () => {
      mounted.current = false;
      for (const cancel of running.current.values()) cancel();
      pending.current.clear();
    },
    [],
  );
}
export function Poster({
  episode,
  probe = true,
  cover,
}: {
  episode?: Episode;
  probe?: boolean;
  cover?: string;
}) {
  const artwork = useArtwork(cover);
  const [failedCover, setFailedCover] = useState<string>();
  const coverImage = cover !== failedCover ? artwork : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const key = episode ? `${episode.id}:${episode.modified}` : "";
  const [image, setImage] = useState(posters.get(key)),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    const ob = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        ob.disconnect();
      }
    });
    if (ref.current) ob.observe(ref.current);
    return () => ob.disconnect();
  }, []);
  useEffect(() => {
    setImage(posters.get(key));
    if (
      coverImage ||
      !visible ||
      !probe ||
      !episode ||
      episode.missing ||
      posters.has(key)
    )
      return;
    let disposed = false,
      video: HTMLVideoElement | undefined,
      release: (() => void) | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video = undefined;
      }
      release?.();
      release = undefined;
    };
    void acquire().then(async (done) => {
      release = done;
      if (disposed) {
        cleanup();
        return;
      }
      try {
        const url = await window.tamki.library<string>("media", episode.id);
        if (disposed) {
          cleanup();
          return;
        }
        const media = document.createElement("video");
        video = media;
        media.crossOrigin = "anonymous";
        media.muted = true;
        media.preload = "metadata";
        timer = setTimeout(cleanup, 12000);
        media.onloadedmetadata = () => {
          if (!Number.isFinite(media.duration) || media.duration <= 0) {
            cleanup();
            return;
          }
          if (episode.duration === null)
            void window.tamki
              .library("progress", {
                id: episode.id,
                position: episode.position,
                duration: media.duration,
                resume: false,
              })
              .catch(() => {});
          media.currentTime = Math.min(5, media.duration / 5);
        };
        media.onseeked = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 360;
            canvas.height = Math.max(
              1,
              Math.round((360 * media.videoHeight) / media.videoWidth),
            );
            canvas
              .getContext("2d")!
              .drawImage(media, 0, 0, canvas.width, canvas.height);
            const data = canvas.toDataURL("image/jpeg", 0.75);
            posters.set(key, data);
            if (posters.size > 250)
              posters.delete(posters.keys().next().value!);
            if (!disposed) setImage(data);
          } catch {
          } finally {
            cleanup();
          }
        };
        media.onerror = cleanup;
        media.src = url;
      } catch {
        cleanup();
      }
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [visible, key, probe, coverImage]);
  return (
    <div ref={ref} className="poster">
      {coverImage || image ? (
        <img
          src={coverImage || image}
          alt=""
          onError={() => setFailedCover(cover)}
        />
      ) : (
        <FilmSlateIcon aria-hidden="true" />
      )}
    </div>
  );
}
