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
} from "../shared/organization";
import {
  Button,
  Choice,
  Fade,
  FormField,
  HelpTip,
  IconButton,
  Modal,
  PageHeader,
  TextTip,
  Blank,
} from "./common";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";

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
      });
      if (!alive.current || job.current !== jobId) return;
      setPlan(result);
      previewJob.current = result.jobId;
      setFeedbackOpen(
        result.groups.some((g) => g.review) ||
          result.collections.some((c) => c.review) ||
          result.unassigned.length > 0,
      );
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
          titles: plan.groups.map((g) => ({ id: g.id, title: names[g.id] })),
        },
      );
      if (!alive.current || job.current !== jobId) return;
      setPlan(result);
      previewJob.current = result.jobId;
      job.current = result.jobId;
      setNames(Object.fromEntries(result.groups.map((g) => [g.id, g.title])));
      setSelected(result.groups.filter((g) => !g.review).map((g) => g.id));
      setCollections(
        result.collections.filter((c) => !c.review).map((c) => c.id),
      );
      setExpanded([]);
      setFeedback("");
      setFeedbackOpen(
        result.groups.some((g) => g.review) ||
          result.collections.some((c) => c.review) ||
          result.unassigned.length > 0,
      );
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
          groups: selected.map((id) => ({ id, title: names[id] })),
          collectionIds: collections.filter((id) =>
            plan.collections
              .find((c) => c.id === id)
              ?.groupIds.every((id) => selected.includes(id)),
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
  const flaggedCount = plan
    ? plan.groups.filter((g) => g.review).length +
      plan.collections.filter((c) => c.review).length +
      (plan.unassigned.length ? 1 : 0)
    : 0;
  if (plan)
    return (
      <Tabs defaultValue="works" className="page organization-page">
        <PageHeader
          title={t("smartOrganize")}
          back={() => {
            cancel();
            onBack();
          }}
          sub={
            <TabsList>
              <TabsTrigger value="works">
                {t("organizationWorks")} · {plan.groups.length}
              </TabsTrigger>
              <TabsTrigger value="series">
                {t("series")} ·{" "}
                {plan.collections.filter((c) => c.kind === "series").length}
              </TabsTrigger>
              <TabsTrigger value="collections">
                {t("organizationCollections")} ·{" "}
                {plan.collections.filter((c) => c.kind !== "series").length}
              </TabsTrigger>
              <TabsTrigger value="unassigned">
                {t("organizationUnassigned")} · {plan.unassigned.length}
              </TabsTrigger>
            </TabsList>
          }
        >
          {error && (
            <span role="alert" className="organization-error">
              {error}
            </span>
          )}
          <Button
            variant="secondary"
            disabled={!!activity}
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
              !selected.length ||
              selected.some((id) => !names[id]?.trim())
            }
            onClick={() => setConfirm(true)}
          >
            {t("organizationApply")}
          </Button>
        </PageHeader>
        <Fade className="page-body">
          <TabsContent value="works">
            {!plan.groups.length ? (
              <Blank title={t("organizationNoGroups")} />
            ) : (
              plan.groups.map((g) => (
                <section className="organization-group" key={g.id}>
                  <div className="organization-group-heading">
                    <Checkbox
                      aria-label={g.title}
                      checked={selected.includes(g.id)}
                      disabled={!!activity}
                      onCheckedChange={() =>
                        setSelected((s) => toggle(s, g.id))
                      }
                    />
                    <Input
                      aria-label={`${t("promptTitle")} · ${g.title}`}
                      value={names[g.id]}
                      disabled={!!activity}
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
                    {g.review && (
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
                    const usable = c.groupIds.every((id) =>
                      selected.includes(id),
                    );
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
                        <div>
                          <FieldLabel htmlFor={`organization-${c.id}`}>
                            {c.name}
                          </FieldLabel>
                          {!usable && (
                            <HelpTip
                              text={t("organizationUnselectedMembers").replace(
                                "{names}",
                                c.groupIds
                                  .filter((id) => !selected.includes(id))
                                  .map(
                                    (id) =>
                                      names[id] ||
                                      plan.groups.find((g) => g.id === id)
                                        ?.title ||
                                      id,
                                  )
                                  .join("、"),
                              )}
                            />
                          )}

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
                                  ?.groupIds.every((g) => selected.includes(g)),
                              ),
                            ).map((member) => (
                              <Badge
                                key={member.id}
                                variant="secondary"
                                className={
                                  !member.groupIds.every((id) =>
                                    selected.includes(id),
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
                        </div>
                      </Field>
                    );
                  })
              )}
            </TabsContent>
          ))}
          <TabsContent value="unassigned">
            {plan.unassigned.length ? (
              fileList(plan.unassigned)
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
              {plan.groups
                .filter((g) => g.review)
                .map((g) => (
                  <section key={g.id}>
                    <strong>{names[g.id] || g.title}</strong>
                    <p>{g.reason || t("organizationReview")}</p>
                  </section>
                ))}
              {plan.collections
                .filter((c) => c.review)
                .map((c) => (
                  <section key={c.id}>
                    <strong>{c.name}</strong>
                    <p>{t("organizationReview")}</p>
                  </section>
                ))}
              {plan.unassigned.length > 0 && (
                <section>
                  <strong>{t("organizationUnassigned")}</strong>
                  <p>
                    {t("organizationFiles").replace(
                      "{count}",
                      String(plan.unassigned.length),
                    )}
                  </p>
                </section>
              )}
              {!plan.groups.some((g) => g.review) &&
                !plan.collections.some((c) => c.review) &&
                !plan.unassigned.length && (
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
            <p className="modal-body">{t("organizationApplyBody")}</p>
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
