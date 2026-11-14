import { useEffect, useRef, useState } from "react";
import {
  MagnifyingGlassIcon,
  CircleNotchIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { diffWordsWithSpace } from "diff";
import {
  Button,
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
import type { Work } from "../shared/model";
import type { SettingsState } from "../shared/settings";
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
) {
  return [
    { value: "bangumi", label: "Bangumi" },
    {
      value: "tmdb",
      label: `TMDB${config.tmdbConfigured ? "" : ` · ${unconfiguredLabel}`}`,
      disabled: !config.tmdbConfigured,
    },
    { value: "filename", label: filenameLabel },
    ...config.sources.map((s) => ({
      value: s.id,
      label: s.name,
      disabled: !s.model || (!s.hasKey && s.auth !== "none"),
    })),
  ];
}
function Difference({
  change,
  side,
}: {
  change: MetadataChange;
  side: "before" | "after";
}) {
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
  episodeId,
  draftInput,
  onApply,
  onClose,
}: {
  work: Work;
  config: SettingsState["recognition"];
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
  );
  const [source, setSource] = useState(
    options.some((o) => o.value === config.defaultSourceId && !o.disabled)
      ? config.defaultSourceId
      : "bangumi",
  );
  const [query, setQuery] = useState(work.title),
    [phase, setPhase] = useState<"request" | "loading" | "candidates" | "diff">(
      "request",
    );
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
    if (!saving) onClose();
  };
  const run = async (candidate?: string) => {
    const jobId = crypto.randomUUID();
    job.current = jobId;
    setPhase("loading");
    setError("");
    try {
      const result = await window.tamki.library<RecognitionResponse>(
        "recognize",
        {
          jobId,
          sourceId: source,
          query,
          scope: episodeId ? "file" : "work",
          episodeId,
          draft: draftInput,
          candidate,
        },
      );
      if (!live.current || job.current !== jobId) return;
      setResponse(result);
      if (result.kind === "candidates") setPhase("candidates");
      else {
        setSelected(metadataChanges(work, result.result).map((c) => c.key));
        setPhase("diff");
      }
    } catch (e) {
      if (live.current && job.current === jobId) {
        setError(errorMessage(e, t));
        setPhase("request");
      }
    } finally {
      if (job.current === jobId) job.current = null;
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
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setPhase("request");
                  setResponse(undefined);
                }}
              >
                {t("back")}
              </Button>
              <Button
                disabled={saving || !selected.length}
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
              <Button disabled={!query.trim()} onClick={() => void run()}>
                <MagnifyingGlassIcon data-icon="inline-start" />
                {t("search")}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              onClick={phase === "loading" ? close : () => setPhase("request")}
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
                onChange={setSource}
                options={options}
              />
            </FormField>
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
                disabled={saving || !changes.length}
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
            {!changes.length ? (
              <Blank title={t("noRecognitionChanges")} />
            ) : (
              Array.from(new Set(changes.map((c) => c.target))).map(
                (target) => (
                  <section key={target} className="recognition-diff-group">
                    <h3>
                      {target === "work"
                        ? t("work")
                        : work.episodes.find((e) => e.id === target)?.fileName}
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
                              disabled={saving}
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
  );
}
