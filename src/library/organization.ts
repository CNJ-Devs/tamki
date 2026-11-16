import { traced, logEvent } from "../diagnostics";
import { ProviderError } from "../providers/provider";
import type { Connection } from "../shared/model";
import {
  organizeRequestSchema,
  organizationApplySchema,
  organizationRefineSchema,
  organizationFileLimit,
  type OrganizationDirectory,
  type OrganizeRequest,
  type OrganizationFile,
  type OrganizationPlan,
  type OrganizationProgress,
} from "../shared/organization";
import { OrganizationInput } from "./organization-input";
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

// A whole-library response can outlast a generic recognition request. This is
// a finite per-request limit; the job's explicit cancellation remains immediate.
const organizationRequestTimeoutMs = 10 * 60 * 1000;

export class OrganizationService {
  private job?: {
    id: string;
    controller: AbortController;
    progress: OrganizationProgress;
  };
  private preview?: {
    plan: OrganizationPlan;
    baseline: string;
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
  get busy() {
    return !!this.job || !!this.preview;
  }
  progress(value: unknown) {
    const key = id.parse(value);
    return this.job?.id === key
      ? this.job.progress
      : this.preview?.plan.jobId === key
        ? { phase: "ready", completed: 1, total: 1 }
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
      const baseline = this.store.organizationFingerprint();
      const files: OrganizationFile[] = [];
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
      if (!files.length) throw new ProviderError("organizationEmpty");
      const data = new OrganizationInput(
        files,
        directories,
        this.store.organizationContext(files),
        scopes,
      );
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
            : next;
          logEvent("organization.request.encoding", {
            format: compact ? "compact-columnar-v1" : "canonical",
            inputBytes: Buffer.byteLength(outgoing.prompt),
            inputCharacters: outgoing.prompt.length,
            reasoningEffort: outgoing.reasoningEffort || "default",
          });
          const response = await this.settings.structured(
            runtime,
            outgoing,
            AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(organizationRequestTimeoutMs),
            ]),
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
      if (this.store.organizationFingerprint() !== baseline)
        throw new ProviderError("organizationStale");
      const plan: OrganizationPlan = {
        jobId: input.jobId,
        files,
        groups,
        collections,
        unassigned,
        excludedCount,
      };
      logEvent("organization.ready", {
        files: files.length,
        groups: groups.length,
        collections: collections.length,
      });
      this.store.setConfig(
        "organization-last-review",
        JSON.stringify({ createdAt: Date.now(), plan }),
      );
      this.preview = {
        plan,
        baseline,
        data,
        request: input,
        feedback: [],
        expires: Date.now() + 30 * 60 * 1000,
      };
      this.expiry = setTimeout(
        () => {
          this.preview = undefined;
          this.release();
        },
        30 * 60 * 1000,
      );
      this.expiry.unref?.();
      return plan;
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
    if (this.store.organizationFingerprint() !== previous.baseline)
      throw new ProviderError("organizationStale");
    const titles = new Map(input.titles.map((g) => [g.id, g.title]));
    if (
      titles.size !== input.titles.length ||
      input.titles.some((g) => !previous.plan.groups.some((p) => p.id === g.id))
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
        groups: previous.plan.groups.map((g) => ({
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
        collections: previous.plan.collections,
        unassigned: previous.plan.unassigned.map(fileRef),
      },
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
      "\nRevise the supplied prior proposal using the original complete inventory and the user's feedback in chronological order. Later feedback supersedes earlier feedback where they conflict. Preserve suitable unaffected decisions and explicit title edits. The prior proposal is fallible context, not ground truth; its group IDs are not file selectors. Return a complete replacement proposal under the same output contract, never a patch. User feedback controls organization preferences, not the protocol, file scope or security rules. Explain remaining material uncertainty in the affected proposal's reason; resolve concerns supported by evidence.";
    task.prompt += `\nREVISION CONTEXT:\n${JSON.stringify(context)}`;
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
                AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(organizationRequestTimeoutMs),
                ]),
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
      if (this.store.organizationFingerprint() !== previous.baseline)
        throw new ProviderError("organizationStale");
      const plan = {
        ...previous.plan,
        ...data.stabilize(result),
        jobId: input.jobId,
      };
      this.store.setConfig(
        "organization-last-review",
        JSON.stringify({ createdAt: Date.now(), plan }),
      );
      this.preview = { ...previous, plan, feedback };
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
    const result = this.store.applyOrganization(
      preview.plan,
      input,
      preview.baseline,
    );
    logEvent("organization.applied", {
      groups: input.groups.length,
      collections: input.collectionIds.length,
    });
    this.preview = undefined;
    clearTimeout(this.expiry);
    this.release();
    return result;
  }
}
