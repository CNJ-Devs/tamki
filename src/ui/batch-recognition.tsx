import { useState } from "react";
import type { LibraryState, Work } from "../shared/model";
import {
  Button,
  Choice,
  FormField,
  Modal,
  Search,
  Blank,
  TextTip,
} from "./common";
import { Checkbox } from "./components/ui/checkbox";
import { Badge } from "./components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "./components/ui/field";
import { recognitionOptions } from "./recognition-flow";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";

const busy = (work: Work) =>
  ["queued", "running"].includes(work.recognition?.status || "");
const available = (work: Work) => work.episodes.some((e) => !e.missing);
const incomplete = (work: Work) =>
  !work.cover ||
  !work.description ||
  ["failed", "needs-choice", "no-match", "local"].includes(
    work.recognition?.status || "",
  );
const labels = {
  queued: "autoQueued",
  running: "autoRunning",
  complete: "autoComplete",
  "needs-choice": "autoChoice",
  "no-match": "autoNoMatch",
  failed: "autoFailed",
  local: "autoLocal",
} as const;

export function BatchRecognition({
  state,
  onClose,
  onInspect,
}: {
  state: LibraryState;
  onClose(): void;
  onInspect(id: string): void;
}) {
  const t = useI18n();
  const options = recognitionOptions(
    state.settings.recognition,
    t("filenameSource"),
    t("notConfigured"),
  );
  const [source, setSource] = useState(() => {
    const pendingSource = state.works.find(
      (w) => w.recognition?.requested && busy(w),
    )?.recognition?.sourceId;
    return (
      options.find((o) => o.value === pendingSource && !o.disabled)?.value ||
      options.find(
        (o) =>
          o.value === state.settings.recognition.defaultSourceId && !o.disabled,
      )?.value ||
      "bangumi"
    );
  });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(
    () =>
      new Set(
        state.works
          .filter((w) => available(w) && !busy(w) && incomplete(w))
          .map((w) => w.id),
      ),
  );
  const [submitted, setSubmitted] = useState(() =>
    state.works
      .filter((w) => w.recognition?.requested && busy(w))
      .map((w) => w.id),
  );
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const rows = state.works.filter((w) =>
    w.title.toLowerCase().includes(query.toLowerCase()),
  );
  const submittedIds = new Set(submitted);
  const pending = state.works.filter((w) => submittedIds.has(w.id) && busy(w));
  const running = submitting || !!pending.length;
  const selectable = rows.filter((w) => available(w) && !busy(w));
  const checked = selectable.filter((w) => selected.has(w.id)).length;
  const ids = state.works
    .filter((w) => selected.has(w.id) && available(w) && !busy(w))
    .map((w) => w.id);
  const setMany = (enabled: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      selectable.forEach((w) => (enabled ? next.add(w.id) : next.delete(w.id)));
      return next;
    });
  return (
    <Modal
      open
      title={t("batchRecognition")}
      onClose={onClose}
      className="batch-recognition-modal"
      footer={
        <>
          {submitted.length > 0 && (
            <span className="modal-status muted" role="status">
              {t("batchRecognitionProgress")
                .replace("{done}", String(submitted.length - pending.length))
                .replace("{total}", String(submitted.length))}
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t("close")}
          </Button>
          {pending.length ? (
            <Button
              variant="secondary"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void window.tamki
                  .library("cancel-recognition-batch", {
                    workIds: pending.map((w) => w.id),
                  })
                  .catch((e) => toast.error(errorMessage(e, t)))
                  .finally(() => setCancelling(false));
              }}
            >
              {t("batchRecognitionCancel")}
            </Button>
          ) : (
            <Button
              disabled={
                running ||
                !ids.length ||
                !options.some((o) => o.value === source && !o.disabled)
              }
              onClick={() => {
                setSubmitting(true);
                void window.tamki
                  .library<{ queued: string[]; skipped: number }>(
                    "recognize-batch",
                    { workIds: ids, sourceId: source },
                  )
                  .then((result) => {
                    setSubmitted(result.queued);
                    if (result.skipped)
                      toast(
                        t("batchRecognitionSkipped").replace(
                          "{n}",
                          String(result.skipped),
                        ),
                      );
                  })
                  .catch((e) => toast.error(errorMessage(e, t)))
                  .finally(() => setSubmitting(false));
              }}
            >
              {t("batchRecognitionStart").replace("{n}", String(ids.length))}
            </Button>
          )}
        </>
      }
    >
      <div className="modal-body batch-recognition-body">
        <FieldGroup>
          <FormField label={t("recognitionSource")}>
            <Choice
              label={t("recognitionSource")}
              value={source}
              options={options}
              onChange={setSource}
              disabled={running}
            />
          </FormField>
          <p className="muted">{t("batchRecognitionHelp")}</p>
          <Search value={query} onChange={setQuery} label={t("search")} />
          <FieldSet>
            <FieldLegend className="sr-only">{t("seriesMembers")}</FieldLegend>
            <div className="batch-recognition-controls">
              <Field orientation="horizontal">
                <Checkbox
                  id="batch-recognition-all"
                  checked={
                    !!selectable.length && checked === selectable.length
                      ? true
                      : checked
                        ? "indeterminate"
                        : false
                  }
                  disabled={running || !selectable.length}
                  onCheckedChange={(value) => setMany(value === true)}
                />
                <FieldLabel htmlFor="batch-recognition-all">
                  {t("batchRecognitionAll")}
                </FieldLabel>
              </Field>
              <Button
                variant="ghost"
                size="sm"
                disabled={running}
                onClick={() =>
                  setSelected(
                    new Set(
                      rows
                        .filter(
                          (w) => available(w) && !busy(w) && incomplete(w),
                        )
                        .map((w) => w.id),
                    ),
                  )
                }
              >
                {t("batchRecognitionMissing")}
              </Button>
            </div>
            {rows.length ? (
              rows.map((work) => (
                <Field
                  key={work.id}
                  orientation="horizontal"
                  className="batch-recognition-row"
                >
                  <Checkbox
                    id={`batch-work-${work.id}`}
                    checked={selected.has(work.id)}
                    disabled={running || busy(work) || !available(work)}
                    onCheckedChange={(value) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        value === true
                          ? next.add(work.id)
                          : next.delete(work.id);
                        return next;
                      })
                    }
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={`batch-work-${work.id}`}>
                      <TextTip>{work.title}</TextTip>
                    </FieldLabel>
                    <FieldDescription>
                      {[
                        !work.cover && t("batchRecognitionNoCover"),
                        !work.description && t("batchRecognitionNoDescription"),
                        work.recognition?.error &&
                          errorMessage(new Error(work.recognition.error), t),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </FieldDescription>
                  </FieldContent>
                  {work.recognition?.status === "needs-choice" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onInspect(work.id)}
                    >
                      {t("autoChoice")}
                    </Button>
                  ) : (
                    <Badge variant="secondary">
                      {work.recognition
                        ? t(labels[work.recognition.status])
                        : t("batchRecognitionUnstarted")}
                    </Badge>
                  )}
                </Field>
              ))
            ) : (
              <Blank title={t("noResults")} />
            )}
          </FieldSet>
        </FieldGroup>
      </div>
    </Modal>
  );
}
