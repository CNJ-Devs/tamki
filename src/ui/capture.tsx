import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  PlayIcon,
  FilmStripIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  XIcon,
  ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import type {
  CaptureViewState,
  CaptureGroup,
  CaptureSeries,
  CaptureResult,
  CaptureResource,
} from "../shared/capture";
import { downloadNameSchema } from "../shared/capture";
import type { Entry } from "../shared/model";
import type { SaveTarget } from "../shared/settings";
import { LocaleContext, useI18n, errorMessage } from "./i18n";
import { applyTheme } from "./theme";
import {
  Blank,
  Button,
  Choice,
  Fade,
  FormField,
  IconButton,
  Modal,
  TextTip,
} from "./common";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./components/ui/collapsible";
import { ButtonGroup } from "./components/ui/button-group";
import { Input } from "./components/ui/input";
import { FieldGroup } from "./components/ui/field";

const action = <T,>(type: string, value?: unknown) =>
  window.tamkiCapture.action<T>(type, value);
function Reel({ state }: { state: CaptureViewState }) {
  const t = useI18n();
  const drag = useRef<
    | { x: number; y: number; originX: number; originY: number; moved: boolean }
    | undefined
  >(undefined);
  const suppress = useRef(false);
  return (
    <div className="capture-reel-surface">
      <button
        className="capture-reel"
        aria-label={t("pageVideos")}
        aria-expanded={state.open}
        data-active={state.open}
        onPointerEnter={() => void action("hover", true)}
        onPointerLeave={() => {
          if (!drag.current) void action("hover", false);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.screenX,
            y: e.screenY,
            originX: e.screenX,
            originY: e.screenY,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (
            !d.moved &&
            Math.hypot(e.screenX - d.originX, e.screenY - d.originY) < 5
          )
            return;
          d.moved = true;
          suppress.current = true;
          const delta = { x: e.screenX - d.x, y: e.screenY - d.y };
          d.x = e.screenX;
          d.y = e.screenY;
          void action("drag", delta);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        onClick={() => {
          if (suppress.current) {
            suppress.current = false;
            return;
          }
          void action("pin");
        }}
      >
        <span className="capture-reel-bounce">
          <span className="capture-reel-mark" aria-hidden />
        </span>
      </button>
    </div>
  );
}
function ResourceRow({
  resource,
  select,
  play,
  current = false,
}: {
  resource: CaptureResource;
  select(): void;
  play(): void;
  current?: boolean;
}) {
  const t = useI18n();
  return (
    <div className="capture-resource">
      <FilmStripIcon />
      <TextTip>{resource.title}</TextTip>
      <IconButton label={t("play")} onClick={play}>
        <PlayIcon />
      </IconButton>
      <IconButton
        label={t(current ? "downloadCurrent" : "downloadVideo")}
        onClick={select}
      >
        <DownloadSimpleIcon />
      </IconButton>
    </div>
  );
}
function Group({ group, resultId }: { group: CaptureGroup; resultId: string }) {
  const t = useI18n();
  const [expanded, setExpanded] = useState(false);
  const sectionResources = new Set(
    group.sections?.flatMap((s) => s.resources.map((r) => r.id)),
  );
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="capture-group"
    >
      <div className="capture-group-heading">
        <div className="capture-group-title">
          <TextTip>{group.title}</TextTip>
          <small>
            {t("captureEpisodes").replace(
              "{n}",
              String(group.resources.length),
            )}
          </small>
        </div>
        <IconButton
          label={t("play")}
          disabled={group.incomplete || !group.resources.length}
          onClick={() => void action("play", { resultId, groupId: group.id })}
        >
          <PlayIcon />
        </IconButton>
        <IconButton
          label={t("downloadSeries")}
          disabled={group.incomplete || !group.resources.length}
          onClick={() =>
            void action("prepare", { resultId, groupId: group.id })
          }
        >
          <DownloadSimpleIcon />
        </IconButton>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(expanded ? "captureCollapse" : "captureExpand")}
            className="capture-chevron"
          >
            <CaretRightIcon />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="capture-items">
        {group.resources
          .filter((r) => !sectionResources.has(r.id))
          .map((resource) => (
            <ResourceRow
              key={resource.id}
              resource={resource}
              play={() =>
                void action("play", { resultId, resourceId: resource.id })
              }
              select={() =>
                void action("prepare", { resultId, resourceId: resource.id })
              }
            />
          ))}
        {group.sections?.map((section) => (
          <Group key={section.id} group={section} resultId={resultId} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
function SeriesGroup({
  series,
  result,
}: {
  series: CaptureSeries;
  result: CaptureResult;
}) {
  const t = useI18n();
  const [expanded, setExpanded] = useState(false);
  const groups = series.groupIds
    .map((id) => result.groups.find((g) => g.id === id)!)
    .filter(Boolean);
  const count = new Set(groups.flatMap((g) => g.resources.map((r) => r.id)))
    .size;
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="capture-group capture-series"
    >
      <div className="capture-group-heading">
        <div className="capture-group-title">
          <TextTip>{series.title}</TextTip>
          <small>
            {t("captureSeriesSummary")
              .replace("{works}", String(groups.length))
              .replace("{episodes}", String(count))}
          </small>
        </div>
        <IconButton
          label={t("play")}
          onClick={() =>
            void action("play", { resultId: result.id, seriesId: series.id })
          }
        >
          <PlayIcon />
        </IconButton>
        <IconButton
          label={t("downloadCaptureSeries")}
          onClick={() =>
            void action("prepare", { resultId: result.id, seriesId: series.id })
          }
        >
          <DownloadSimpleIcon />
        </IconButton>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(
              expanded ? "captureCollapseSeries" : "captureExpandSeries",
            )}
            className="capture-chevron"
          >
            <CaretRightIcon />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="capture-items">
        {groups.map((group) => (
          <Group key={group.id} group={group} resultId={result.id} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
export function CaptureMenu({ state }: { state: CaptureViewState }) {
  const t = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const result = state.snapshot.result;
  useEffect(() => {
    if (state.pinned) root.current?.querySelector("button")?.focus();
  }, [state.pinned]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => {
      const header = node.querySelector("header"),
        list = node.querySelector(".capture-scroll");
      if (header && list)
        void action(
          "measure",
          Math.ceil(
            header.getBoundingClientRect().height + list.scrollHeight + 50,
          ),
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const child = node.querySelector(".capture-menu-content");
    if (child) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [state.snapshot]);
  return (
    <div
      className="capture-panel-surface"
      onPointerEnter={() => void action("hover", true)}
      onPointerLeave={() => void action("hover", false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") void action("close");
      }}
    >
      <div
        ref={root}
        className="capture-menu"
        data-open={state.open}
        role="dialog"
        aria-label={t("pageVideos")}
      >
        <header>
          <h2>{t("pageVideos")}</h2>
          <IconButton label={t("close")} onClick={() => void action("close")}>
            <XIcon />
          </IconButton>
        </header>
        <Fade className="capture-scroll">
          <div className="capture-menu-content">
            {state.snapshot.status === "loading" ? (
              <div className="capture-loading" role="status">
                <ArrowClockwiseIcon className="spin" />
                {t("discoverVideos")}
              </div>
            ) : state.snapshot.status === "failed" ? (
              <Blank title={errorMessage(new Error(state.snapshot.error), t)}>
                <Button
                  variant="secondary"
                  onClick={() => void action("retry")}
                >
                  {t("refresh")}
                </Button>
              </Blank>
            ) : result ? (
              <>
                {result.current && (
                  <>
                    <span className="capture-section-label">
                      {t("currentVideo")}
                    </span>
                    <ResourceRow
                      current
                      resource={result.current}
                      play={() =>
                        void action("play", {
                          resultId: result.id,
                          resourceId: result.current!.id,
                        })
                      }
                      select={() =>
                        void action("prepare", {
                          resultId: result.id,
                          resourceId: result.current!.id,
                        })
                      }
                    />
                  </>
                )}
                {result.groups.map((group) => (
                  <Group
                    key={result.id + group.id}
                    group={group}
                    resultId={result.id}
                  />
                ))}
                {result.series?.map((series) => (
                  <SeriesGroup
                    key={result.id + series.id}
                    series={series}
                    result={result}
                  />
                ))}
                {result.collectionError && (
                  <Blank
                    size="section"
                    title={errorMessage(new Error(result.collectionError), t)}
                  >
                    <Button
                      variant="secondary"
                      onClick={() => void action("retry")}
                    >
                      {t("refresh")}
                    </Button>
                  </Blank>
                )}
              </>
            ) : (
              <Blank title={t("noPageVideos")} />
            )}
          </div>
        </Fade>
      </div>
    </div>
  );
}
export function DownloadForm({ state }: { state: CaptureViewState }) {
  const t = useI18n(),
    draft = state.draft!;
  const [qualities, setQualities] = useState<number[]>([0]);
  const [name, setName] = useState(draft.name),
    [target, setTarget] = useState<SaveTarget | null>(draft.target),
    [picking, setPicking] = useState(false),
    [directory, setDirectory] = useState(draft.target?.path || ""),
    [roots, setRoots] = useState<string[]>([]),
    [entries, setEntries] = useState<Entry[]>([]),
    [error, setError] = useState(""),
    [nameError, setNameError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [newFolder, setNewFolder] = useState(false),
    [folderName, setFolderName] = useState(""),
    [reload, setReload] = useState(0);
  const connection = state.connections.find(
    (c) => c.id === target?.connectionId,
  );
  useEffect(() => {
    if (!picking || !connection) return;
    let live = true;
    setLoading(true);
    setError("");
    Promise.all([
      action<string[]>("roots", connection.id),
      directory
        ? action<Entry[]>("list", { id: connection.id, path: directory })
        : Promise.resolve([]),
    ])
      .then(([r, e]) => {
        if (live) {
          setRoots(r);
          setEntries(e.filter((i) => i.directory));
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e, t));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [picking, connection?.id, directory, reload]);
  const close = () => {
    if (!busy) void action("close");
  };
  const submit = async () => {
    setError("");
    setNameError("");
    if (!downloadNameSchema.safeParse(name).success) {
      setNameError(t("downloadNameInvalid"));
      return;
    }
    if (!target) return;
    setBusy(true);
    try {
      await action("submit", {
        draftId: draft.id,
        name: name.trim(),
        target,
        qualities,
      });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (
      !target ||
      !directory ||
      !downloadNameSchema.safeParse(folderName).success
    ) {
      setError(t("downloadNameInvalid"));
      return;
    }
    setBusy(true);
    try {
      const result = await action<SaveTarget>("mkdir", {
        target: { ...target, path: directory },
        name: folderName,
      });
      setDirectory(result.path);
      setNewFolder(false);
      setFolderName("");
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const displayed = directory
    ? entries
    : roots.map((path) => ({ path, name: path }));
  return (
    <Modal
      open
      title={t(
        picking
          ? "chooseFolder"
          : draft.series
            ? "downloadSeries"
            : "downloadVideo",
      )}
      onClose={close}
      className="download-modal"
      footer={
        <>
          {picking ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setPicking(false);
                  setNewFolder(false);
                  setError("");
                }}
              >
                {t("back")}
              </Button>
              <Button
                disabled={busy || loading || !!error || !directory || newFolder}
                onClick={() => {
                  setTarget({ ...target!, path: directory });
                  setPicking(false);
                }}
              >
                {t("useFolder")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={close}>
                {t("cancel")}
              </Button>
              <Button
                disabled={
                  busy || !connection || connection.status === "offline"
                }
                onClick={() => void submit()}
              >
                {busy
                  ? t("loading")
                  : draft.series
                    ? t("captureDownloadCount").replace(
                        "{n}",
                        String(draft.count * qualities.length),
                      )
                    : t("download")}
              </Button>
            </>
          )}
        </>
      }
    >
      <Fade className="modal-body">
        <FieldGroup>
          {!picking && draft.hierarchy && (
            <div className="capture-download-hierarchy">
              <span className="capture-section-label">
                {t("captureSaveByWork")}
              </span>
              {draft.hierarchy.map((group, i) => (
                <div key={i}>
                  <TextTip>{group.title}</TextTip>
                  <small>
                    {t("captureEpisodes").replace("{n}", String(group.count))}
                  </small>
                </div>
              ))}
            </div>
          )}
          {picking ? (
            <FormField label={connection!.name} error={error}>
              <div className="directory-toolbar">
                <IconButton
                  label={t("back")}
                  disabled={loading || !directory || busy}
                  onClick={() => {
                    const parent =
                      directory.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/";
                    setDirectory(
                      roots.some(
                        (r) =>
                          parent === r ||
                          parent.startsWith(r.replace(/\/$/, "") + "/"),
                      )
                        ? parent
                        : "",
                    );
                    setNewFolder(false);
                  }}
                >
                  <CaretLeftIcon />
                </IconButton>
                <TextTip>{directory || t("roots")}</TextTip>
                <IconButton
                  label={t("newFolder")}
                  disabled={!directory || loading || busy}
                  onClick={() => setNewFolder((v) => !v)}
                >
                  <PlusIcon />
                </IconButton>
              </div>
              {newFolder && (
                <div className="download-new-folder">
                  <Input
                    aria-label={t("newFolder")}
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    autoFocus
                  />
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void create()}
                  >
                    {t("createFolder")}
                  </Button>
                </div>
              )}
              <div className="directory-list" aria-busy={loading}>
                {loading ? (
                  <span role="status">{t("loading")}</span>
                ) : error ? (
                  <Button
                    variant="secondary"
                    onClick={() => setReload((n) => n + 1)}
                  >
                    {t("refresh")}
                  </Button>
                ) : displayed.length ? (
                  displayed.map((e) => (
                    <Button
                      variant="ghost"
                      className="folder-open"
                      key={e.path}
                      onClick={() => {
                        setDirectory(e.path);
                        setNewFolder(false);
                      }}
                    >
                      <FolderIcon data-icon="inline-start" />
                      <TextTip>{e.name}</TextTip>
                      <CaretRightIcon data-icon="inline-end" />
                    </Button>
                  ))
                ) : (
                  <Blank title={t("noFolders")} />
                )}
              </div>
            </FormField>
          ) : !state.connections.length ? (
            <Blank title={t("captureStorageRequired")}>
              <Button
                variant="secondary"
                onClick={() => void action("settings")}
              >
                {t("downloadConnectionSettings")}
              </Button>
            </Blank>
          ) : (
            <>
              <FormField
                htmlFor="capture-name"
                label={
                  t(
                    draft.hierarchy
                      ? "captureFamilyName"
                      : draft.series
                        ? "captureSeriesName"
                        : "captureName",
                  ) +
                  (draft.series
                    ? ` · ${t("captureEpisodes").replace("{n}", String(draft.count))}`
                    : "")
                }
                error={nameError}
              >
                <Input
                  id="capture-name"
                  value={name}
                  maxLength={160}
                  disabled={busy}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError("");
                  }}
                  aria-invalid={!!nameError}
                />
              </FormField>
              <FormField label={t("downloadQuality")}>
                {!draft.qualities && !draft.qualityError && (
                  <span role="status">{t("loading")}</span>
                )}
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 0, label: t("downloadQualityAuto") },
                    ...(draft.qualities || []),
                  ].map((quality) => (
                    <Button
                      key={quality.id}
                      variant={
                        qualities.includes(quality.id) ? "secondary" : "ghost"
                      }
                      size="sm"
                      aria-pressed={qualities.includes(quality.id)}
                      disabled={busy}
                      onClick={() =>
                        setQualities((old) =>
                          quality.id === 0
                            ? [0]
                            : old.includes(quality.id)
                              ? old.length === 1
                                ? [0]
                                : old.filter((id) => id !== quality.id)
                              : [...old.filter((id) => id !== 0), quality.id],
                        )
                      }
                    >
                      {quality.label}
                    </Button>
                  ))}
                </div>
                <span className="muted">{t("downloadQualityHelp")}</span>
                {draft.qualityError && (
                  <span role="status">
                    {errorMessage(new Error(draft.qualityError), t)}
                  </span>
                )}
              </FormField>
              <FormField label={t("saveDestination")} error={error}>
                <ButtonGroup className="save-target-control">
                  <Choice
                    label={t("selectStorage")}
                    value={connection?.id || ""}
                    placeholder={t("selectStorage")}
                    disabled={busy}
                    options={state.connections.map((c) => ({
                      value: c.id,
                      label: c.name,
                      disabled: c.status === "offline",
                    }))}
                    onChange={(id) => {
                      const c = state.connections.find((c) => c.id === id)!;
                      setTarget({ connectionId: id, path: c.roots[0] || "" });
                      setError("");
                    }}
                  />
                  <Button
                    variant="secondary"
                    className="save-directory-trigger"
                    disabled={
                      busy || !connection || connection.status === "offline"
                    }
                    onClick={() => {
                      setDirectory(target?.path || "");
                      setPicking(true);
                    }}
                  >
                    <FolderOpenIcon data-icon="inline-start" />
                    <TextTip>{target?.path || t("chooseFolder")}</TextTip>
                  </Button>
                </ButtonGroup>
              </FormField>
            </>
          )}
        </FieldGroup>
      </Fade>
    </Modal>
  );
}
function CaptureApp() {
  const [state, setState] = useState<CaptureViewState>();
  useEffect(() => {
    const off = window.tamkiCapture.onState(setState);
    void action<CaptureViewState>("state").then(setState);
    return off;
  }, []);
  useEffect(() => {
    if (!state) return;
    const apply = () => applyTheme(state.preferences);
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state?.preferences]);
  return state ? (
    <LocaleContext value={state.preferences.language}>
      <TooltipProvider>
        {state.surface === "reel" ? (
          <Reel state={state} />
        ) : state.draft ? (
          <DownloadForm key={state.draft.id} state={state} />
        ) : (
          <CaptureMenu state={state} />
        )}
      </TooltipProvider>
    </LocaleContext>
  ) : null;
}
document.documentElement.classList.add("capture-surface");
if (document.getElementById("root"))
  createRoot(document.getElementById("root")!).render(<CaptureApp />);
