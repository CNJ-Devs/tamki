import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CircleNotchIcon,
} from "@phosphor-icons/react";
import { organizationMembers } from "../shared/organization";
import type { LibraryState } from "../shared/model";
import type { ModelOption } from "../shared/settings";
import { usesAccount } from "../shared/settings";
import type {
  OrganizationPlan,
  OrganizationProgress,
  OrganizationLiveChanges,
  OrganizationFile,
} from "../shared/organization";
import {
  Button,
  Choice,
  Fade,
  FormField,
  HelpTip,
  HorizontalScroll,
  IconButton,
  Modal,
  PageHeader,
  TextTip,
  Blank,
} from "./common";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "./components/ui/field";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";

function hasReviewQuestions(plan: OrganizationPlan) {
  const deferred = new Set(plan.liveChanges?.conflictingGroupIds);
  return (
    plan.groups.some((g) => g.review && !deferred.has(g.id)) ||
    plan.collections.some(
      (c) => c.review && !c.groupIds.some((id) => deferred.has(id)),
    ) ||
    plan.unassigned.some((id) => !plan.fileExclusions?.includes(id))
  );
}

export function OrganizationPage({
  state,
  onBack,
  onSettings,
}: {
  state: LibraryState;
  onBack(): void;
  onSettings(): void;
}) {
  const t = useI18n();
  const saved = state.settings.organization;
  const [mode, setMode] = useState<"incremental" | "full">("incremental");
  const [fileExclusions, setFileExclusions] = useState<string[]>([]);
  const [relationshipRemovals, setRelationshipRemovals] = useState<string[]>(
    [],
  );
  const [liveChanges, setLiveChanges] = useState<OrganizationLiveChanges>();
  const [acknowledgedRemovals, setAcknowledgedRemovals] = useState<string[]>(
    [],
  );
  const connections = state.settings.aiConnections || [];
  const [connectionId, setConnectionId] = useState(saved?.connectionId || "");
  const connection = connections.find((c) => c.id === connectionId);
  const [model, setModel] = useState(saved?.model || ""),
    [models, setModels] = useState<ModelOption[]>(connection?.models || []);
  const [webSearch, setWebSearch] = useState(saved?.webSearch || false),
    [instructions, setInstructions] = useState(saved?.instructions || "");
  const roots = state.connections.flatMap((c) =>
    c.roots.map((path) => ({
      connectionId: c.id,
      path,
      key: JSON.stringify([c.id, path]),
      name: c.name,
      depth: c.scanDepths?.[path] ?? 1,
    })),
  );
  const [selectedRoots, setSelectedRoots] = useState(() =>
    roots.map((r) => r.key),
  );
  const [activity, setActivity] = useState<
    "models" | "organize" | "refine" | "apply" | null
  >(null);
  const [plan, setPlan] = useState<OrganizationPlan | null>(null),
    [progress, setProgress] = useState<OrganizationProgress | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [collections, setCollections] = useState<string[]>([]),
    [names, setNames] = useState<Record<string, string>>({}),
    [expanded, setExpanded] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false),
    [error, setError] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const previewJob = useRef<string | null>(null);
  const job = useRef<string | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (previewJob.current && previewJob.current !== job.current)
        void window.tamki
          .library("organize-cancel", previewJob.current)
          .catch(() => {});
      if (job.current)
        void window.tamki
          .library("organize-cancel", job.current)
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (activity !== "organize" && activity !== "refine") return;
    let active = true;
    const timer = setInterval(() => {
      if (job.current)
        void window.tamki
          .library<OrganizationProgress | null>(
            "organize-progress",
            job.current,
          )
          .then((p) => {
            if (active) setProgress(p);
          })
          .catch(() => {});
    }, 700);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activity]);
  useEffect(() => {
    let active = true;
    void window.tamki
      .library<OrganizationPlan | null>("organize-draft")
      .then((result) => {
        if (!active || !result?.jobId || job.current) return;
        setPlan(result);
        previewJob.current = result.jobId;
        job.current = result.jobId;
        setSelected(
          result.reviewSelection?.groups ||
            result.groups.filter((g) => !g.review).map((g) => g.id),
        );
        setCollections(
          result.reviewSelection?.collections ||
            result.collections.filter((c) => !c.review).map((c) => c.id),
        );
        setNames({
          ...Object.fromEntries(result.groups.map((g) => [g.id, g.title])),
          ...result.reviewSelection?.names,
        });
        setAcknowledgedRemovals(
          result.reviewSelection?.acknowledgedRemovals || [],
        );
        setFileExclusions(
          result.reviewSelection?.fileExclusions || result.fileExclusions || [],
        );
        setRelationshipRemovals(
          result.reviewSelection?.relationshipRemovals ||
            result.relationshipRemovals?.map((r) => r.id) ||
            [],
        );
        setLiveChanges(result.liveChanges);
        if (result.scopes)
          setSelectedRoots(
            roots
              .filter((r) =>
                result.scopes!.some(
                  (s) => s.connectionId === r.connectionId && s.path === r.path,
                ),
              )
              .map((r) => r.key),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!plan || activity) return;
    let active = true;
    const timer = setInterval(() => {
      void window.tamki
        .library<OrganizationProgress | null>("organize-progress", plan.jobId)
        .then((p) => {
          if (active && p?.changes) setLiveChanges(p.changes);
        })
        .catch(() => {});
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [plan?.jobId, activity]);
  useEffect(() => {
    if (!plan || activity || Object.values(names).some((n) => !n.trim()))
      return;
    const timer = setTimeout(() => {
      void window.tamki
        .library("organize-review", {
          jobId: plan.jobId,
          groups: selected,
          collections,
          names,
          acknowledgedRemovals,
          relationshipRemovals,
          fileExclusions,
        })
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [
    plan?.jobId,
    activity,
    selected,
    collections,
    names,
    acknowledgedRemovals,
    relationshipRemovals,
    fileExclusions,
  ]);
  const usable =
    !!connection &&
    (usesAccount(connection.provider)
      ? connection.account?.status === "connected"
      : connection.auth === "none" || connection.hasKey);
  const canSearch =
    connection?.provider !== "openai-compatible" ||
    connection?.protocol === "responses";
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((v) => v !== value)
      : [...values, value];
  const load = async () => {
    setActivity("models");
    setError("");
    try {
      const list = await window.tamki.library<ModelOption[]>(
        "ai-feature-models",
        connectionId,
      );
      if (!alive.current) return;
      setModels(list);
      if (!list.some((m) => m.id === model)) setModel("");
    } catch (e) {
      if (alive.current) setError(errorMessage(e, t));
    } finally {
      if (alive.current) setActivity(null);
    }
  };
  const generate = async () => {
    const selected = roots
      .filter((r) => selectedRoots.includes(r.key))
      .map(({ connectionId, path }) => ({ connectionId, path }));
    if (!selected.length) {
      setError(t("organizationChooseFolders"));
      return;
    }
    setError("");
    setActivity("organize");
    setProgress({ phase: "scanning", completed: 0, total: selected.length });
    const jobId = crypto.randomUUID();
    job.current = jobId;
    try {
      const result = await window.tamki.library<OrganizationPlan>("organize", {
        jobId,
        connectionId,
        model,
        webSearch: canSearch && webSearch,
        instructions,
        roots: selected,
        mode,
      });
      if (!alive.current || job.current !== jobId) return;
      setPlan(result);
      setLiveChanges(result.liveChanges);
      setAcknowledgedRemovals([]);
      setFileExclusions(result.fileExclusions || []);
      setRelationshipRemovals(
        result.relationshipRemovals?.map((r) => r.id) || [],
      );
      previewJob.current = result.jobId;
      setFeedbackOpen(hasReviewQuestions(result));
      setSelected(result.groups.filter((g) => !g.review).map((g) => g.id));
      setCollections(
        result.collections.filter((c) => !c.review).map((c) => c.id),
      );
      setNames(Object.fromEntries(result.groups.map((g) => [g.id, g.title])));
    } catch (e) {
      if (alive.current && job.current === jobId) {
        setError(errorMessage(e, t));
        job.current = null;
      }
    } finally {
      if (alive.current) setActivity(null);
    }
  };
  const cancel = () => {
    if (job.current)
      void window.tamki
        .library("organize-cancel", job.current)
        .catch((e) => toast.error(errorMessage(e, t)));
  };
  const refine = async () => {
    if (!plan || !feedback.trim()) return;
    const previousJobId = plan.jobId;
    const jobId = crypto.randomUUID();
    job.current = jobId;
    setActivity("refine");
    setError("");
    setProgress({ phase: "grouping", completed: 0, total: 1 });
    try {
      const result = await window.tamki.library<OrganizationPlan>(
        "organize-refine",
        {
          jobId,
          previousJobId,
          feedback,
          titles: plan.groups
            .filter((g) => !g.referenceOnly)
            .map((g) => ({ id: g.id, title: names[g.id] })),
        },
      );
      if (!alive.current || job.current !== jobId) return;
      setPlan(result);
      setLiveChanges(result.liveChanges);
      setAcknowledgedRemovals([]);
      setFileExclusions(result.fileExclusions || []);
      setRelationshipRemovals(
        result.relationshipRemovals?.map((r) => r.id) || [],
      );
      previewJob.current = result.jobId;
      job.current = result.jobId;
      setNames(Object.fromEntries(result.groups.map((g) => [g.id, g.title])));
      setSelected(result.groups.filter((g) => !g.review).map((g) => g.id));
      setCollections(
        result.collections.filter((c) => !c.review).map((c) => c.id),
      );
      setExpanded([]);
      setFeedback("");
      setFeedbackOpen(hasReviewQuestions(result));
    } catch (e) {
      if (alive.current) {
        job.current = previousJobId;
        setError(errorMessage(e, t));
      }
    } finally {
      if (alive.current) setActivity(null);
    }
  };
  const restart = () => {
    cancel();
    job.current = null;
    setPlan(null);
    setLiveChanges(undefined);
    setAcknowledgedRemovals([]);
    setRelationshipRemovals([]);
    setFileExclusions([]);
    previewJob.current = null;
    setFeedbackOpen(false);
    setFeedback("");
    setError("");
  };
  const apply = async () => {
    if (!plan) return;
    setConfirm(false);
    setActivity("apply");
    setError("");
    try {
      const result = await window.tamki.library<{ works: number }>(
        "organize-apply",
        {
          jobId: plan.jobId,
          acknowledgedRemovals: safeRemovals,
          relationshipRemovalIds: relationshipRemovals,
          fileExclusionIds: fileExclusions,
          groups: safeSelected.map((id) => ({ id, title: names[id] })),
          collectionIds: collections.filter((id) =>
            plan.collections
              .find((c) => c.id === id)
              ?.groupIds.every((id) => safeSelected.includes(id)),
          ),
        },
      );
      if (!alive.current) return;
      job.current = null;
      toast.success(
        t("organizationApplied").replace("{count}", String(result.works)),
      );
      onBack();
    } catch (e) {
      if (alive.current) setError(errorMessage(e, t));
    } finally {
      if (alive.current) setActivity(null);
    }
  };
  const fileList = (ids: string[]) => (
    <div className="organization-files">
      {ids.map((id) => {
        const file = plan!.files.find((f) => f.id === id)!;
        return (
          <div className="organization-file" key={id}>
            <TextTip>{file.name}</TextTip>
            <span className="muted truncate">
              <TextTip>{file.currentTitle || t("organizationNewWork")}</TextTip>
            </span>
            <span className="muted truncate">
              <TextTip>{`${state.connections.find((c) => c.id === file.connectionId)?.name || ""} · ${file.relativePath}`}</TextTip>
            </span>
          </div>
        );
      })}
    </div>
  );
  const changeFiles = (files: OrganizationFile[], removed = false) => (
    <FieldGroup>
      {files.map((file) => (
        <Field key={file.id} orientation="horizontal">
          {removed && (
            <Checkbox
              aria-label={`${t("organizationAcknowledgeRemoval")} · ${file.name}`}
              checked={safeRemovals.includes(file.id)}
              onCheckedChange={() =>
                setAcknowledgedRemovals((s) => toggle(s, file.id))
              }
              disabled={
                !!activity ||
                !!liveChanges?.deferredRemovalIds.includes(file.id)
              }
            />
          )}
          <div className="min-w-0 flex-1">
            <TextTip>{file.name}</TextTip>
            <div className="muted">
              <TextTip>{file.relativePath}</TextTip>
            </div>
          </div>
        </Field>
      ))}
    </FieldGroup>
  );
  const blocked = !!liveChanges?.blocked;
  const deferred =
    plan?.groups.filter((g) =>
      liveChanges?.conflictingGroupIds.includes(g.id),
    ) || [];
  const safeSelected = selected.filter(
    (id) => !liveChanges?.conflictingGroupIds.includes(id),
  );
  const safeRemovals = acknowledgedRemovals.filter(
    (id) => !liveChanges?.deferredRemovalIds.includes(id),
  );
  useEffect(() => {
    if (!plan || !liveChanges) return;
    setSelected((s) =>
      s.filter((id) => !liveChanges.conflictingGroupIds.includes(id)),
    );
    setAcknowledgedRemovals((s) =>
      s.filter((id) => !liveChanges.deferredRemovalIds.includes(id)),
    );
  }, [
    plan?.jobId,
    liveChanges?.conflictingGroupIds.join("|"),
    liveChanges?.deferredRemovalIds.join("|"),
  ]);
  const unresolvedUnassigned =
    plan?.unassigned.filter((id) => !fileExclusions.includes(id)) || [];
  const reviewGroups =
    plan?.groups.filter(
      (g) => g.review && !deferred.some((d) => d.id === g.id),
    ) || [];
  const reviewRelationships =
    plan?.collections.filter(
      (c) =>
        c.review && !c.groupIds.some((id) => deferred.some((d) => d.id === id)),
    ) || [];
  const flaggedCount = plan
    ? reviewGroups.length +
      reviewRelationships.length +
      (unresolvedUnassigned.length ? 1 : 0)
    : 0;
  if (plan)
    return (
      <Tabs
        defaultValue={
          plan.groups.some((g) => !g.referenceOnly) ? "works" : "changes"
        }
        className="page organization-page"
      >
        <PageHeader
          title={t("smartOrganize")}
          back={() => {
            cancel();
            onBack();
          }}
          sub={
            <HorizontalScroll>
              <TabsList>
                <TabsTrigger value="works">
                  {t("organizationWorks")} ·{" "}
                  {plan.groups.filter((g) => !g.referenceOnly).length}
                </TabsTrigger>
                <TabsTrigger value="series">
                  {t("series")} ·{" "}
                  {plan.collections.filter((c) => c.kind === "series").length}
                </TabsTrigger>
                <TabsTrigger value="collections">
                  {t("organizationCollections")} ·{" "}
                  {plan.collections.filter((c) => c.kind !== "series").length}
                </TabsTrigger>
                {!!deferred.length && (
                  <TabsTrigger value="deferred">
                    {t("organizationDeferred")} ·{" "}
                    {deferred.filter((g) => !g.referenceOnly).length}
                  </TabsTrigger>
                )}
                {plan.delta && (
                  <TabsTrigger value="changes">
                    {t("organizationChanges")}
                  </TabsTrigger>
                )}
                <TabsTrigger value="unassigned">
                  {t("organizationUnassigned")} · {unresolvedUnassigned.length}
                </TabsTrigger>
              </TabsList>
            </HorizontalScroll>
          }
        >
          {error && (
            <span role="alert" className="organization-error">
              {error}
            </span>
          )}
          <Button
            variant="secondary"
            disabled={!!activity || !plan.files.length}
            onClick={() => setFeedbackOpen(true)}
          >
            {t("organizationFeedback")}
          </Button>
          <Button variant="secondary" disabled={!!activity} onClick={restart}>
            {t("organizationRegenerate")}
          </Button>
          <Button
            disabled={
              !!activity ||
              (!safeSelected.some(
                (id) => !plan.groups.find((g) => g.id === id)?.referenceOnly,
              ) &&
                !safeRemovals.length &&
                !relationshipRemovals.length &&
                !fileExclusions.length) ||
              safeSelected.some((id) => !names[id]?.trim())
            }
            onClick={() => setConfirm(true)}
          >
            {t("organizationApply")}
          </Button>
        </PageHeader>
        <Fade className="page-body">
          {plan.delta && (
            <p className="organization-review-summary" role="status">
              {t("organizationDeltaSummary")
                .replace("{pending}", String(plan.delta.pendingFiles))
                .replace("{unchanged}", String(plan.delta.unchangedFiles))}
            </p>
          )}
          {liveChanges && !!liveChanges.added.length && (
            <p className="organization-review-summary" role="status">
              {t("organizationLiveAdded").replace(
                "{count}",
                String(liveChanges.added.length),
              )}
            </p>
          )}
          {blocked && (
            <p className="organization-error" role="alert">
              {t(
                safeSelected.some(
                  (id) => !plan.groups.find((g) => g.id === id)?.referenceOnly,
                ) || safeRemovals.length
                  ? "organizationDeferredSummary"
                  : "organizationAllDeferred",
              ).replace(
                "{count}",
                String(deferred.filter((g) => !g.referenceOnly).length),
              )}
            </p>
          )}
          {plan.delta && (
            <TabsContent value="changes">
              <FieldGroup>
                <p className="muted">
                  {t("organizationBaselineHelp")}
                  {plan.delta.reviewedAt
                    ? " · " + new Date(plan.delta.reviewedAt).toLocaleString()
                    : ""}
                </p>
                {!plan.delta.pendingFiles && !plan.delta.removed.length && (
                  <Blank title={t("organizationNoChanges")} />
                )}
                {!!plan.delta.added.length && (
                  <section>
                    <h3>
                      {t("organizationAdded")} · {plan.delta.added.length}
                    </h3>
                    {changeFiles(plan.delta.added)}
                  </section>
                )}
                {!!plan.delta.modified.length && (
                  <section>
                    <h3>
                      {t("organizationModified")} · {plan.delta.modified.length}
                    </h3>
                    {changeFiles(plan.delta.modified)}
                  </section>
                )}
                {!!plan.fileExclusions?.length && (
                  <section>
                    <h3>{t("organizationFileExclusions")}</h3>
                    <p className="muted">
                      {t("organizationFileExclusionHelp")}
                    </p>
                    {plan.fileExclusions.map((id) => {
                      const file = plan.files.find((f) => f.id === id)!;
                      return (
                        <Field key={id} orientation="horizontal">
                          <Checkbox
                            aria-label={t("organizationExcludeFile").replace(
                              "{name}",
                              file.name,
                            )}
                            checked={fileExclusions.includes(id)}
                            disabled={!!activity}
                            onCheckedChange={() =>
                              setFileExclusions((s) => toggle(s, id))
                            }
                          />
                          <TextTip>{file.relativePath}</TextTip>
                        </Field>
                      );
                    })}
                  </section>
                )}
                {!!plan.relationshipRemovals?.length && (
                  <section>
                    <h3>{t("organizationRelationshipRemovals")}</h3>
                    <p className="muted">
                      {t("organizationRelationshipRemovalHelp")}
                    </p>
                    {plan.relationshipRemovals.map((r) => (
                      <Field key={r.id} orientation="horizontal">
                        <Checkbox
                          aria-label={t(
                            "organizationRemoveRelationship",
                          ).replace("{name}", r.name)}
                          checked={relationshipRemovals.includes(r.id)}
                          disabled={!!activity}
                          onCheckedChange={() =>
                            setRelationshipRemovals((s) => toggle(s, r.id))
                          }
                        />
                        <span>{r.name}</span>
                      </Field>
                    ))}
                  </section>
                )}
                {!!plan.delta.removed.length && (
                  <section>
                    <h3>
                      {t("organizationRemoved")} · {plan.delta.removed.length}
                    </h3>
                    <p className="muted">{t("organizationRemovalHelp")}</p>
                    {changeFiles(plan.delta.removed, true)}
                  </section>
                )}
              </FieldGroup>
            </TabsContent>
          )}
          {!!deferred.length && (
            <TabsContent value="deferred">
              <FieldGroup>
                <p className="muted">{t("organizationDeferredHelp")}</p>
                {deferred
                  .filter((g) => !g.referenceOnly)
                  .map((g) => (
                    <section key={g.id}>
                      <h3>{names[g.id] || g.title}</h3>
                      {fileList(g.fileIds)}
                    </section>
                  ))}
              </FieldGroup>
            </TabsContent>
          )}
          <TabsContent value="works">
            {!plan.groups.some((g) => !g.referenceOnly) ? (
              <Blank title={t("organizationNoGroups")} />
            ) : (
              plan.groups
                .filter((g) => !g.referenceOnly)
                .map((g) => (
                  <section className="organization-group" key={g.id}>
                    <div className="organization-group-heading">
                      <Checkbox
                        aria-label={g.title}
                        checked={safeSelected.includes(g.id)}
                        disabled={
                          !!activity || deferred.some((d) => d.id === g.id)
                        }
                        onCheckedChange={() =>
                          setSelected((s) => toggle(s, g.id))
                        }
                      />
                      <Input
                        aria-label={`${t("promptTitle")} · ${g.title}`}
                        value={names[g.id]}
                        disabled={
                          !!activity || deferred.some((d) => d.id === g.id)
                        }
                        maxLength={500}
                        onChange={(e) =>
                          setNames((n) => ({ ...n, [g.id]: e.target.value }))
                        }
                      />
                      <span className="muted organization-count">
                        {g.episodes
                          ? t("episodeVersionCount")
                              .replace("{episodes}", String(g.episodes.length))
                              .replace(
                                "{versions}",
                                String(
                                  g.episodes.reduce(
                                    (n, e) => n + e.versions.length,
                                    0,
                                  ),
                                ),
                              )
                              .replace("{files}", String(g.fileIds.length))
                          : t("organizationFiles").replace(
                              "{count}",
                              String(g.fileIds.length),
                            )}
                      </span>
                      {deferred.some((d) => d.id === g.id) && (
                        <Badge variant="secondary">
                          {t("organizationDeferred")}
                        </Badge>
                      )}
                      {g.review && !deferred.some((d) => d.id === g.id) && (
                        <Badge variant="secondary">
                          {t("organizationReview")}
                        </Badge>
                      )}
                      {g.reason && <HelpTip text={g.reason} />}
                      <IconButton
                        label={t("organizationDetails")}
                        aria-expanded={expanded.includes(g.id)}
                        onClick={() => setExpanded((s) => toggle(s, g.id))}
                      >
                        {expanded.includes(g.id) ? (
                          <CaretDownIcon />
                        ) : (
                          <CaretRightIcon />
                        )}
                      </IconButton>
                    </div>
                    {g.changes && (
                      <div className="organization-diff">
                        {g.changes.title &&
                          g.changes.previousTitles.length > 0 && (
                            <span className="muted truncate">
                              <TextTip>{`${t("organizationPreviously")} · ${g.changes.previousTitles.join(" / ")}`}</TextTip>
                            </span>
                          )}
                        {g.changes.membership && (
                          <Badge variant="secondary">
                            {t("organizationMembershipChanged")}
                          </Badge>
                        )}
                        {g.changes.order && (
                          <Badge variant="secondary">
                            {t("organizationOrderChanged")}
                          </Badge>
                        )}
                        {g.changes.versions && (
                          <Badge variant="secondary">
                            {t("organizationVersionGrouping")}
                          </Badge>
                        )}
                        {g.changes.manual && (
                          <Badge variant="outline">
                            {t("organizationManualChanged")}
                          </Badge>
                        )}
                      </div>
                    )}
                    {expanded.includes(g.id) &&
                      (g.episodes ? (
                        <div className="organization-episodes">
                          {g.episodes.map((e, i) => (
                            <div key={i} className="organization-episode">
                              <strong>
                                {[e.number, e.title]
                                  .filter(Boolean)
                                  .join(" · ") || String(i + 1)}
                              </strong>
                              {e.versions.map((v, n) => (
                                <div key={n} className="organization-version">
                                  <span className="muted">
                                    {v.label ||
                                      t("versionNumber").replace(
                                        "{n}",
                                        String(n + 1),
                                      )}
                                  </span>
                                  {fileList(v.fileIds)}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : (
                        fileList(g.fileIds)
                      ))}
                  </section>
                ))
            )}
          </TabsContent>
          {(["series", "collection"] as const).map((kind) => (
            <TabsContent
              key={kind}
              value={kind === "series" ? "series" : "collections"}
            >
              {!plan.collections.some(
                (c) => (c.kind || "collection") === kind,
              ) ? (
                <Blank
                  title={t(
                    kind === "series"
                      ? "organizationNoSeries"
                      : "organizationNoCollections",
                  )}
                />
              ) : (
                plan.collections
                  .filter((c) => (c.kind || "collection") === kind)
                  .map((c) => {
                    const deferredMembers = c.groupIds.filter((id) =>
                      deferred.some((g) => g.id === id),
                    );
                    const unselectedMembers = c.groupIds.filter(
                      (id) =>
                        !safeSelected.includes(id) &&
                        !deferredMembers.includes(id),
                    );
                    const usable =
                      !deferredMembers.length && !unselectedMembers.length;
                    const memberNames = (ids: string[]) =>
                      ids
                        .map(
                          (id) =>
                            names[id] ||
                            plan.groups.find((g) => g.id === id)?.title ||
                            id,
                        )
                        .join("、");
                    const availability = [
                      deferredMembers.length
                        ? t("organizationDeferredMembers").replace(
                            "{names}",
                            memberNames(deferredMembers),
                          )
                        : "",
                      unselectedMembers.length
                        ? t("organizationUnselectedMembers").replace(
                            "{names}",
                            memberNames(unselectedMembers),
                          )
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <Field
                        key={c.id}
                        orientation="horizontal"
                        className="organization-collection"
                      >
                        <Checkbox
                          id={`organization-${c.id}`}
                          aria-label={c.name}
                          checked={collections.includes(c.id) && usable}
                          disabled={!!activity || !usable}
                          onCheckedChange={() =>
                            setCollections((s) => toggle(s, c.id))
                          }
                        />
                        <FieldContent>
                          <div className="organization-relationship-heading">
                            <FieldLabel htmlFor={`organization-${c.id}`}>
                              {c.name}
                            </FieldLabel>
                            {c.review && !deferredMembers.length && (
                              <Badge variant="secondary">
                                {t("organizationReview")}
                              </Badge>
                            )}
                            {!usable && (
                              <>
                                <Badge variant="secondary">
                                  {t(
                                    deferredMembers.length
                                      ? "organizationMembersDeferred"
                                      : "organizationMembersUnselected",
                                  )}
                                </Badge>
                                <HelpTip text={availability} />
                              </>
                            )}
                          </div>

                          {c.previousName && (
                            <span className="muted truncate">
                              <TextTip>{`${t("organizationPreviously")} · ${c.previousName}`}</TextTip>
                            </span>
                          )}
                          <div className="organization-tags">
                            {organizationMembers(
                              plan,
                              c,
                              collections.filter((id) =>
                                plan.collections
                                  .find((s) => s.id === id)
                                  ?.groupIds.every((g) =>
                                    safeSelected.includes(g),
                                  ),
                              ),
                            ).map((member) => (
                              <Badge
                                key={member.id}
                                variant="secondary"
                                className={
                                  !member.groupIds.every((id) =>
                                    safeSelected.includes(id),
                                  )
                                    ? "organization-muted"
                                    : undefined
                                }
                              >
                                <TextTip>
                                  {member.kind === "series"
                                    ? plan.collections.find(
                                        (s) => s.id === member.id,
                                      )!.name
                                    : names[member.id] ||
                                      plan.groups.find(
                                        (g) => g.id === member.id,
                                      )!.title}
                                </TextTip>
                                {member.kind === "series" && (
                                  <span className="muted">
                                    {" "}
                                    · {t("series")}
                                  </span>
                                )}
                              </Badge>
                            ))}
                          </div>
                        </FieldContent>
                      </Field>
                    );
                  })
              )}
            </TabsContent>
          ))}
          <TabsContent value="unassigned">
            {unresolvedUnassigned.length ? (
              fileList(unresolvedUnassigned)
            ) : (
              <Blank title={t("organizationNoUnassigned")} />
            )}
          </TabsContent>
        </Fade>
        {feedbackOpen && (
          <Modal
            open
            title={t("organizationFeedback")}
            className="organization-feedback-modal"
            onClose={() => {
              if (activity !== "refine") setFeedbackOpen(false);
            }}
            footer={
              <>
                <Button
                  variant="secondary"
                  onClick={() =>
                    activity === "refine" ? cancel() : setFeedbackOpen(false)
                  }
                >
                  {activity === "refine"
                    ? t("cancel")
                    : t("organizationInspectPlan")}
                </Button>
                <Button
                  onClick={() => void refine()}
                  disabled={
                    !!activity ||
                    !feedback.trim() ||
                    Object.values(names).some((n) => !n.trim())
                  }
                >
                  {activity === "refine" && (
                    <CircleNotchIcon className="spin" />
                  )}
                  {t(
                    activity === "refine"
                      ? "organizationRefining"
                      : "organizationRefine",
                  )}
                </Button>
              </>
            }
          >
            <Fade className="organization-feedback-issues">
              {!!deferred.length && (
                <section>
                  <strong>
                    {t("organizationDeferred")} ·{" "}
                    {deferred.filter((g) => !g.referenceOnly).length}
                  </strong>
                  <p>{t("organizationDeferredFeedback")}</p>
                  <p>
                    {deferred
                      .filter((g) => !g.referenceOnly)
                      .map((g) => names[g.id] || g.title)
                      .join(" / ")}
                  </p>
                </section>
              )}
              {flaggedCount > 0 && (
                <div className="organization-review-summary">
                  <span>
                    {t("organizationFlaggedCount").replace(
                      "{count}",
                      String(flaggedCount),
                    )}
                  </span>
                  <HelpTip text={t("organizationReviewMeaning")} />
                </div>
              )}
              {reviewGroups.map((g) => (
                <section key={g.id}>
                  <strong>{names[g.id] || g.title}</strong>
                  <p>{g.reason || t("organizationReview")}</p>
                </section>
              ))}
              {reviewRelationships.map((c) => (
                <section key={c.id}>
                  <strong>{c.name}</strong>
                  <p>
                    {c.previousName
                      ? t("organizationRelationshipRename")
                          .replace("{before}", c.previousName)
                          .replace("{after}", c.name)
                      : t("organizationReview")}
                  </p>
                </section>
              ))}
              {unresolvedUnassigned.length > 0 && (
                <section>
                  <strong>{t("organizationUnassigned")}</strong>
                  <p>
                    {t("organizationFiles").replace(
                      "{count}",
                      String(unresolvedUnassigned.length),
                    )}
                  </p>
                </section>
              )}
              {!reviewGroups.length &&
                !reviewRelationships.length &&
                !unresolvedUnassigned.length && (
                  <p className="organization-feedback-empty muted">
                    {t("organizationNoQuestions")}
                    <HelpTip text={t("organizationReviewMeaning")} />
                  </p>
                )}
            </Fade>
            <Field className="organization-feedback-field">
              <FieldLabel htmlFor="organization-feedback">
                {t("organizationFeedbackLabel")}
              </FieldLabel>
              <Textarea
                id="organization-feedback"
                value={feedback}
                maxLength={8000}
                disabled={activity === "refine"}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder={t("organizationFeedbackPlaceholder")}
              />
            </Field>
            {error && (
              <p role="alert" className="organization-error">
                {error}
              </p>
            )}
          </Modal>
        )}
        {confirm && (
          <Modal
            open
            title={t("organizationApply")}
            onClose={() => setConfirm(false)}
            footer={
              <>
                <Button variant="secondary" onClick={() => setConfirm(false)}>
                  {t("cancel")}
                </Button>
                <Button onClick={() => void apply()}>
                  {t("organizationApply")}
                </Button>
              </>
            }
          >
            <div className="modal-body organization-apply-summary">
              <p>{t("organizationApplyBody")}</p>
              {!!deferred.length && (
                <p>
                  {t("organizationApplyDeferred").replace(
                    "{count}",
                    String(deferred.filter((g) => !g.referenceOnly).length),
                  )}
                </p>
              )}
              {!!safeRemovals.length && (
                <p>
                  {t("organizationApplyMissingFiles").replace(
                    "{count}",
                    String(safeRemovals.length),
                  )}
                </p>
              )}
              {!!fileExclusions.length && (
                <p>
                  {t("organizationApplyFileExclusions").replace(
                    "{count}",
                    String(fileExclusions.length),
                  )}
                </p>
              )}
              {!!relationshipRemovals.length && (
                <section>
                  <p>{t("organizationApplyRelationshipRemovals")}</p>
                  <ul>
                    {plan.relationshipRemovals
                      ?.filter((r) => relationshipRemovals.includes(r.id))
                      .map((r) => (
                        <li key={r.id}>
                          {t(r.kind === "series" ? "series" : "collections")}
                          {" · "}
                          <strong>{r.name}</strong>
                        </li>
                      ))}
                  </ul>
                  <p className="muted">
                    {t("organizationApplyRelationshipRetention")}
                  </p>
                </section>
              )}
              <p className="muted">{t("organizationApplySourceFiles")}</p>
            </div>
          </Modal>
        )}
      </Tabs>
    );
  return (
    <section className="page organization-page">
      <PageHeader
        title={t("smartOrganize")}
        back={() => {
          cancel();
          onBack();
        }}
      >
        {error && (
          <span role="alert" className="organization-error">
            {error}
          </span>
        )}
        <Button
          disabled={
            !!activity ||
            !usable ||
            !model ||
            !selectedRoots.length ||
            state.refreshing
          }
          onClick={() => void generate()}
        >
          {t("organizationGenerate")}
        </Button>
      </PageHeader>
      <Fade className="page-body">
        <div className="settings-content">
          <section>
            <div className="section-heading">
              <div className="field-title">
                <h2>{t("organizationScope")}</h2>
                <HelpTip text={t("organizationScopeHelp")} />
              </div>
            </div>
            {!roots.length ? (
              <Blank title={t("noSelectedRoots")} size="section">
                <Button variant="secondary" onClick={onSettings}>
                  {t("settings")}
                </Button>
              </Blank>
            ) : (
              <FieldGroup className="organization-roots">
                {roots.map((r) => (
                  <Field key={r.key} orientation="horizontal">
                    <Checkbox
                      id={`root-${roots.indexOf(r)}`}
                      checked={selectedRoots.includes(r.key)}
                      onCheckedChange={() =>
                        setSelectedRoots((s) => toggle(s, r.key))
                      }
                    />
                    <FieldLabel htmlFor={`root-${roots.indexOf(r)}`}>
                      <TextTip>{`${r.name} · ${r.path}`}</TextTip>
                    </FieldLabel>
                    <span className="muted organization-count">
                      {t("scanDepth")} · {r.depth}
                    </span>
                  </Field>
                ))}
              </FieldGroup>
            )}
          </section>
          <section>
            <FieldGroup>
              <FieldGroup className="organization-controls">
                <FormField label={t("organizationMode")}>
                  <Choice
                    label={t("organizationMode")}
                    value={mode}
                    disabled={!!activity}
                    onChange={(v) => setMode(v as "incremental" | "full")}
                    options={[
                      {
                        value: "incremental",
                        label: t("organizationIncremental"),
                      },
                      { value: "full", label: t("organizationFull") },
                    ]}
                  />
                </FormField>
                <FormField
                  label={t("aiConnection")}
                  htmlFor="organization-connection"
                >
                  <Choice
                    id="organization-connection"
                    label={t("aiConnection")}
                    value={connectionId}
                    placeholder={t(
                      connections.length
                        ? "chooseAIConnection"
                        : "noAIConnections",
                    )}
                    disabled={!!activity || !connections.length}
                    options={connections.map((c) => ({
                      value: c.id,
                      label: c.name,
                    }))}
                    onChange={(id) => {
                      setConnectionId(id);
                      setModel("");
                      setModels(
                        connections.find((c) => c.id === id)?.models || [],
                      );
                      setWebSearch(false);
                      setError("");
                    }}
                  />
                </FormField>
                <FormField label={t("model")} htmlFor="organization-model">
                  <div className="model-control">
                    <Choice
                      id="organization-model"
                      label={t("model")}
                      value={model}
                      disabled={!!activity || !usable}
                      options={models.map((m) => ({
                        value: m.id,
                        label: m.name,
                      }))}
                      onChange={setModel}
                    />
                    <Button
                      variant="secondary"
                      disabled={!!activity || !usable}
                      onClick={() => void load()}
                    >
                      <ArrowClockwiseIcon data-icon="inline-start" />
                      {t("loadModels")}
                    </Button>
                  </div>
                </FormField>
              </FieldGroup>
              {!usable && (
                <div>
                  <Button variant="secondary" onClick={onSettings}>
                    {t("manageAIConnections")}
                  </Button>
                </div>
              )}
              <Field orientation="horizontal">
                <Checkbox
                  id="organization-search"
                  disabled={!!activity || !usable || !canSearch}
                  checked={canSearch && webSearch}
                  onCheckedChange={(v) => setWebSearch(v === true)}
                />
                <div className="field-title">
                  <FieldLabel htmlFor="organization-search">
                    {t("webSearch")}
                  </FieldLabel>
                  <HelpTip text={t("organizationSearchHelp")} />
                </div>
              </Field>
              <FormField
                label={t("organizationPreferences")}
                htmlFor="organization-instructions"
              >
                <Textarea
                  id="organization-instructions"
                  value={instructions}
                  maxLength={2000}
                  placeholder={t("organizationPreferencesPlaceholder")}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </FormField>
            </FieldGroup>
          </section>
        </div>
      </Fade>
      {activity === "organize" && (
        <Modal
          open
          title={t("smartOrganize")}
          onClose={cancel}
          className="organization-loading"
          footer={
            <Button variant="secondary" onClick={cancel}>
              {t("cancel")}
            </Button>
          }
        >
          <div className="recognition-loading" role="status">
            <CircleNotchIcon className="spin" />
            <span>
              {t(
                progress?.phase === "reviewing"
                  ? "organizationReviewing"
                  : progress?.phase === "validating"
                    ? "organizationValidating"
                    : progress?.phase === "collections"
                      ? "organizationCollecting"
                      : progress?.phase === "grouping"
                        ? "organizationGrouping"
                        : "organizationScanning",
              )}
            </span>
            {progress?.files !== undefined && (
              <span className="muted">
                {t("organizationAnalyzingFiles").replace(
                  "{count}",
                  String(progress.files),
                )}
              </span>
            )}
            {progress && progress.total > 1 && (
              <span className="muted">
                {progress.completed} / {progress.total}
              </span>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
