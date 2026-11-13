import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "./i18n";
import { Slider } from "@/components/ui/slider";

const time = (value: number) => {
  const n = Math.max(0, Math.floor(value || 0)),
    h = Math.floor(n / 3600);
  return (
    (h ? h + ":" : "") +
    String(Math.floor((n % 3600) / 60)).padStart(h ? 2 : 1, "0") +
    ":" +
    String(n % 60).padStart(2, "0")
  );
};

// Only this small view samples each frame. Watching history stays on media events.
export function PlaybackTimeline({
  media,
  duration,
  enabled,
  disabled,
  onSeek,
  onPreview,
  onMediaSample,
}: {
  media: RefObject<HTMLVideoElement | null>;
  duration: number;
  enabled: boolean;
  disabled: boolean;
  onSeek: (value: number) => void;
  onPreview: (value: number | null) => void;
  onMediaSample: () => void;
}) {
  const t = useI18n();
  const [position, setPosition] = useState(0),
    [moving, setMoving] = useState(false),
    [dragging, setDragging] = useState(false),
    scrubbing = useRef(false);
  const sample = useRef(onMediaSample);
  sample.current = onMediaSample;
  const read = () => {
    const video = media.current;
    return video && Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(
          0,
          Math.min(duration, (video.currentTime / video.duration) * duration),
        )
      : 0;
  };
  useEffect(() => {
    const video = media.current;
    if (!video || !enabled) return;
    let frame = 0;
    const sync = () => {
      sample.current();
      if (
        !scrubbing.current &&
        !video.seeking &&
        document.visibilityState === "visible"
      )
        setPosition(read());
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const tick = () => {
      frame = 0;
      sync();
      if (
        !video.paused &&
        !video.ended &&
        document.visibilityState === "visible"
      )
        frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      stop();
      sync();
      if (
        !video.paused &&
        !video.ended &&
        document.visibilityState === "visible"
      )
        frame = requestAnimationFrame(tick);
    };
    const suspend = () => {
      stop();
      sync();
    };
    const seeking = () => {
      stop();
      sample.current();
      if (!scrubbing.current && document.visibilityState === "visible")
        setPosition(read());
    };
    const startEvents = [
      "playing",
      "play",
      "seeked",
      "loadedmetadata",
      "durationchange",
      "ratechange",
    ];
    const stopEvents = ["pause", "ended", "waiting", "emptied", "error"];
    startEvents.forEach((event) => video.addEventListener(event, restart));
    stopEvents.forEach((event) => video.addEventListener(event, suspend));
    video.addEventListener("seeking", seeking);
    video.addEventListener("timeupdate", sync);
    document.addEventListener("visibilitychange", restart);
    restart();
    return () => {
      stop();
      startEvents.forEach((event) => video.removeEventListener(event, restart));
      stopEvents.forEach((event) => video.removeEventListener(event, suspend));
      video.removeEventListener("seeking", seeking);
      video.removeEventListener("timeupdate", sync);
      document.removeEventListener("visibilitychange", restart);
    };
  }, [media, duration, enabled]);
  // Only media state changes update the decorative motion; no extra frame loop.
  useEffect(() => {
    const video = media.current;
    if (!video || !enabled || disabled) return;
    let buffering = false;
    const update = (event?: Event) => {
      if (event?.type === "waiting") buffering = true;
      if (event?.type === "playing" || event?.type === "canplay")
        buffering = false;
      setMoving(
        !buffering &&
          !video.paused &&
          !video.ended &&
          !video.seeking &&
          !video.error &&
          video.readyState >= 3 &&
          document.visibilityState === "visible",
      );
    };
    const events = [
      "play",
      "playing",
      "pause",
      "ended",
      "waiting",
      "canplay",
      "seeking",
      "seeked",
      "emptied",
      "error",
      "loadeddata",
    ];
    events.forEach((event) => video.addEventListener(event, update));
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      events.forEach((event) => video.removeEventListener(event, update));
      document.removeEventListener("visibilitychange", update);
    };
  }, [media, enabled, disabled]);
  const release = () => {
    scrubbing.current = false;
    setDragging(false);
    onPreview(null);
  };
  const cancel = () => {
    release();
    setPosition(read());
  };
  return (
    <Slider
      className="player-seek"
      value={[position]}
      max={Math.max(duration, 1)}
      step={0.01}
      disabled={disabled}
      thumbLabel={t("seek")}
      getValueLabel={(value) => time(value) + " / " + time(duration)}
      thumbContent={
        <span
          className="player-seek-mascot"
          data-playing={moving && enabled && !disabled && !dragging}
          aria-hidden="true"
        >
          <span className="player-seek-mascot-art" />
        </span>
      }
      onPointerDownCapture={() => {
        scrubbing.current = true;
        setDragging(true);
      }}
      onPointerUp={release}
      onPointerCancel={cancel}
      onLostPointerCapture={release}
      onValueChange={([value]) => {
        setPosition(value);
        onPreview(scrubbing.current ? value : null);
      }}
      onValueCommit={([value]) => {
        onSeek(value);
        setPosition(value);
        release();
      }}
    />
  );
}
