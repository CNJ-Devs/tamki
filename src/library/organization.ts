import path from "node:path";
import { traced, logEvent } from "../diagnostics";
import { ProviderError } from "../providers/provider";
import type { Connection } from "../shared/model";
import {
  organizeRequestSchema,
  organizationApplySchema,
  organizationRefineSchema,
  organizationFileLimit,
  organizationReviewSelectionSchema,
  type OrganizationLiveChanges,
  type OrganizationContext,
  type OrganizationDirectory,
  type OrganizeRequest,
  type OrganizationFile,
  type OrganizationPlan,
  type OrganizationProgress,
} from "../shared/organization";
import { OrganizationInput } from "./organization-input";
import type { OrganizationSnapshot } from "./organization-state";
import {
  organizationDelta,
  organizationScopeKey,
  reviewedOrganizationFiles,
  type OrganizationCheckpoint,
} from "./organization-review";
import { analyzeOrganization } from "./organization-analysis";
import { compactOrganizationTask } from "./organization-compact-input";
import {
  columnarOrganizationTask,
  decodeColumnarOrganization,
  OrganizationColumnarError,
} from "./organization-columnar";
import type { StructuredTask } from "../providers/ai-recognition";
import { relativeDepth, scanScopes } from "./scan";
import { type LibraryStore } from "./store";
import type { SettingsService } from "./settings";
import type { StorageProvider } from "../providers/provider";
import { id } from "../shared/validation";

// Organization can outlast ordinary metadata lookups. Keep the caller's
// cancellation signal without imposing a fixed total-duration cutoff.

export class OrganizationService {
  private job?: {
    id: string;
    controller: AbortController;
    progress: OrganizationProgress;
  };
  private preview?: {
    plan: OrganizationPlan;
    baseline: OrganizationSnapshot;
    inventory: OrganizationFile[];
    directories: OrganizationDirectory[];
    expires: number;
    data: OrganizationInput;
    request: OrganizeRequest;
    feedback: string[];
  };
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(
    private store: LibraryStore,
    private settings: Pick<SettingsService, "featureRuntime" | "structured">,
    private provider: (connection: Connection) => Promise<StorageProvider>,
    private release: () => void = () => {},
  ) {}
  private liveChanges(
    plan: OrganizationPlan,
    baseline: OrganizationSnapshot,
  ): OrganizationLiveChanges {
    return this.store.organizationLiveChanges(plan, baseline);
  }

