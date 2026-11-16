import { videoQualityLabel } from "../shared/capture";
import { useEffect, useRef, useState } from "react";
import {
  CaretRightIcon,
  DownloadSimpleIcon,
  FolderSimpleIcon,
  PauseIcon,
  PlayIcon,
  ArrowClockwiseIcon,
  XIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import type { LibraryState, Transfer } from "../shared/model";
import type { VideoDownloadJob, VideoDownloadItem } from "../shared/capture";
import {
  Blank,
  Button,
  Confirm,
  Fade,
  IconButton,
  PageHeader,
  TextTip,
} from "./common";
import { Progress } from "./components/ui/progress";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./components/ui/collapsible";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { useI18n, errorMessage } from "./i18n";

function TransferRate({
  items,
  stage,
}: {
  stage: "transferring" | "saving";
  items: Pick<
    VideoDownloadItem,
    "id" | "state" | "stage" | "received" | "uploaded"
  >[];
}) {
  const t = useI18n();
  const latest = useRef(items);
  latest.current = items;
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let samples: { time: number; bytes: number }[] = [];
    let identity = "";
    const timer = setInterval(() => {
      const active = latest.current.filter(
        (item) => item.state === "running" && item.stage === stage,
      );
      const key = active
        .map((item) => `${item.id}:${item.stage}`)
        .sort()
        .join(":");
      const sample = {
        time: performance.now(),
        bytes: active.reduce(
          (sum, item) =>
            sum +
            (item.stage === "saving" ? (item.uploaded ?? 0) : item.received),
          0,
        ),
      };
      if (
        !key ||
        key !== identity ||
        sample.bytes < (samples.at(-1)?.bytes ?? 0)
      ) {
        samples = [];
        identity = key;
        setRate(null);
      }
      if (
        !key ||
        active.some(
          (item) => item.stage === "saving" && item.uploaded === undefined,
        )
      )
        return;
      samples.push(sample);
      if (samples.length > 4) samples.shift();
      const first = samples[0];
      if (sample.time > first.time)
        setRate(
          ((sample.bytes - first.bytes) * 1000) / (sample.time - first.time),
        );
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);
  if (!items.some((item) => item.state === "running" && item.stage === stage))
    return null;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {" "}
      · {t(stage === "saving" ? "uploadRate" : "downloadRate")}{" "}
      {rate === null
        ? "—"
        : rate >= 1048576
          ? `${(rate / 1048576).toFixed(1)} MiB/s`
          : `${(rate / 1024).toFixed(0)} KiB/s`}
    </span>
  );
}

export function DownloadRate({
  items,
}: {
  items: Pick<
    VideoDownloadItem,
    "id" | "state" | "stage" | "received" | "uploaded"
  >[];
}) {
  return (
    <>
      <TransferRate items={items} stage="transferring" />
      <TransferRate items={items} stage="saving" />
    </>
  );
}

function fraction(item: VideoDownloadItem) {
  return item.state === "completed"
    ? 1
    : (item.progress ??
        (item.total ? Math.min(0.9, (item.received / item.total) * 0.9) : 0));
}
export function VideoTask({
  job,
  state,
  play,
  onCommand,
  onPlayEpisode,
}: {
  job: VideoDownloadJob;
  state?: LibraryState;
  play?(workId: string, episodeId: string): void;
  onPlayEpisode?(episodeId: string, itemId: string): void;
  onCommand?(
    action: "pause" | "resume" | "retry" | "cancel" | "remove",
    itemId?: string,
  ): Promise<unknown>;
}) {
  const t = useI18n();
  const [expanded, setExpanded] = useState(false),
    [cancel, setCancel] = useState<{ itemId?: string } | null>(null),
    [remove, setRemove] = useState<{ itemId?: string } | null>(null);
  const command = (
    action: "pause" | "resume" | "retry" | "cancel" | "remove",
    itemId?: string,
  ) =>
    void (
      onCommand
        ? onCommand(action, itemId)
        : window.tamki.library("video-download-action", {
            id: job.id,
            action,
            itemId,
          })
    ).catch((e) => toast.error(errorMessage(e, t)));
  const buttons = (items: VideoDownloadItem[], itemId?: string) => {
    const completed = items.find((i) => i.state === "completed" && i.episodeId);
    const episode = completed?.episodeId;
    const work = state?.works.find((w) =>
      w.episodes.some((e) => e.id === episode),
    );
    return (
      <div className="actions">
        {items.some((i) => ["queued", "running"].includes(i.state)) && (
          <IconButton
            label={t("pause")}
            onClick={() => command("pause", itemId)}
          >
            <PauseIcon />
          </IconButton>
        )}
        {items.some((i) => i.state === "paused") && (
          <IconButton
            label={t("resumeDownloadTask")}
            onClick={() => command("resume", itemId)}
          >
            <PlayIcon />
          </IconButton>
        )}
        {items.some((i) => ["failed", "cancelled"].includes(i.state)) && (
          <IconButton
            label={t("retryDownload")}
            onClick={() => command("retry", itemId)}
          >
            <ArrowClockwiseIcon />
          </IconButton>
        )}
        {items.some((i) =>
          ["queued", "running", "paused", "failed"].includes(i.state),
        ) && (
          <IconButton label={t("cancel")} onClick={() => setCancel({ itemId })}>
            <XIcon />
          </IconButton>
        )}
        {items.length > 0 &&
          items.every((i) =>
            ["completed", "cancelled", "failed"].includes(i.state),
          ) && (
            <IconButton
              label={t("removeDownloadTask")}
              onClick={() => setRemove({ itemId })}
            >
              <TrashIcon />
            </IconButton>
          )}
        {episode && (onPlayEpisode || (work && play)) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (onPlayEpisode) return onPlayEpisode(episode, completed!.id);
              const version = work?.episodes
                .find((e) => e.id === episode)
                ?.versions?.find((v) =>
                  v.files.some((f) => f.path === completed?.path),
                );
              void (
                version
                  ? window.tamki.library("select-version", {
                      id: episode,
                      versionId: version.id,
                    })
                  : Promise.resolve()
              )
                .then(() => play?.(work!.id, episode))
                .catch((error) => toast.error(errorMessage(error, t)));
            }}
          >
            {t("playDownloadedVideo")}
          </Button>
        )}
      </div>
    );
  };
  const status = (item: VideoDownloadItem) =>
    item.state === "running"
      ? t(
          (
            {
              resolving: "downloadResolving",
              transferring: "downloadTransferring",
              waitingMerge: "downloadWaitingMerge",
              waitingSave: "downloadWaitingSave",
              merging: "downloadMerging",
              saving: "downloadSaving",
            } as const
          )[item.stage],
        )
      : item.state === "queued"
        ? t("downloadQueued")
        : item.state === "failed"
          ? t("downloadFailed")
          : t(item.state);
  const progress = (items: VideoDownloadItem[], label: string) => {
    const percent =
      (items.reduce((n, i) => n + fraction(i), 0) / items.length) * 100;
    const active =
      items.find((i) => i.state === "running") ||
      items.find((i) => i.state !== "completed") ||
      items[0];
    return (
      <div className="download-task-progress">
        <div>
          <span>
            {status(active)}
            <DownloadRate items={items} />
            {items.length > 1
              ? ` · ${items.filter((i) => i.state === "completed").length}/${items.length}`
              : ""}
          </span>
          <span>{Math.floor(percent)}%</span>
        </div>
        <Progress value={percent} aria-label={label} />
      </div>
    );
  };
  const row = (item: VideoDownloadItem) => (
    <article className="download-task-item" key={item.id}>
      <div className="task-top">
        <div className="task-copy">
          <TextTip>
            {[job.groups?.find((g) => g.id === item.groupId)?.title, item.name]
              .filter(Boolean)
              .join(" · ")}
          </TextTip>
          <span className="muted">
            {item.qualityLabel ||
              (item.resource.quality
                ? videoQualityLabel(item.resource.quality)
                : item.state === "completed"
                  ? t("downloadQualityUnknown")
                  : t("downloadQualityAuto"))}
          </span>
          {item.error && (
            <span className="download-task-error">
              {errorMessage(new Error(item.error), t)}
            </span>
          )}
        </div>
        {buttons([item], item.id)}
      </div>
      {progress([item], item.name)}
    </article>
  );
  return (
    <>
      <Collapsible
        className="task-row video-task"
        open={expanded}
        onOpenChange={setExpanded}
      >
        <div className="task-top">
          <div className="download-task-heading">
            {job.series ? <FolderSimpleIcon /> : <DownloadSimpleIcon />}
            <div className="task-copy">
              <TextTip>{job.name}</TextTip>
              {!job.series && (
                <span className="muted">
                  {job.items[0].qualityLabel ||
                    (job.items[0].resource.quality
                      ? videoQualityLabel(job.items[0].resource.quality)
                      : job.items[0].state === "completed"
                        ? t("downloadQualityUnknown")
                        : t("downloadQualityAuto"))}
                </span>
              )}
              {state && (
                <TextTip>{`${state.connections.find((c) => c.id === job.target.connectionId)?.name || ""} · ${job.target.path}`}</TextTip>
              )}
              {!job.series && job.items[0].error && (
                <span className="download-task-error">
                  {errorMessage(new Error(job.items[0].error), t)}
                </span>
              )}
            </div>
          </div>
          <div className="actions">
            {buttons(job.items)}
            {job.series && (
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="capture-chevron"
                  aria-label={t(expanded ? "taskCollapse" : "taskExpand")}
                >
                  <CaretRightIcon />
                </Button>
              </CollapsibleTrigger>
            )}
          </div>
        </div>
        {progress(job.items, job.name)}
        {job.series && (
          <CollapsibleContent className="download-task-children">
            {job.items.map(row)}
          </CollapsibleContent>
        )}
      </Collapsible>
      {remove && (
        <Confirm
          title={t("removeDownloadTask")}
          description={t("removeDownloadTaskBody")}
          action={t("removeDownloadTask")}
          onClose={() => setRemove(null)}
          onConfirm={() => {
            command("remove", remove.itemId);
            setRemove(null);
          }}
        />
      )}
      {cancel && (
        <Confirm
          title={t("downloadCancelTitle")}
          description={t("downloadCancelBody")}
          action={t("downloadCancelAction")}
          onClose={() => setCancel(null)}
          onConfirm={() => {
            command("cancel", cancel.itemId);
            setCancel(null);
          }}
        />
      )}
    </>
  );
}
export function Tasks({
  state,
  onBack,
  play,
}: {
  state: LibraryState;
  onBack(): void;
  play(workId: string, episodeId: string): void;
}) {
  const t = useI18n();
  const [filter, setFilter] = useState("all"),
    [cancel, setCancel] = useState<Transfer | null>(null);
  const active = (value: string) =>
    ["queued", "running", "paused"].includes(value);
  const matches = (items: { state: string }[]) =>
    filter === "all" ||
    (filter === "active" && items.some((i) => active(i.state))) ||
    (filter === "failed" &&
      items.some((i) => ["failed", "interrupted"].includes(i.state))) ||
    (filter === "completed" && items.every((i) => i.state === "completed"));
  const jobs = (state.videoDownloads || []).filter((j) => matches(j.items)),
    transfers = state.transfers.filter((t) => matches([t]));
  const command = (id: string, action: string) =>
    void window.tamki
      .library("transfer", { id, action })
      .catch((e) => toast.error(errorMessage(e, t)));
  return (
    <section className="page tasks-page">
      <PageHeader
        title={t("tasks")}
        back={onBack}
        sub={
          <ToggleGroup
            type="single"
            value={filter}
            onValueChange={(v) => v && setFilter(v)}
            aria-label={t("tasks")}
          >
            {[
              ["all", "taskAll"],
              ["active", "taskActive"],
              ["failed", "taskFailed"],
              ["completed", "taskDone"],
            ].map(([value, label]) => (
              <ToggleGroupItem key={value} value={value}>
                {t(label as "taskAll")}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <Fade className="page-body">
        <div className="tasks-content">
          {!jobs.length && !transfers.length ? (
            <Blank
              title={t(filter === "all" ? "emptyTasks" : "downloadNoMatches")}
            />
          ) : (
            <>
              {jobs.map((job) => (
                <VideoTask key={job.id} job={job} state={state} play={play} />
              ))}
              {transfers.map((task) => (
                <article className="task-row" key={task.id}>
                  <div className="task-top">
                    <div className="task-copy">
                      <TextTip>{task.name}</TextTip>
                      <span className="muted">
                        {t(task.state)} ·{" "}
                        {Math.round(task.received / 1024 / 1024)} /{" "}
                        {task.total
                          ? Math.round(task.total / 1024 / 1024)
                          : "—"}{" "}
                        MB
                      </span>
                      <TextTip>{task.destination}</TextTip>
                    </div>
                    <div className="actions">
                      {task.state === "running" && (
                        <IconButton
                          label={t("pause")}
                          onClick={() => command(task.id, "pause")}
                        >
                          <PauseIcon />
                        </IconButton>
                      )}
                      {task.state === "paused" && (
                        <IconButton
                          label={t("resume")}
                          onClick={() => command(task.id, "resume")}
                        >
                          <PlayIcon />
                        </IconButton>
                      )}
                      {["running", "paused"].includes(task.state) && (
                        <IconButton
                          label={t("cancel")}
                          onClick={() => setCancel(task)}
                        >
                          <XIcon />
                        </IconButton>
                      )}
                    </div>
                  </div>
                  <Progress
                    value={
                      task.state === "completed"
                        ? 100
                        : task.total
                          ? (task.received / task.total) * 100
                          : 0
                    }
                    aria-label={task.name}
                  />
                </article>
              ))}
            </>
          )}
        </div>
      </Fade>

      {cancel && (
        <Confirm
          title={t("downloadCancelTitle")}
          description={t("downloadCancelBody")}
          action={t("downloadCancelAction")}
          onClose={() => setCancel(null)}
          onConfirm={() => {
            command(cancel.id, "cancel");
            setCancel(null);
          }}
        />
      )}
    </section>
  );
}
