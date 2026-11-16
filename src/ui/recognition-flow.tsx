import { useEffect, useRef, useState } from "react";
import {
  MagnifyingGlassIcon,
  ArrowClockwiseIcon,
  CircleNotchIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { diffWordsWithSpace } from "diff";
import {
  Button,
  IconButton,
  Modal,
  Fade,
  FormField,
  Choice,
  Blank,
  TextTip,
} from "./common";
import { Checkbox } from "./components/ui/checkbox";
import { FieldGroup } from "./components/ui/field";
import { Textarea } from "./components/ui/textarea";
import { errorMessage, useI18n } from "./i18n";
import { Artwork } from "./media";
import type { Work } from "../shared/model";
import type { AIConnection } from "../shared/ai-connections";
import type { ModelOption } from "../shared/settings";
import { usesAccount, type SettingsState } from "../shared/settings";
import {
  applyMetadataChanges,
  metadataChanges,
  type RecognitionRequest,
  type RecognitionResponse,
  type MetadataChange,
} from "../shared/recognition";
export function recognitionOptions(
  config: SettingsState["recognition"],
  filenameLabel: string,
  unconfiguredLabel: string,
  connections?: AIConnection[],
  interactive = false,
) {
  return [
    { value: "bangumi", label: "Bangumi" },
    {
      value: "tmdb",
      label: `TMDB${config.tmdbConfigured ? "" : ` · ${unconfiguredLabel}`}`,
      disabled: !config.tmdbConfigured,
    },
    { value: "filename", label: filenameLabel },
    // Defaults must reference configured sources; ad-hoc connections belong only
    // to the interactive recognition dialog, which also asks for a model.
    ...(connections && interactive
      ? connections.flatMap((c) => {
          const sources = config.sources.filter((s) => s.connectionId === c.id);
          const connected = usesAccount(c.provider)
            ? c.account?.status === "connected"
            : c.hasKey || c.auth === "none";
          return sources.length
            ? sources.map((s) => ({
                value: s.id,
                label: sources.length === 1 ? c.name : `${c.name} · ${s.name}`,
                disabled: !connected || (!interactive && !s.model),
              }))
            : [
                {
                  value: `connection:${c.id}`,
                  label: c.name,
                  disabled: !connected || !interactive,
                },
              ];
        })
      : config.sources.map((s) => ({
          value: s.id,
          label: s.name,
          disabled:
            !s.model ||
            (usesAccount(s.provider)
              ? s.account?.status !== "connected"
              : !s.hasKey && s.auth !== "none"),
        }))),
  ];
}
function Difference({
  change,
  side,
}: {
  change: MetadataChange;
  side: "before" | "after";
}) {
  if (change.field === "cover")
    return <Artwork cover={String(change[side]) || undefined} />;
  const current = Array.isArray(change.before)
    ? change.before.join(" · ")
    : change.before;
  const incoming = Array.isArray(change.after)
    ? change.after.join(" · ")
    : change.after;
  return (
    <div className="recognition-value">
      {diffWordsWithSpace(current, incoming)
        .filter((p) => (side === "before" ? !p.added : !p.removed))
        .map((part, i) =>
          part.added || part.removed ? (
            <mark key={i}>{part.value}</mark>
          ) : (
            <span key={i}>{part.value}</span>
          ),
        ) || "—"}
    </div>
  );
}
export function RecognitionFlow({
  work,
  config,
  connections,
  episodeId,
  draftInput,
  onApply,
  onClose,
}: {
  work: Work;
  config: SettingsState["recognition"];
  connections?: AIConnection[];
  episodeId?: string;
  draftInput: RecognitionRequest["draft"];
  onApply(next: Work): Promise<void>;
  onClose(): void;
}) {
  const t = useI18n();
  const options = recognitionOptions(
    config,
    t("filenameSource"),
    t("notConfigured"),
    connections,
    true,
  );
  const [source, setSource] = useState(
    options.some((o) => o.value === config.defaultSourceId && !o.disabled)
      ? config.defaultSourceId
      : "bangumi",
  );
  const profile = config.sources.find((s) => s.id === source);
  const connection = connections?.find(
    (c) =>
      c.id ===
      (profile?.connectionId ||
        (source.startsWith("connection:") ? source.slice(11) : "")),
  );
  const [model, setModel] = useState(profile?.model || "");
  const [catalog, setCatalog] = useState<{
    id: string;
    models: ModelOption[];
  } | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const models =
    catalog && catalog.id === connection?.id
      ? catalog.models
      : connection?.models || [];
  const modelLoad = useRef(0);
  const loadModels = async () => {
    if (!connection) return;
    const revision = ++modelLoad.current;
    setLoadingModels(true);
    setError("");
    try {
      const models = await window.tamki.library<ModelOption[]>(
        "ai-feature-models",
        connection.id,
      );
      if (!live.current || revision !== modelLoad.current) return;
      setCatalog({ id: connection.id, models });
      setModel((old) => (models.some((m) => m.id === old) ? old : ""));
    } catch (e) {
      if (live.current && revision === modelLoad.current)
        setError(errorMessage(e, t));
    } finally {
      if (live.current && revision === modelLoad.current)
        setLoadingModels(false);
    }
  };
  const selectSource = (value: string) => {
    ++modelLoad.current;
    setLoadingModels(false);
    setError("");
    setSource(value);
    setModel(config.sources.find((s) => s.id === value)?.model || "");
  };
  const [query, setQuery] = useState(work.title),
    [phase, setPhase] = useState<"request" | "loading" | "candidates" | "diff">(
      "request",
    );
  const [feedbackOpen, setFeedbackOpen] = useState(false),
    [feedbackText, setFeedbackText] = useState(""),
    [feedbackHistory, setFeedbackHistory] = useState<string[]>([]),
    [refining, setRefining] = useState(false);
  const isAI = !!profile || !!connection;
  const [response, setResponse] = useState<RecognitionResponse>(),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [saving, setSaving] = useState(false);
  const job = useRef<string | null>(null),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (job.current)
        void window.tamki
          .library("cancel-recognition", job.current)
          .catch(() => {});
    };
  }, []);
  const changes =
    response?.kind === "result" ? metadataChanges(work, response.result) : [];
  const close = () => {
    if (!saving && !refining) onClose();
  };
  const run = async (candidate?: string, feedback?: string) => {
    const jobId = crypto.randomUUID();
    job.current = jobId;
    if (feedback) setRefining(true);
    else setPhase("loading");
    setError("");
    try {
      const result = await window.tamki.library<RecognitionResponse>(
        "recognize",
        {
          jobId,
          sourceId: source,
          ...(feedback && response?.kind === "result"
            ? {
                feedback: {
                  previous: {
                    ...response.result,
                    work: response.result.work
                      ? {
                          ...response.result.work,
                          cover: response.artworkSource?.cover || null,
                          coverPage:
                            response.artworkSource?.coverPage ||
                            response.result.work.coverPage ||
                            null,
                        }
                      : null,
                  },
                  messages: [...feedbackHistory, feedback],
                },
              }
            : {}),
          ...(connection && model ? { model } : {}),
          query,
          scope: episodeId ? "file" : "work",
          episodeId,
          draft: draftInput,
          candidate,
        },
      );
      if (!live.current || job.current !== jobId) return;
      setResponse(result);
      if (feedback) {
        setFeedbackHistory((old) => [...old, feedback]);
        setFeedbackText("");
        setFeedbackOpen(false);
      } else {
        setFeedbackHistory([]);
        setFeedbackText("");
      }
      if (result.kind === "candidates") setPhase("candidates");
      else {
        setSelected(metadataChanges(work, result.result).map((c) => c.key));
        setPhase("diff");
      }
    } catch (e) {
      if (live.current && job.current === jobId) {
        setError(errorMessage(e, t));
        if (!feedback) setPhase("request");
      }
    } finally {
      if (job.current === jobId) {
        job.current = null;
        if (live.current) setRefining(false);
      }
    }
  };
  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      await onApply(applyMetadataChanges(work, changes, selected));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Modal
        open
        onClose={close}
        title={
          phase === "diff"
            ? t("compareRecognition")
            : episodeId
              ? t("recognizeEpisode")
              : t("recognizeWork")
        }
        className={
          phase === "diff"
            ? "recognition-diff-modal"
            : "recognition-request-modal"
        }
        footer={
          <>
            <span role="status" className="modal-status error-text">
              {error}
            </span>
            {phase === "diff" ? (
              <>
                {isAI && (
                  <Button
                    variant="secondary"
                    disabled={saving || refining}
                    onClick={() => {
                      setError("");
                      setFeedbackOpen(true);
                    }}
                  >
                    {t("recognitionFeedback")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={saving || refining}
                  onClick={() => {
                    setPhase("request");
                    setResponse(undefined);
                  }}
                >
                  {t("back")}
                </Button>
                <Button
                  disabled={saving || refining || !selected.length}
                  onClick={() => void apply()}
                >
                  {t("applyAndSave")}
                </Button>
              </>
            ) : phase === "request" ? (
              <>
                <Button variant="secondary" onClick={close}>
                  {t("cancel")}
                </Button>
                <Button
                  disabled={
                    !query.trim() ||
                    loadingModels ||
                    (connection && !model) ||
                    !options.some((o) => o.value === source && !o.disabled)
                  }
                  onClick={() => void run()}
                >
                  <MagnifyingGlassIcon data-icon="inline-start" />
                  {t("search")}
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                onClick={
                  phase === "loading" ? close : () => setPhase("request")
                }
              >
                {t(phase === "loading" ? "cancel" : "back")}
              </Button>
            )}
          </>
        }
      >
        {phase === "request" ? (
          <div className="modal-body">
            <FieldGroup>
              <FormField label={t("recognitionSource")}>
                <Choice
                  label={t("recognitionSource")}
                  value={source}
                  onChange={selectSource}
                  options={options}
                />
              </FormField>
              {connection && (
                <FormField label={t("model")}>
                  <div className="recognition-model-choice">
                    <Choice
                      label={t("model")}
                      value={model}
                      placeholder={t("selectModel")}
                      onChange={setModel}
                      options={(model && !models.some((m) => m.id === model)
                        ? [{ id: model, name: model }, ...models]
                        : models
                      ).map((m) => ({ value: m.id, label: m.name || m.id }))}
                    />
                    <IconButton
                      label={t("loadModels")}
                      disabled={loadingModels}
                      onClick={() => void loadModels()}
                    >
                      <ArrowClockwiseIcon
                        className={loadingModels ? "spin" : undefined}
                      />
                    </IconButton>
                  </div>
                </FormField>
              )}
              <FormField label={t("promptTitle")} htmlFor="recognition-query">
                <Textarea
                  id="recognition-query"
                  maxLength={500}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </FormField>
            </FieldGroup>
          </div>
        ) : phase === "loading" ? (
          <div className="recognition-loading" role="status">
            <CircleNotchIcon className="spin" />
            <span>{t("recognizing")}</span>
          </div>
        ) : phase === "candidates" ? (
          <Fade className="modal-body recognition-candidates">
            {response?.kind === "candidates" && response.candidates.length ? (
              response.candidates.map((c) => (
                <Button
                  variant="ghost"
                  className="recognition-candidate"
                  key={c.id}
                  onClick={() => void run(c.id)}
                >
                  <div>
                    <TextTip>{c.title}</TextTip>
                    <span className="muted">{c.date}</span>
                  </div>
                  <p>{c.description}</p>
                </Button>
              ))
            ) : (
              <Blank title={t("noResults")} />
            )}
          </Fade>
        ) : (
          <>
            <div className="recognition-diff-toolbar">
              <label>
                <Checkbox
                  aria-label={t("selectAllChanges")}
                  disabled={saving || refining || !changes.length}
                  checked={
                    selected.length === changes.length && changes.length > 0
                      ? true
                      : selected.length
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(v) =>
                    setSelected(v ? changes.map((c) => c.key) : [])
                  }
                />
                {t("selectAllChanges")}
              </label>
            </div>
            <Fade className="modal-body recognition-diff-body">
              {response?.kind === "result" && response.artworkError && (
                <p className="muted">{t("artworkUnavailable")}</p>
              )}
              {!changes.length ? (
                <Blank title={t("noRecognitionChanges")} />
              ) : (
                Array.from(new Set(changes.map((c) => c.target))).map(
                  (target) => (
                    <section key={target} className="recognition-diff-group">
                      <h3>
                        {target === "work"
                          ? t("work")
                          : work.episodes.find((e) => e.id === target)
                              ?.fileName}
                      </h3>
                      <div className="recognition-columns muted">
                        <span>{t("currentInformation")}</span>
                        <span>{t("newInformation")}</span>
                      </div>
                      {changes
                        .filter((c) => c.target === target)
                        .map((c) => (
                          <div className="recognition-change" key={c.key}>
                            <label>
                              <Checkbox
                                disabled={saving || refining}
                                aria-label={`${t("applyField")} ${t(c.field === "number" ? "episodeNumber" : c.field === "title" ? "name" : c.field)}`}
                                checked={selected.includes(c.key)}
                                onCheckedChange={(v) =>
                                  setSelected((old) =>
                                    v
                                      ? [...old, c.key]
                                      : old.filter((k) => k !== c.key),
                                  )
                                }
                              />
                              {t(
                                c.field === "number"
                                  ? "episodeNumber"
                                  : c.field === "title"
                                    ? "name"
                                    : c.field,
                              )}
                            </label>
                            <div className="recognition-columns">
                              <Difference change={c} side="before" />
                              <Difference change={c} side="after" />
                            </div>
                          </div>
                        ))}
                    </section>
                  ),
                )
              )}
              {response?.kind === "result" &&
                work.episodes.filter(
                  (e) =>
                    (!episodeId || e.id === episodeId) &&
                    !response.result.files.some((f) => f.id === e.id),
                ).length > 0 && (
                  <p className="muted">{t("unmatchedUnchanged")}</p>
                )}
              {response?.kind === "result" && response.citations.length > 0 && (
                <div className="recognition-citations">
                  {response.citations.map((c) => (
                    <Button
                      key={c.url}
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void window.tamki
                          .library("open-citation", c.url)
                          .catch((e) => setError(errorMessage(e, t)))
                      }
                    >
                      <ArrowSquareOutIcon data-icon="inline-start" />
                      <TextTip>{c.title}</TextTip>
                    </Button>
                  ))}
                </div>
              )}
            </Fade>
          </>
        )}
      </Modal>
      {feedbackOpen && (
        <Modal
          open
          title={t("recognitionFeedback")}
          className="recognition-feedback-modal"
          onClose={() => {
            if (!refining) setFeedbackOpen(false);
          }}
          footer={
            <>
              <span role="status" className="modal-status error-text">
                {error}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  if (refining && job.current) {
                    const id = job.current;
                    job.current = null;
                    setRefining(false);
                    void window.tamki
                      .library("cancel-recognition", id)
                      .catch(() => {});
                  } else setFeedbackOpen(false);
                }}
              >
                {t(refining ? "cancel" : "back")}
              </Button>
              <Button
                disabled={
                  refining ||
                  !feedbackText.trim() ||
                  feedbackHistory.length >= 8 ||
                  [...feedbackHistory, feedbackText].join("\n").length > 24000
                }
                onClick={() => void run(undefined, feedbackText.trim())}
              >
                {refining && <CircleNotchIcon className="spin" />}
                {t(refining ? "recognizing" : "recognitionRefine")}
              </Button>
            </>
          }
        >
          <div className="modal-body">
            <FormField
              label={t("recognitionFeedbackLabel")}
              htmlFor="recognition-feedback"
            >
              <Textarea
                id="recognition-feedback"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                maxLength={8000}
                disabled={refining}
                placeholder={t("recognitionFeedbackPlaceholder")}
              />
            </FormField>
            {feedbackHistory.length >= 8 && (
              <p className="muted">{t("recognitionFeedbackLimit")}</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