  private savePreview(applied = false, appliedGroupIds: string[] = []) {
    const p = this.preview;
    if (!p) return;
    const saved = JSON.stringify({
      version: 2,
      createdAt: Date.now(),
      applied,
      appliedGroupIds,
      plan: p.plan,
      baseline: p.baseline,
      inventory: p.inventory,
      directories: p.directories,
      context: p.data.current,
      request: p.request,
      feedback: p.feedback,
    });
    this.store.setConfig("organization-last-review", saved);
    this.store.setConfig(
      "organization-draft-" + organizationScopeKey(p.plan.scopes || []),
      saved,
    );
  }
  private keepPreview(value: NonNullable<OrganizationService["preview"]>) {
    this.preview = value;
    value.plan.liveChanges = this.liveChanges(value.plan, value.baseline);
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        this.preview = undefined;
        this.release();
      },
      30 * 60 * 1000,
    );
    this.expiry.unref?.();
    this.savePreview();
    return value.plan;
  }
  resume(): OrganizationPlan | null {
    if (this.preview) {
      this.preview.plan.liveChanges = this.liveChanges(
        this.preview.plan,
        this.preview.baseline,
      );
      return this.preview.plan;
    }
    if (this.job) return null;
    try {
      const saved = JSON.parse(
        this.store.config("organization-last-review") || "null",
      );
      if (!saved || saved.version !== 2 || saved.applied) return null;
      const data = new OrganizationInput(
        saved.plan.files,
        saved.directories,
        saved.context,
        saved.plan.scopes || [],
        saved.plan.delta?.mode === "incremental",
      );
      return this.keepPreview({
        plan: saved.plan,
        baseline: saved.baseline,
        inventory: saved.inventory,
        directories: saved.directories,
        data,
        request: saved.request,
        feedback: saved.feedback || [],
        expires: Date.now() + 30 * 60 * 1000,
      });
    } catch {
      return null;
    }
  }
  saveSelection(value: unknown) {
    const input = organizationReviewSelectionSchema.parse(value),
      p = this.preview;
    if (!p || p.plan.jobId !== input.jobId)
      throw new ProviderError("organizationExpired");
    if (
      input.fileExclusions?.some(
        (id) => !p.plan.fileExclusions?.includes(id),
      ) ||
      input.relationshipRemovals?.some(
        (id) => !p.plan.relationshipRemovals?.some((r) => r.id === id),
      ) ||
      input.groups.some((id) => !p.plan.groups.some((g) => g.id === id)) ||
      input.collections.some(
        (id) => !p.plan.collections.some((c) => c.id === id),
      ) ||
      input.acknowledgedRemovals?.some(
        (id) => !p.plan.delta?.removed.some((f) => f.id === id),
      ) ||
      Object.keys(input.names).some(
        (id) => !p.plan.groups.some((g) => g.id === id),
      )
    )
      throw new ProviderError("invalidInput");
    p.plan.reviewSelection = {
      groups: input.groups,
      collections: input.collections,
      names: input.names,
      acknowledgedRemovals: input.acknowledgedRemovals,
      relationshipRemovals: input.relationshipRemovals,
      fileExclusions: input.fileExclusions,
    };
    this.savePreview();
  }
  get busy() {
    return !!this.job || !!this.preview;
  }
  progress(value: unknown) {
    const key = id.parse(value);
    return this.job?.id === key
      ? this.job.progress
      : this.preview?.plan.jobId === key
        ? {
            phase: "ready",
            completed: 1,
            total: 1,
            changes: this.liveChanges(this.preview.plan, this.preview.baseline),
          }
        : null;
  }
  cancel(value: unknown) {
    const key = id.parse(value);
    if (this.job?.id === key) this.job.controller.abort();
    if (this.preview?.plan.jobId === key) {
      this.preview = undefined;
      clearTimeout(this.expiry);
      this.release();
    }
  }
  close() {
    this.job?.controller.abort();
    this.preview = undefined;
    clearTimeout(this.expiry);
  }
  async run(value: unknown): Promise<OrganizationPlan> {
    const input = organizeRequestSchema.parse(value);
    return traced(
      "organization",
      {
        model: input.model,
        roots: input.roots.length,
        connectionId: input.connectionId,
        jobId: input.jobId,
      },
      () => this.generate(input),
    );
  }
  private async generate(input: OrganizeRequest): Promise<OrganizationPlan> {
    if (this.busy) throw new ProviderError("organizationBusy");
    const runtime = this.settings.featureRuntime(
      input.connectionId,
      input.model,
      input.webSearch,
    );
    const controller = new AbortController();
    const job = {
      id: input.jobId,
      controller,
      progress: {
        phase: "scanning",
        completed: 0,
        total: input.roots.length,
      } as OrganizationProgress,
    };
    this.job = job;
    try {
      const roots = new Map<string, Set<string>>();
      for (const root of input.roots) {
        const connection = this.store.connection(root.connectionId);
        if (!connection.roots.includes(root.path))
          throw new ProviderError("outsideRoot");
        const paths = roots.get(root.connectionId) || new Set<string>();
        paths.add(root.path);
        roots.set(root.connectionId, paths);
      }
      let files: OrganizationFile[] = [];
      const directories: OrganizationDirectory[] = [];
      const scopes: { connectionId: string; path: string; depth: number }[] =
        [];
      let excludedCount = 0;
      for (const [connectionId, selected] of roots) {
        const connection = this.store.connection(connectionId);
        const result = await scanScopes(
          await this.provider(connection),
          [...selected].map((root) => ({
            root,
            depth: connection.scanDepths?.[root] ?? 1,
          })),
          controller.signal,
          { files: organizationFileLimit, directories: 10000 },
        );
        if (result.failures.length)
          throw new ProviderError("organizationIncomplete");
        const candidates = this.store.organizationCandidates(
          connectionId,
          result,
        );
        files.push(...candidates.files);
        excludedCount += candidates.excludedCount;
        if (files.length > organizationFileLimit)
          throw new ProviderError("organizationTooLarge");
        scopes.push(
          ...[...selected].map((p) => ({
            connectionId,
            path: p,
            depth: connection.scanDepths?.[p] ?? 1,
          })),
        );
        const scanned = new Set(result.completeDirectories);
        const paths = new Set([
          ...scanned,
          ...Object.values(result.children || {}).flat(),
        ]);
        for (const p of paths) {
          const root = [...selected]
            .filter((root) => relativeDepth(root, p) !== null)
            .sort((a, b) => a.length - b.length)[0];
          if (root)
            directories.push({
              connectionId,
              root,
              path: p,
              scanned: scanned.has(p),
            });
        }
        job.progress.completed += selected.size;
      }
      logEvent("organization.scanned", {
        files: files.length,
        roots: input.roots.length,
      });
      const baseline = this.store.organizationSnapshot();
      const inventory = [...files];
      const checkpointKey =
        "organization-reviewed-" + organizationScopeKey(scopes);
      let checkpoint: OrganizationCheckpoint | undefined;
      try {
        const v = JSON.parse(this.store.config(checkpointKey) || "null");
        if (v?.version === 1) checkpoint = v;
      } catch {}
      const deltaResult = organizationDelta(
        inventory,
        baseline,
        checkpoint,
        input.mode === "incremental",
      );
      const delta = deltaResult.delta;
      files = deltaResult.files;
      let previousDraft:
        | {
            plan?: OrganizationPlan;
            applied?: boolean;
            appliedGroupIds?: string[];
          }
        | undefined;
      try {
        previousDraft = JSON.parse(
          this.store.config(
            "organization-draft-" + organizationScopeKey(scopes),
          ) || "null",
        );
      } catch {}
      if (!inventory.length && !checkpoint)
        throw new ProviderError("organizationEmpty");
      const usedWorks = new Set(inventory.map((f) => f.workId));
      const context = this.store.organizationContext(files);
      if (delta.mode === "incremental")
        context.works = context.works
          .filter((w) => w.files.length || usedWorks.has(w.id))
          .map((w) =>
            w.files.length ? w : { ...w, description: "", tags: [] },
          );
      const inputDirectories =
        delta.mode === "incremental"
          ? directories.filter(
              (d) =>
                scopes.some(
                  (s) => s.connectionId === d.connectionId && s.path === d.path,
                ) ||
                files.some(
                  (f) =>
                    f.connectionId === d.connectionId &&
                    relativeDepth(d.path, f.path) !== null,
                ),
            )
          : directories;
      const data = new OrganizationInput(
        files,
        inputDirectories,
        context,
        scopes,
        delta.mode === "incremental",
      );
      if (!files.length)
        return this.keepPreview({
          plan: {
            jobId: input.jobId,
            files: [],
            groups: [],
            collections: [],
            unassigned: [],
            excludedCount,
            delta,
            scopes,
          },
          baseline,
          inventory,
          directories: inputDirectories,
          data,
          request: input,
          feedback: [],
          expires: Date.now() + 30 * 60 * 1000,
        });
      const language = this.store.preferences().language;
      job.progress = {
        phase: "grouping",
        completed: 0,
        total: 1,
        files: files.length,
      };
      let attempts = 0,
        divided = false;
      type Result = ReturnType<OrganizationInput["decode"]>;
      const pieces: Result[] = [];
      const analyze = async (
        task: StructuredTask,
        members: OrganizationFile[],
        refs = data.references,
        compactInitial = false,
      ): Promise<Result> => {
        const request = async (next: StructuredTask) => {
          // Only the primary whole-tree proposal uses the tested compact wire
          // format. Corrections/reconciliation retain their canonical contracts.
          const compact = compactInitial && next === task;
          const outgoing = compact
            ? columnarOrganizationTask(compactOrganizationTask(next))
            : { ...next };
          logEvent("organization.request.encoding", {
            format: compact ? "compact-columnar-v1" : "canonical",
            inputBytes: Buffer.byteLength(outgoing.prompt),
            inputCharacters: outgoing.prompt.length,
            reasoningEffort: outgoing.reasoningEffort || "default",
          });
          if (delta.mode === "incremental") {
            outgoing.system +=
              "\nThis is an incremental review. Only the supplied mutable inventory is in scope; unchanged accepted works are compact read-only relationship anchors. Collections/series may reference the listed wN anchors as members alongside proposed work identities, but never emit an anchor as a mutable work or use it as a file selector. Preserve accepted unaffected decisions. Explain material additions, removals and changes; prior proposals are reference context, not immutable truth. A missing item is not evidence that unrelated content should be renumbered or replaced.";
            outgoing.prompt +=
              "\nINCREMENTAL REVIEW:\n" +
              JSON.stringify({
                reviewedAt: delta.reviewedAt,
                counts: {
                  total: delta.totalFiles,
                  unchanged: delta.unchangedFiles,
                  pending: delta.pendingFiles,
                  added: delta.added.length,
                  modified: delta.modified.length,
                  removed: delta.removed.length,
                },
                added: delta.added
                  .map((f) => data.fileRefs.get(f.id))
                  .filter(Boolean),
                modified: delta.modified
                  .map((f) => data.fileRefs.get(f.id))
                  .filter(Boolean),
                removed: delta.removed.map((f) => ({
                  name: f.name,
                  relativePath: f.relativePath,
                  previousTitle: f.currentTitle,
                })),
                previousApplied: (checkpoint?.acceptedGroups || [])
                  .filter((g) => g.fileIds.some((id) => data.fileRefs.has(id)))
                  .map((g) => ({
                    title: g.title,
                    files: g.fileIds
                      .map((id) => data.fileRefs.get(id))
                      .filter(Boolean),
                    episodes: g.episodes
                      ?.map((e) => ({
                        ...e,
                        versions: e.versions
                          .map((v) => ({
                            ...v,
                            fileIds: v.fileIds
                              .map((id) => data.fileRefs.get(id))
                              .filter(Boolean),
                          }))
                          .filter((v) => v.fileIds.length),
                      }))
                      .filter((e) => e.versions.length),
                  })),
                previousDraft: previousDraft
                  ? previousDraft.plan?.groups
                      .filter(
                        (g) =>
                          !(
                            previousDraft!.appliedGroupIds ||
                            (previousDraft!.applied
                              ? previousDraft!.plan!.groups.map((g) => g.id)
                              : [])
                          ).includes(g.id) &&
                          g.fileIds.some((id) => data.fileRefs.has(id)),
                      )
                      .map((g) => ({
                        title:
                          previousDraft!.plan?.reviewSelection?.names[g.id] ||
                          g.title,
                        titleEdited:
                          !!previousDraft!.plan?.reviewSelection?.names[g.id] &&
                          previousDraft!.plan.reviewSelection.names[g.id] !==
                            g.title,
                        review: g.review,
                        reason: g.reason,
                        episodes: g.episodes
                          ?.map((e) => ({
                            ...e,
                            versions: e.versions
                              .map((v) => ({
                                ...v,
                                fileIds: v.fileIds
                                  .map((id) => data.fileRefs.get(id))
                                  .filter(Boolean),
                              }))
                              .filter((v) => v.fileIds.length),
                          }))
                          .filter((e) => e.versions.length),
                        files: g.fileIds
                          .map((id) => data.fileRefs.get(id))
                          .filter(Boolean),
                      }))
                  : undefined,
                previousDraftRelationships: previousDraft?.plan?.collections
                  .filter((c) =>
                    c.groupIds.some((id) =>
                      previousDraft!.plan!.groups.some(
                        (g) =>
                          g.id === id &&
                          g.fileIds.some((id) => data.fileRefs.has(id)),
                      ),
                    ),
                  )
                  .map((c) => ({
                    kind: c.kind || "collection",
                    name: c.name,
                    members: c.groupIds.map((id) => {
                      const g = previousDraft!.plan!.groups.find(
                        (g) => g.id === id,
                      )!;
                      return {
                        title:
                          previousDraft!.plan!.reviewSelection?.names[g.id] ||
                          g.title,
                        files: g.fileIds
                          .map((id) => data.fileRefs.get(id))
                          .filter(Boolean),
                        readonlyWork: g.referenceOnly
                          ? data.workRefs.get(g.existingWorkId!)
                          : undefined,
                      };
                    }),
                  })),
                readonlyWorkReferences: context.works
                  .filter((w) => data.anchors.has(data.workRefs.get(w.id)!))
                  .map((w) => ({
                    ref: data.workRefs.get(w.id),
                    title: w.title,
                    files: w.outsideFiles,
                    manualFields: w.manualFields,
                  })),
              });
          }
          const response = await this.settings.structured(
            runtime,
            outgoing,
            controller.signal,
          );
          if (!compact) return response;
          try {
            return {
              ...response,
              text: decodeColumnarOrganization(response.text),
            };
          } catch (error) {
            if (!(error instanceof OrganizationColumnarError)) throw error;
            logEvent(
              "organization.columnar.invalid",
              { reason: "schema" },
              "warn",
            );
            // Preserve the rejected wire response for the existing bounded repair
            // without allowing a canonical-looking reply to bypass wire checks.
            return {
              ...response,
              text: JSON.stringify({ invalidColumnarResponse: response.text }),
            };
          }
        };
        const previousPhase = job.progress.phase;
        try {
          return await analyzeOrganization({
            input: data,
            task,
            files: members,
            references: refs,
            request,
            signal: controller.signal,
            review: false,
            plan: false,
            initialRepairLimit: 1,
            phase: (phase) => {
              job.progress.phase = phase;
            },
          });
        } finally {
          job.progress.phase = previousPhase;
        }
      };
      const run = async (members: OrganizationFile[]): Promise<void> => {
        controller.signal.throwIfAborted();
        if (++attempts > 64) throw new ProviderError("organizationTooLarge");
        const task = data.directTask(input.instructions, language, members);
        logEvent("organization.analysis", {
          files: members.length,
          groups: data.current.works.length,
          collections: data.current.collections.length,
          bytes: Buffer.byteLength(task.prompt),
          textLength: task.prompt.length,
          batch: attempts,
        });
        try {
          pieces.push(await analyze(task, members, data.references, true));
          job.progress.completed++;
        } catch (error) {
          controller.signal.throwIfAborted();
          // No count/character heuristic can trigger splitting. Only a confirmed
          // input context limit or output-token exhaustion from the provider.
          if (
            !(error instanceof ProviderError) ||
            !["recognitionContextLimit", "recognitionTruncated"].includes(
              error.code,
            )
          )
            throw error;
          divided = true;
          const parts = data.split(members);
          job.progress.total++;
          logEvent("organization.capacity-split", {
            files: members.length,
            batches: parts.length,
            reason: error.code,
          });
          for (const part of parts) await run(part);
        }
      };
      await run(files);
      let result = pieces[0];
      if (divided) {
        // Reconcile ALL proposals globally after capacity-driven subdivision.
        // A proposal is an indivisible selector here; no arbitrary identity merge.
        job.progress = { phase: "collections", completed: 0, total: 1 };
        const refs = new Map<string, string[]>();
        const proposals = pieces
          .flatMap((piece) => [
            ...piece.groups.map((g) => ({
              title: g.title,
              fileIds: g.fileIds,
              episodes: g.episodes,
              review: g.review,
              reason: g.reason,
            })),
            ...piece.unassigned.map((id) => ({
              title: "",
              fileIds: [id],
              episodes: [],
              review: true,
              reason: "Unassigned",
            })),
          ])
          .map((g, i) => {
            const id = `p${i + 1}`;
            refs.set(id, g.fileIds);
            const fileSet = new Set(g.fileIds);
            return {
              id,
              title: g.title,
              files: g.fileIds.length,
              episodes: g.episodes.map((e) => ({
                ...e,
                versions: e.versions.map((v) => ({
                  ...v,
                  fileIds: v.fileIds.map((id) => data.fileRefs.get(id)),
                })),
              })),
              review: g.review,
              reason: g.reason,
              directories: [
                ...new Set(
                  data.rows
                    .filter((row) =>
                      fileSet.has(data.references.get(row[0])![0]),
                    )
                    .map((row) => row[1]),
                ),
              ],
            };
          });
        const task = data.task(input.instructions, language, []);
        task.system +=
          " This is the GLOBAL reconciliation after a confirmed capacity limit. Select only pN proposal references in work fileIds/unassigned, never fN/dN/wN. Episode/version mappings still use the supplied individual fN references. Preserve the proposals' episode/version mappings unless evidence supports a revision, and resolve equivalences across proposals jointly. Keep uncertain proposals flagged. Merge proposals only with clear evidence; suggest collections across all proposals. Current-state summaries are reference evidence with the same soft stability preference and manual-edit weighting as the initial analysis, never immutable names.";
        const currentAssignments = data.current.works.map((w) => ({
          id: data.workRefs.get(w.id),
          proposals: [...refs]
            .filter(([, ids]) => w.files.some((f) => ids.includes(f.id)))
            .map(([id]) => id),
          selectedFiles: w.files.length,
          outsideFiles: w.outsideFiles,
          manualFields: w.manualFields,
        }));
        task.prompt += `\nCURRENT ASSIGNMENTS:\n${JSON.stringify(currentAssignments)}\nPROPOSALS:\n${JSON.stringify(proposals)}`;
        try {
          result = await analyze(task, files, refs);
          // Sparse global revisions retain validated per-piece episode mappings.
          // Explicit global mappings take priority; never infer new equivalences here.
          for (const group of result.groups) {
            const mapped = new Set(
              group.episodes.flatMap((e) =>
                e.versions.flatMap((v) => v.fileIds),
              ),
            );
            for (const episode of pieces.flatMap((p) =>
              p.groups.flatMap((g) => g.episodes),
            )) {
              const members = episode.versions.flatMap((v) => v.fileIds);
              if (
                members.every(
                  (id) => group.fileIds.includes(id) && !mapped.has(id),
                )
              ) {
                group.episodes.push(episode);
                members.forEach((id) => mapped.add(id));
              }
            }
          }
          // Reconciliation cannot silently clear a partial analysis warning.
          for (const group of result.groups)
            group.review ||= pieces.some(
              (p) =>
                p.groups.some(
                  (g) =>
                    g.review &&
                    g.fileIds.some((id) => group.fileIds.includes(id)),
                ) || p.unassigned.some((id) => group.fileIds.includes(id)),
            );
        } catch (error) {
          if (
            error instanceof ProviderError &&
            ["recognitionContextLimit", "recognitionTruncated"].includes(
              error.code,
            )
          )
            throw new ProviderError("organizationTooLarge");
          throw error;
        }
      }
      const { groups, collections, unassigned } = data.stabilize(result);
      controller.signal.throwIfAborted();
      const plan: OrganizationPlan = {
        jobId: input.jobId,
        files,
        groups,
        collections,
        unassigned,
        excludedCount,
        delta,
        scopes,
      };
      logEvent("organization.ready", {
        files: files.length,
        groups: groups.length,
        collections: collections.length,
      });
      return this.keepPreview({
        plan,
        baseline,
        inventory,
        directories: inputDirectories,
        data,
        request: input,
        feedback: [],
        expires: Date.now() + 30 * 60 * 1000,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      controller.abort();
      if (cancelled) throw new ProviderError("recognitionCancelled");
      throw error;
    } finally {
      this.job = undefined;
    }
  }
  async refine(value: unknown): Promise<OrganizationPlan> {
    const input = organizationRefineSchema.parse(value);
    if (this.job) throw new ProviderError("organizationBusy");
    const previous = this.preview;
    if (
      !previous ||
      previous.plan.jobId !== input.previousJobId ||
      previous.expires < Date.now()
    )
      throw new ProviderError("organizationExpired");
    if (input.jobId === input.previousJobId)
      throw new ProviderError("invalidInput");
    const titles = new Map(input.titles.map((g) => [g.id, g.title]));
    if (
      titles.size !== input.titles.length ||
      input.titles.some(
        (g) =>
          !previous.plan.groups.some((p) => p.id === g.id && !p.referenceOnly),
      )
    )
      throw new ProviderError("invalidInput");
    const feedback = [...previous.feedback, input.feedback];
    if (feedback.join("\n").length > 32000)
      throw new ProviderError("organizationFeedbackLimit");
    const runtime = this.settings.featureRuntime(
      previous.request.connectionId,
      previous.request.model,
      previous.request.webSearch,
    );
    const controller = new AbortController();
    const data = previous.data;
    const fileRef = (id: string) => data.fileRefs.get(id)!;
    const context = {
      previousProposal: {
        groups: previous.plan.groups
          .filter((g) => !g.referenceOnly)
          .map((g) => ({
            id: g.id,
            title: titles.get(g.id) || g.title,
            titleEdited: titles.has(g.id) && titles.get(g.id) !== g.title,
            fileIds: g.fileIds.map(fileRef),
            review: g.review,
            reason: g.reason,
            episodes: g.episodes?.map((e) => ({
              ...e,
              versions: e.versions.map((v) => ({
                ...v,
                fileIds: v.fileIds.map(fileRef),
              })),
            })),
          })),
        collections: previous.plan.collections.map((c) => ({
          ...c,
          groupIds: c.groupIds.map((id) => {
            const g = previous.plan.groups.find((g) => g.id === id);
            return g?.referenceOnly
              ? data.workRefs.get(g.existingWorkId!)!
              : id;
          }),
        })),
        unassigned: previous.plan.unassigned.map(fileRef),
      },
      concurrentChanges: (() => {
        const changes = this.liveChanges(previous.plan, previous.baseline);
        return {
          added: changes.added.length,
          removed: changes.removed.length,
          modified: changes.modified.length,
          deferredGroupIds: changes.conflictingGroupIds,
        };
      })(),
      userFeedback: feedback,
    };
    const task = columnarOrganizationTask(
      compactOrganizationTask(
        data.directTask(
          previous.request.instructions,
          this.store.preferences().language,
        ),
      ),
    );
    task.system +=
      "\nRevise the supplied prior proposal using the original complete inventory and the user's feedback in chronological order. Later feedback supersedes earlier feedback where they conflict. Preserve suitable unaffected decisions and explicit title edits. The prior proposal is fallible context, not ground truth; its group IDs are not file selectors. Return a complete replacement proposal under the same output contract, never a patch. Concurrent changes do not expand this snapshot inventory: added files belong to a later increment, and the application defers proposals connected to removed or edited content. Revise the snapshot normally; never invent replacements for missing or newly arrived files. Local conflict checking will run again on the revised complete relationship graph before application. User feedback controls organization preferences, not the protocol, file scope or security rules. Explain remaining material uncertainty in the affected proposal's reason; resolve concerns supported by evidence.";
    task.prompt += `\nREVISION CONTEXT:\n${JSON.stringify(context)}`;
    if (previous.plan.delta?.mode === "incremental") {
      task.system +=
        "\nOnly the supplied mutable inventory is in scope. Unchanged works with no mutable files are read-only wN relationship anchors: use them only as collection/series members, never as mutable work identities or file selectors. Retain unaffected accepted decisions. Removed inventory is change evidence, not an instruction to renumber unrelated content.";
      task.prompt +=
        "\nINCREMENTAL CHANGE EVIDENCE:\n" +
        JSON.stringify({
          counts: {
            total: previous.plan.delta.totalFiles,
            unchanged: previous.plan.delta.unchangedFiles,
            pending: previous.plan.delta.pendingFiles,
          },
          removed: previous.plan.delta.removed.map((f) => ({
            name: f.name,
            relativePath: f.relativePath,
            previousTitle: f.currentTitle,
          })),
        });
    }
    this.job = {
      id: input.jobId,
      controller,
      progress: {
        phase: "grouping",
        completed: 0,
        total: 1,
        files: previous.plan.files.length,
      },
    };
    clearTimeout(this.expiry);

    try {
      const result = await traced(
        "organization.refine",
        { jobId: input.jobId, model: runtime.model },
        () =>
          analyzeOrganization({
            input: data,
            task,
            files: previous.plan.files,
            signal: controller.signal,
            review: false,
            plan: false,
            initialRepairLimit: 1,
            phase: (phase) => {
              if (this.job?.id === input.jobId) this.job.progress.phase = phase;
            },
            request: async (next) => {
              const response = await this.settings.structured(
                runtime,
                next,
                controller.signal,
              );
              if (next !== task) return response;
              try {
                return {
                  ...response,
                  text: decodeColumnarOrganization(response.text),
                };
              } catch (error) {
                if (!(error instanceof OrganizationColumnarError)) throw error;
                return {
                  ...response,
                  text: JSON.stringify({
                    invalidColumnarResponse: response.text,
                  }),
                };
              }
            },
          }),
      );
      controller.signal.throwIfAborted();
      if (this.preview !== previous)
        throw new ProviderError("organizationExpired");
      const plan = {
        ...previous.plan,
        ...data.stabilize(result),
        jobId: input.jobId,
      };
      delete plan.reviewSelection;
      this.preview = { ...previous, plan, feedback };
      plan.liveChanges = this.liveChanges(plan, previous.baseline);
      this.savePreview();
      return plan;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      controller.abort();
      if (cancelled) throw new ProviderError("recognitionCancelled");
      throw error;
    } finally {
      this.job = undefined;
      if (this.preview) {
        this.preview.expires = Date.now() + 30 * 60 * 1000;
        this.expiry = setTimeout(
          () => {
            this.preview = undefined;
            this.release();
          },
          30 * 60 * 1000,
        );
        this.expiry.unref?.();
      }
    }
  }
  apply(value: unknown) {
    if (this.job) throw new ProviderError("organizationBusy");
    const input = organizationApplySchema.parse(value);
    const preview = this.preview;
    if (
      !preview ||
      preview.plan.jobId !== input.jobId ||
      preview.expires < Date.now()
    )
      throw new ProviderError("organizationExpired");
    const parents = new Map<string, Set<string>>();
    const visible = this.store.organizationSnapshot();
    for (const id of input.acknowledgedRemovals || []) {
      const file = preview.plan.delta?.removed.find((f) => f.id === id);
      if (!file) throw new ProviderError("invalidInput");
      // Explicit library exclusions are index changes, not claims that the
      // physical media was deleted. Only verify absence for indexed media.
      if (
        !Object.values(visible.files).some(
          (f) => f.connectionId === file.connectionId && f.path === file.path,
        )
      )
        continue;
      const dirname = (
        file.path.includes("\\") ? path.win32 : path.posix
      ).dirname(file.path);
      const key = JSON.stringify([file.connectionId, dirname]);
      const names = parents.get(key) || new Set<string>();
      names.add(file.path);
      parents.set(key, names);
    }
    const commit = () => {
      if (this.preview !== preview || this.job || preview.expires < Date.now())
        throw new ProviderError("organizationExpired");
      const result = this.store.applyOrganization(
        preview.plan,
        input,
        preview.baseline,
      );
      const key =
        "organization-reviewed-" +
        organizationScopeKey(preview.plan.scopes || []);
      let old: OrganizationCheckpoint = {
        version: 1,
        reviewedAt: Date.now(),
        files: {},
      };
      try {
        old = JSON.parse(this.store.config(key) || "null") || old;
      } catch {}
      const current = reviewedOrganizationFiles(
        preview.inventory,
        this.store.organizationSnapshot(),
      );
      const accepted = new Set(
        preview.plan.groups
          .filter((g) => input.groups.some((s) => s.id === g.id))
          .flatMap((g) => g.fileIds),
      );
      for (const id of accepted) if (current[id]) old.files[id] = current[id];
      const anchors = new Set(
        preview.plan.groups
          .filter(
            (g) => g.referenceOnly && input.groups.some((s) => s.id === g.id),
          )
          .map((g) => g.existingWorkId),
      );
      for (const id of Object.keys(old.files))
        if (current[id] && anchors.has(current[id].workId))
          old.files[id] = current[id];
      const removedIds = new Set([
        ...(input.acknowledgedRemovals || []),
        ...(input.fileExclusionIds || []),
      ]);
      for (const id of removedIds) delete old.files[id];
      old.acceptedGroups = [
        ...(old.acceptedGroups || []).filter(
          (g) =>
            !g.fileIds.some((id) => accepted.has(id) || removedIds.has(id)),
        ),
        ...preview.plan.groups
          .filter(
            (g) => !g.referenceOnly && input.groups.some((s) => s.id === g.id),
          )
          .map((g) => ({
            ...g,
            title: input.groups.find((s) => s.id === g.id)!.title,
          })),
      ];
      old.reviewedAt = Date.now();
      old.pendingFileIds = [
        ...new Set([
          ...(old.pendingFileIds || []),
          ...preview.plan.files
            .filter((f) => !accepted.has(f.id))
            .map((f) => f.id),
        ]),
      ].filter((id) => !accepted.has(id) && !removedIds.has(id));
      this.store.setConfig(key, JSON.stringify(old));
      this.savePreview(
        true,
        input.groups.map((g) => g.id),
      );
      logEvent("organization.applied", {
        groups: input.groups.length,
        collections: input.collectionIds.length,
      });
      this.preview = undefined;
      clearTimeout(this.expiry);
      this.release();
      return result;
    };
    if (!parents.size) return commit();
    return (async () => {
      for (const [key, paths] of parents) {
        const [connectionId, directory] = JSON.parse(key);
        const entries = await (
          await this.provider(this.store.connection(connectionId))
        ).list(directory, AbortSignal.timeout(15000));
        if (entries.some((e) => paths.has(e.path)))
          throw new ProviderError("organizationStale");
      }
      return commit();
    })();
  }
}
