import { useCallback, useEffect, useRef, useState } from "react";
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  RewindIcon,
  FastForwardIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  CornersOutIcon,
  CornersInIcon,
  ArrowSquareOutIcon,
  PictureInPictureIcon,
  ArrowsOutSimpleIcon,
  ListBulletsIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Work, OnlineWork } from "../shared/model";
import { episodeName } from "../shared/model";
import { mediaSelection } from "../shared/versions";
import {
  IconButton,
  Button,
  TextTip,
  Fade,
  HorizontalScroll,
  clock,
} from "./common";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./components/ui/select";
import { Slider } from "./components/ui/slider";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "./components/ui/popover";
import { PlaybackTimeline } from "./playback-timeline";
import { mediaSeekBoundary } from "../shared/seek-boundary";
import { useI18n, errorMessage } from "./i18n";
import { toast } from "sonner";
import { cn } from "./lib/utils";

export function Player({
  work,
  online = false,
  active,
  requestedEpisode,
  relatedWorks = [],
  onWork,
  activate,
}: {
  work: OnlineWork;
  relatedWorks?: Work[];
  onWork?(id: string): void;
  online?: boolean;
  active: boolean;
  requestedEpisode?: { id: string; nonce: number };
  activate(): void;
}) {
  const t = useI18n();
  const root = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [episodeId, setEpisodeId] = useState(
      work.resumeId || work.episodes[0]?.id,
    ),
    [paused, setPaused] = useState(true),
    [duration, setDuration] = useState(0),
    [position, setPosition] = useState(0),
    [preview, setPreview] = useState<number | null>(null),
    [failure, setFailure] = useState(false),
    [volume, setVolume] = useState(0.8),
    [muted, setMuted] = useState(false),
    [speed, setSpeed] = useState("1"),
    [queue, setQueue] = useState(false),
    [fullscreen, setFullscreen] = useState(false),
    [shown, setShown] = useState(true),
    [mini, setMini] = useState(false),
    [pip, setPip] = useState(false),
    [switching, setSwitching] = useState(false),
    [rect, setRect] = useState({ left: 0, top: 0, width: 1, height: 1 }),
    [boundary, setBoundary] = useState({ atStart: true, atEnd: true });
  const index = work.episodes.findIndex((e) => e.id === episodeId),
    episode = work.episodes[index];
  const groups = work.playbackGroups || [];
  const currentGroup = groups.find((g) => g.episodeIds.includes(episodeId));
  const [browseGroup, setBrowseGroup] = useState(currentGroup?.id);
  const browsing = groups.find((g) => g.id === browseGroup) || currentGroup;
  const queueEpisodes = browsing
    ? browsing.episodeIds
        .map((id) => work.episodes.find((e) => e.id === id)!)
        .filter(Boolean)
    : work.episodes;
  const currentEpisodes = currentGroup
    ? work.episodes.filter((e) => currentGroup.episodeIds.includes(e.id))
    : work.episodes;
  const currentIndex = currentEpisodes.findIndex((e) => e.id === episodeId);
  const [quality, setQuality] = useState(0);
  const [qualities, setQualities] = useState<{ id: number; label: string }[]>(
    [],
  );
  const [actualQuality, setActualQuality] = useState<number>();
  const [retry, setRetry] = useState(0);
  const [failureText, setFailureText] = useState("");
  const resumePosition = useRef<{ episodeId: string; position: number } | null>(
    null,
  );
  const loadedMedia = useRef<ReturnType<typeof mediaSelection> | null>(null);
  const rememberPosition = () => {
    const v = video.current;
    if (
      episode &&
      v &&
      v.readyState >= 1 &&
      loadedMedia.current?.id === episode.id
    )
      resumePosition.current = {
        episodeId: episode.id,
        position: v.currentTime,
      };
    return resumePosition.current;
  };
  const nextAutoplay = useRef(true);
  const [versionMenu, setVersionMenu] = useState(false);
  const [changingVersion, setChangingVersion] = useState(false);
  const saved = useRef(0),
    hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useCallback((force = false) => {
    if (online) return;
    const v = video.current,
      e = loadedMedia.current;
    if (
      !v ||
      !e ||
      !Number.isFinite(v.duration) ||
      v.duration <= 0 ||
      v.readyState < 1
    )
      return;
    if (!force && Date.now() - saved.current < 3000) return;
    saved.current = Date.now();
    void window.tamki
      .library("progress", {
        ...e,
        position: v.currentTime,
        duration: v.duration,
      })
      .catch(() => {});
  }, []);
  const updateBoundary = () => {
    const next = mediaSeekBoundary(video.current, duration);
    setBoundary((old) =>
      old.atStart === next.atStart && old.atEnd === next.atEnd ? old : next,
    );
  };
  useEffect(() => {
    if (requestedEpisode) {
      commit(true);
      nextAutoplay.current = true;
      setEpisodeId(requestedEpisode.id);
    }
  }, [requestedEpisode?.nonce]);
  useEffect(() => {
    if (!episode) setEpisodeId(work.episodes[0]?.id);
  }, [episode, work.episodes]);
  useEffect(() => {
    const v = video.current;
    if (!v || !episode) return;
    let cancelled = false;
    let dashPlayer: { reset(): void } | undefined;
    const selection = mediaSelection(episode);
    const autoplay = nextAutoplay.current;
    setDuration(0);
    setPosition(0);
    setFailure(false);
    setBoundary({ atStart: true, atEnd: true });
    const restore = () => {
      if (cancelled) return;
      loadedMedia.current = selection;
      setDuration(Number.isFinite(v.duration) ? v.duration : 0);
      const position =
        resumePosition.current?.episodeId === episode.id
          ? resumePosition.current.position
          : episode.position;
      resumePosition.current = null;
      if (position > 0 && Number.isFinite(v.duration) && v.duration > 0)
        v.currentTime = Math.min(position, Math.max(0, v.duration - 0.02));
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = Number(speed);
      if (autoplay) void v.play().catch(() => setPaused(true));
      else setPaused(true);
    };
    v.addEventListener("loadedmetadata", restore, { once: true });
    const source: Promise<{
      url: string;
      dash: boolean;
      quality?: number;
      qualities?: { id: number; label: string }[];
    }> = online
      ? window.tamki.library<{
          url: string;
          dash: boolean;
          quality?: number;
          qualities?: { id: number; label: string }[];
        }>("online-media", { episodeId: episode.id, quality })
      : window.tamki
          .library<string>("media", selection)
          .then((url) => ({ url, dash: false }));
    void source
      .then(async (source) => {
        if (cancelled) return;
        const { url, dash } = source;
        if ("qualities" in source) {
          setQualities(source.qualities || []);
          setActualQuality(source.quality);
        }
        if (dash) {
          const { MediaPlayer } = await import("dashjs");
          if (cancelled) return;
          const player = MediaPlayer().create();
          dashPlayer = player;
          player.updateSettings({ debug: { logLevel: 0 } });
          player.on(MediaPlayer.events.ERROR, (event: any) => {
            if (!cancelled) {
              setFailure(true);
              setFailureText(t("onlinePlaybackFailed"));
              void window.tamki
                .library("online-player-error", {
                  episodeId: episode.id,
                  stage: "dash",
                  code: String(event?.error?.code ?? "unknown").slice(0, 100),
                })
                .catch(() => {});
            }
          });
          player.initialize(v, url, false);
        } else {
          v.src = url;
          v.load();
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFailure(true);
          setFailureText(errorMessage(error, t));
        }
      });
    return () => {
      commit(true);
      loadedMedia.current = null;
      cancelled = true;
      v.removeEventListener("loadedmetadata", restore);
      dashPlayer?.reset();
      v.pause();
      v.removeAttribute("src");
      v.load();
    };
  }, [
    episodeId,
    episode?.activeVersionId,
    episode?.activeFileId,
    quality,
    retry,
  ]);
  useEffect(
    () => () => {
      commit(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, fullscreen]);
  useEffect(() => {
    if (!active) setQueue(false);
  }, [active]);
  useEffect(() => {
    const close = () => setQueue(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, []);
  useEffect(() => {
    const listener = () => {
      setQueue(false);
      setFullscreen(document.fullscreenElement === root.current);
      setShown(true);
    };
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  }, []);
  useEffect(() => {
    const v = video.current!;
    const enter = () => {
        setMini(false);
        setPip(true);
      },
      leave = () => setPip(false);
    v.addEventListener("enterpictureinpicture", enter);
    v.addEventListener("leavepictureinpicture", leave);
    return () => {
      v.removeEventListener("enterpictureinpicture", enter);
      v.removeEventListener("leavepictureinpicture", leave);
    };
  }, []);
  const show = () => {
    setShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (fullscreen && !video.current?.paused && !queue && !versionMenu)
      hideTimer.current = setTimeout(() => setShown(false), 2200);
  };
  useEffect(() => {
    show();
  }, [fullscreen, paused, queue, versionMenu]);
  const toggle = () => {
    const v = video.current;
    if (!v || failure) return;
    if (v.paused) void v.play().catch(() => setFailure(true));
    else v.pause();
    show();
  };
  const seek = (value: number) => {
    const v = video.current;
    if (!v || !duration) return;
    v.currentTime = Math.max(0, Math.min(duration, value));
    setPosition(v.currentTime);
    updateBoundary();
    commit(true);
    show();
  };
  const choose = (id: string) => {
    commit(true);
    nextAutoplay.current = true;
    resumePosition.current = null;
    setQuality(0);
    setQualities([]);
    setEpisodeId(id);
    setQueue(false);
  };
  const picture = async () => {
    if (switching) return;
    setSwitching(true);
    try {
      if (document.pictureInPictureElement)
        await document.exitPictureInPicture();
      else {
        if (document.fullscreenElement) await document.exitFullscreen();
        setMini(false);
        await video.current!.requestPictureInPicture();
      }
    } catch {
      toast.error(t("pipFailed"), { duration: 3500 });
    } finally {
      setSwitching(false);
    }
  };
  const small = async () => {
    if (switching) return;
    setSwitching(true);
    try {
      if (document.pictureInPictureElement)
        await document.exitPictureInPicture();
      if (document.fullscreenElement) await document.exitFullscreen();
      setMini((v) => !v);
      setQueue(false);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setSwitching(false);
    }
  };
  const full = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        if (document.pictureInPictureElement)
          await document.exitPictureInPicture();
        setMini(false);
        await root.current!.requestFullscreen();
      }
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };
  const restore = () => {
    activate();
    setMini(false);
  };
  if (!episode) return null;
  const target = mini
    ? {
        left: Math.max(12, window.innerWidth - 372),
        top: Math.max(12, window.innerHeight - 255),
        width: 352,
        height: 198,
      }
    : rect;
  return (
    <Popover
      open={queue}
      onOpenChange={(open) => {
        setQueue(open);
        if (open) {
          setBrowseGroup(currentGroup?.id);
          show();
        }
      }}
    >
      <div
        ref={root}
        className={cn(
          "player",
          fullscreen && "is-fullscreen",
          !active && "inactive-player",
          !shown && "controls-hidden",
        )}
        onPointerMove={show}
        onFocusCapture={show}
        onKeyDown={(e) => {
          if (
            (e.target as HTMLElement).closest(
              "button,input,[role=slider],[role=combobox]",
            )
          )
            return;
          if (e.code === "Space" || e.key === "k") {
            e.preventDefault();
            toggle();
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            seek(position - 10);
          }
          if (e.key === "ArrowRight") {
            e.preventDefault();
            seek(position + 10);
          }
        }}
        tabIndex={0}
      >
        <header className="player-header" inert={fullscreen && !shown}>
          <TextTip>
            {episodeName(episode) === work.title
              ? work.title
              : `${currentGroup?.title || work.title} · ${episodeName(episode)}`}
          </TextTip>
        </header>
        <div ref={stage} className="player-stage">
          {(mini || pip) && (
            <div className="player-placeholder">
              <p>{t(mini ? "playingMini" : "playingPip")}</p>
              <Button
                variant="secondary"
                onClick={() => (mini ? restore() : void picture())}
              >
                {t("returnPlayer")}
              </Button>
            </div>
          )}
          {failure && (
            <div className="player-placeholder">
              <p role="alert">
                {online
                  ? failureText || t("onlinePlaybackFailed")
                  : t("playbackFailed")}
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  rememberPosition();
                  setRetry((n) => n + 1);
                }}
              >
                {t("retryPlayback")}
              </Button>
            </div>
          )}
        </div>
        <div
          className={cn(
            "video-surface",
            mini && "mini-surface",
            pip && "pip-surface",
          )}
          style={{
            left: target.left,
            top: target.top,
            width: target.width,
            height: target.height,
          }}
        >
          <video
            ref={video}
            playsInline
            onClick={toggle}
            onDoubleClick={() => void full()}
            onPlay={() => {
              setPaused(false);
              show();
            }}
            onPause={() => {
              setPaused(true);
              commit(true);
            }}
            onTimeUpdate={() => {
              setPosition(video.current!.currentTime);
              updateBoundary();
              commit();
            }}
            onSeeked={() => {
              updateBoundary();
              commit(true);
            }}
            onError={() => {
              if (video.current?.getAttribute("src")) {
                setFailure(true);
                setFailureText(t("onlinePlaybackFailed"));
                if (online)
                  void window.tamki
                    .library("online-player-error", {
                      episodeId: episode.id,
                      stage: "video",
                      code: String(video.current.error?.code || "unknown"),
                    })
                    .catch(() => {});
              }
            }}
            onEnded={() => {
              commit(true);
              if (currentIndex < currentEpisodes.length - 1)
                choose(currentEpisodes[currentIndex + 1].id);
              else setPaused(true);
            }}
          />
          {mini && (
            <>
              <div className="mini-heading">
                <TextTip>{work.title}</TextTip>
                <IconButton label={t("returnPlayer")} onClick={restore}>
                  <ArrowsOutSimpleIcon />
                </IconButton>
                <IconButton
                  label={t("close")}
                  onClick={() => {
                    video.current?.pause();
                    setMini(false);
                  }}
                >
                  <XIcon />
                </IconButton>
              </div>
              <div className="mini-controls">
                <IconButton
                  label={t(paused ? "play" : "pause")}
                  onClick={toggle}
                >
                  {paused ? <PlayIcon /> : <PauseIcon />}
                </IconButton>
                <span>
                  {clock(position)} / {clock(duration)}
                </span>
                <IconButton
                  label={t("pip")}
                  onClick={() => void picture()}
                  disabled={switching}
                >
                  <ArrowSquareOutIcon />
                </IconButton>
              </div>
            </>
          )}
        </div>
        <footer className="player-controls" inert={fullscreen && !shown}>
          <PlaybackTimeline
            media={video}
            duration={duration}
            enabled={active}
            disabled={!duration || failure}
            onSeek={seek}
            onPreview={setPreview}
            onMediaSample={updateBoundary}
          />
          <div className="player-toolbar">
            <div className="player-transport">
              <IconButton
                label={t(paused ? "play" : "pause")}
                onClick={toggle}
                disabled={failure}
              >
                {paused ? <PlayIcon /> : <PauseIcon />}
              </IconButton>
              <IconButton
                label={t("previousEpisode")}
                disabled={currentIndex <= 0}
                onClick={() => choose(currentEpisodes[currentIndex - 1].id)}
              >
                <SkipBackIcon />
              </IconButton>
              <IconButton
                label={t("nextEpisode")}
                disabled={currentIndex >= currentEpisodes.length - 1}
                onClick={() => choose(currentEpisodes[currentIndex + 1].id)}
              >
                <SkipForwardIcon />
              </IconButton>
              <IconButton
                label={t("rewind")}
                disabled={failure || boundary.atStart}
                onClick={() => seek(position - 10)}
              >
                <RewindIcon />
              </IconButton>
              <IconButton
                label={t("fastForward")}
                disabled={failure || boundary.atEnd}
                onClick={() => seek(position + 10)}
              >
                <FastForwardIcon />
              </IconButton>
            </div>
            <span className="player-time">
              {clock(preview ?? position)} <span>/ {clock(duration)}</span>
            </span>
            <div className="player-options">
              <div className="player-volume">
                <IconButton
                  label={t(muted ? "unmute" : "mute")}
                  onClick={() => {
                    const next = !muted;
                    setMuted(next);
                    video.current!.muted = next;
                  }}
                >
                  {muted || !volume ? (
                    <SpeakerSlashIcon />
                  ) : (
                    <SpeakerHighIcon />
                  )}
                </IconButton>
                <Slider
                  value={[muted ? 0 : volume]}
                  min={0}
                  max={1}
                  step={0.01}
                  thumbLabel={t("volume")}
                  onValueChange={([v]) => {
                    setVolume(v);
                    setMuted(false);
                    video.current!.volume = v;
                    video.current!.muted = false;
                  }}
                />
              </div>
              {online && qualities.length > 0 && (
                <Select
                  value={String(quality || actualQuality || qualities[0].id)}
                  onOpenChange={setVersionMenu}
                  onValueChange={(value) => {
                    rememberPosition();
                    nextAutoplay.current = !video.current?.paused;
                    setQuality(Number(value));
                  }}
                >
                  <SelectTrigger
                    aria-label={t("playbackQuality")}
                    className="player-version-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    container={
                      fullscreen ? root.current || undefined : undefined
                    }
                  >
                    <SelectGroup>
                      {qualities.map((q) => (
                        <SelectItem key={q.id} value={String(q.id)}>
                          {q.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
              {(episode.versions?.length || 0) > 1 && (
                <Select
                  value={episode.activeVersionId}
                  disabled={changingVersion}
                  onOpenChange={setVersionMenu}
                  onValueChange={(versionId) => {
                    const resume = rememberPosition();
                    commit(true);
                    nextAutoplay.current = !video.current?.paused;
                    setChangingVersion(true);
                    void window.tamki
                      .library("select-version", { id: episode.id, versionId })
                      .catch((e) => {
                        if (resumePosition.current === resume)
                          resumePosition.current = null;
                        toast.error(errorMessage(e, t));
                      })
                      .finally(() => setChangingVersion(false));
                  }}
                >
                  <SelectTrigger
                    aria-label={t("playbackVersion")}
                    className="player-version-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    container={
                      fullscreen ? root.current || undefined : undefined
                    }
                  >
                    <SelectGroup>
                      {episode.versions!.map((v, i) => (
                        <SelectItem
                          key={v.id}
                          value={v.id}
                          disabled={v.files.every((f) => f.missing)}
                        >
                          {v.label ||
                            t("versionNumber").replace("{n}", String(i + 1))}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
              <Select
                value={speed}
                onValueChange={(v) => {
                  setSpeed(v);
                  video.current!.playbackRate = Number(v);
                }}
              >
                <SelectTrigger aria-label={t("speed")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  container={fullscreen ? root.current || undefined : undefined}
                >
                  <SelectGroup>
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {v}×
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <PopoverTrigger asChild>
                <IconButton label={t("queue")}>
                  <ListBulletsIcon />
                </IconButton>
              </PopoverTrigger>
              <IconButton
                label={t("mini")}
                disabled={switching || failure}
                onClick={() => void small()}
              >
                <PictureInPictureIcon />
              </IconButton>
              <IconButton
                label={t("pip")}
                disabled={
                  switching || failure || !document.pictureInPictureEnabled
                }
                onClick={() => void picture()}
              >
                <ArrowSquareOutIcon />
              </IconButton>
              <IconButton
                label={t(fullscreen ? "exitFullscreen" : "fullscreen")}
                onClick={() => void full()}
              >
                {fullscreen ? <CornersInIcon /> : <CornersOutIcon />}
              </IconButton>
            </div>
          </div>
        </footer>
        <PopoverContent
          className="player-queue"
          aria-label={t("queue")}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          portalContainer={fullscreen ? root.current || undefined : undefined}
        >
          <header>
            <h3>{t("queue")}</h3>
          </header>
          {(groups.length > 1 || relatedWorks.length > 1) && (
            <HorizontalScroll
              className="player-queue-groups"
              role="group"
              aria-label={t("playerSeries")}
            >
              {groups.length > 1
                ? groups.map((g) => (
                    <Button
                      key={g.id}
                      variant={browsing?.id === g.id ? "secondary" : "ghost"}
                      aria-pressed={browsing?.id === g.id}
                      onClick={() => setBrowseGroup(g.id)}
                    >
                      {g.title}
                    </Button>
                  ))
                : relatedWorks.map((w) => (
                    <Button
                      key={w.id}
                      variant={w.id === work.id ? "secondary" : "ghost"}
                      aria-pressed={w.id === work.id}
                      onClick={() => {
                        commit(true);
                        video.current?.pause();
                        onWork?.(w.id);
                      }}
                    >
                      {w.title}
                    </Button>
                  ))}
            </HorizontalScroll>
          )}
          {work.collectionError && (
            <p className="player-queue-caption" role="status">
              {t("playerIncompleteDirectory")}
            </p>
          )}
          <Fade>
            {queueEpisodes.map((e) => (
              <Button
                key={e.id}
                variant={e.id === episode.id ? "secondary" : "ghost"}
                disabled={e.missing}
                onClick={() => choose(e.id)}
              >
                <TextTip>{episodeName(e)}</TextTip>
                <span>{clock(e.duration)}</span>
              </Button>
            ))}
          </Fade>
        </PopoverContent>
      </div>
    </Popover>
  );
}
