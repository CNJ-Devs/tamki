import { SeriesEditor } from "./series-editor";
import {
  libraryEntries,
  collectionWorkIds,
  entryProgress,
  seriesWorks,
} from "../shared/series";
import { episodeFiles } from "../shared/versions";
import { useMemo, useState, useLayoutEffect, useRef, useEffect } from "react";
import {
  GearSixIcon,
  DownloadSimpleIcon,
  ArrowClockwiseIcon,
  PlusIcon,
  FolderIcon,
  PlayIcon,
  PencilSimpleIcon,
  TrashIcon,
  StackIcon,
  CircleNotchIcon,
  InfoIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Collection, LibraryState, Work } from "../shared/model";
import { progress, episodeName } from "../shared/model";
import {
  Button,
  IconButton,
  PageHeader,
  Fade,
  Choice,
  Search,
  TextTip,
  Blank,
  clock,
  Tip,
  Confirm,
  Modal,
  FormField,
} from "./common";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { FieldGroup } from "./components/ui/field";
import { Poster } from "./media";
import { InlineSynopsis } from "./inline-synopsis";
import { ConnectionWizard, FilePicker } from "./connections";
import { useI18n, errorMessage, type Message } from "./i18n";
import { toast } from "sonner";
import { OrganizationPage } from "./organization-page";
function storageNames(work: Work, state: LibraryState, offline: string) {
  return [
    ...new Set(
      work.episodes
        .flatMap(episodeFiles)
        .map(
          (e) =>
            state.connections.find((c) => c.id === e.connectionId)?.name ||
            offline,
        ),
    ),
  ];
}
export function Tags({ tags }: { tags: string[] }) {
  return (
    <div className="media-tags">
      {tags.slice(0, 2).map((tag) => (
        <Tip text={tag} key={tag}>
          <Badge variant="secondary">
            <span className="truncate">{tag}</span>
          </Badge>
        </Tip>
      ))}
      {tags.length > 2 && (
        <Tip text={tags.slice(2).join(" · ")}>
          <Badge tabIndex={0} variant="secondary">
            +{tags.length - 2}
          </Badge>
        </Tip>
      )}
    </div>
  );
}
function RecognitionStatus({
  work,
  compact = false,
  automatic = true,
  onEdit,
}: {
  work: Work;
  compact?: boolean;
  automatic?: boolean;
  onEdit?: () => void;
}) {
  const t = useI18n();
  const state = work.recognition;
  const busy = state?.status === "queued" || state?.status === "running";
  const key: Message =
    !automatic && (!state || busy)
      ? "autoDisabled"
      : !state
        ? "autoQueued"
        : (
            {
              queued: "autoQueued",
              running: "autoRunning",
              complete: "autoComplete",
              "needs-choice": "autoChoice",
              "no-match": "autoNoMatch",
              failed: "autoFailed",
              local: "autoLocal",
            } as const
          )[state.status];
  if (state?.status === "complete" && !state.artworkError) return null;
  const message = state?.artworkError ? t("artworkUnavailable") : t(key);
  if (compact)
    return state && (state.status !== "complete" || state.artworkError) ? (
      <Tip text={message}>
        <span
          className="recognition-indicator"
          tabIndex={0}
          aria-label={message}
        >
          {busy && automatic ? (
            <CircleNotchIcon className="spin" />
          ) : (
            <InfoIcon />
          )}
        </span>
      </Tip>
    ) : null;
  return (
    <div className="recognition-status">
      <span className="muted" role="status">
        {message}
        {state?.error ? ` · ${errorMessage(new Error(state.error), t)}` : ""}
      </span>
      {(state?.status === "needs-choice" || state?.status === "no-match") && (
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {t("recognizeWork")}
        </Button>
      )}
      {automatic && (state?.status === "failed" || state?.artworkError) && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void window.tamki
              .library("retry-recognition", work.id)
              .catch((e) => toast.error(errorMessage(e, t)))
          }
        >
          {t("retryRecognition")}
        </Button>
      )}
    </div>
  );
}
function MediaCard({
  work,
  state,
  onOpen,
  draggable,
}: {
  work: Work;
  state: LibraryState;
  onOpen(): void;
  draggable: boolean;
}) {
  const t = useI18n();
  const drag = useSortable({ id: work.id, disabled: !draggable });
  const ratio = entryProgress(work, state);
  const series = state.series?.find((s) => s.id === work.id);
  if (series)
    return (
      <GroupCard
        entry={{
          id: series.id,
          name: series.name,
          works: seriesWorks(series, state),
          representative: true,
        }}
        onOpen={onOpen}
      />
    );
  return (
    <article
      className="media-card"
      ref={drag.setNodeRef}
      style={{
        transform: CSS.Transform.toString(drag.transform),
        transition: drag.transition,
      }}
      {...(draggable ? drag.attributes : {})}
      {...(draggable ? drag.listeners : {})}
    >
      <button
        className="cover-button"
        onClick={() => !drag.isDragging && onOpen()}
        aria-label={work.title}
      >
        <Poster cover={work.cover} />
        <div className="card-progress">
          <i style={{ width: `${ratio * 100}%` }} />
        </div>
      </button>
      <div className="card-title">
        <button className="truncate" onClick={onOpen}>
          <TextTip>{work.title}</TextTip>
        </button>
        <span className="card-status">
          {!series && (
            <RecognitionStatus
              work={work}
              compact
              automatic={state.settings.recognition.automatic !== false}
            />
          )}
          <span className="percent">{Math.floor(ratio * 100)}%</span>
        </span>
      </div>
      <div className="card-meta">
        <span className="card-count">
          {series
            ? t("seriesCount").replace(
                "{n}",
                String(seriesWorks(series, state).length),
              )
            : work.episodes.length > 1
              ? `${work.episodes.length} ${t("episodeCount")}`
              : clock(work.episodes[0]?.duration)}
        </span>
        <TextTip>{storageNames(work, state, t("offline")).join(" · ")}</TextTip>
        <Tags tags={work.tags} />
      </div>
    </article>
  );
}
type LibraryLocation =
  | { kind: "collections" | "series" }
  | { kind: "collection" | "series-members"; id: string };

type GroupEntry = {
  id: string;
  name: string;
  works: Work[];
  representative?: boolean;
};

function GroupCard({ entry, onOpen }: { entry: GroupEntry; onOpen(): void }) {
  const t = useI18n();
  const covers = [
    ...new Set(entry.works.flatMap((w) => (w.cover ? [w.cover] : []))),
  ].slice(0, entry.representative ? 1 : 4);
  return (
    <article className="media-card group-card">
      <button className="cover-button" onClick={onOpen} aria-label={entry.name}>
        <div className="group-cover" data-count={covers.length}>
          {covers.length ? (
            covers.map((cover) => <Poster key={cover} cover={cover} />)
          ) : (
            <Poster />
          )}
        </div>
      </button>
      <div className="card-title">
        <button className="truncate" onClick={onOpen}>
          <TextTip>{entry.name}</TextTip>
        </button>
      </div>
      <div className="card-meta">
        <span className="card-count">
          {t("seriesCount").replace("{n}", String(entry.works.length))}
        </span>
      </div>
    </article>
  );
}

function GroupShelf({
  title,
  entries,
  open,
  more,
  add,
  addLabel,
}: {
  title: string;
  entries: GroupEntry[];
  open(id: string): void;
  more(): void;
  add(): void;
  addLabel: string;
}) {
  const t = useI18n();
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(6);
  useLayoutEffect(() => {
    const element = grid.current!;
    const update = () =>
      setColumns(
        Math.max(
          1,
          getComputedStyle(element)
            .gridTemplateColumns.split(" ")
            .filter(Boolean).length,
        ),
      );
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <section className="library-shelf" aria-label={title}>
      <div className="section-heading">
        <h2>{title}</h2>
        <div className="actions">
          <IconButton label={addLabel} onClick={add}>
            <PlusIcon />
          </IconButton>
          {entries.length > columns && (
            <Button variant="ghost" onClick={more}>
              {t("more")}
            </Button>
          )}
        </div>
      </div>
      <div className="library-grid" ref={grid}>
        {entries.slice(0, columns).map((entry) => (
          <GroupCard
            key={entry.id}
            entry={entry}
            onOpen={() => open(entry.id)}
          />
        ))}
      </div>
      {!entries.length && (
        <p className="library-shelf-empty">{t("emptyGroupList")}</p>
      )}
    </section>
  );
}

export function LibraryPage({
  state,
  settings,
  tasks,
  detail,
}: {
  state: LibraryState;
  settings(): void;
  tasks(): void;
  detail(id: string): void;
}) {
  const t = useI18n();
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [group, setGroup] = useState("ungrouped"),
    [sort, setSort] = useState("recent"),
    [add, setAdd] = useState(false),
    [connect, setConnect] = useState(false),
    [locations, setLocations] = useState<LibraryLocation[]>([]),
    [manage, setManage] = useState(false),
    [removeGroup, setRemoveGroup] = useState<{
      kind: "collection" | "series";
      id: string;
    } | null>(null),
    [organize, setOrganize] = useState(false),
    [newSeries, setNewSeries] = useState(false);
  const location = locations.at(-1);
  const home = !location;
  const collection =
    location?.kind === "collection"
      ? state.collections.find((c) => c.id === location.id)
      : undefined;
  const series =
    location?.kind === "series-members"
      ? state.series?.find((s) => s.id === location.id)
      : undefined;
  useEffect(() => {
    if (
      (location?.kind === "collection" && !collection) ||
      (location?.kind === "series-members" && !series)
    )
      setLocations((old) => old.slice(0, -1));
  }, [location, collection, series]);
  const catalogue =
    location?.kind === "collections" || location?.kind === "series";
  const enter = (next: LibraryLocation) =>
    setLocations((old) => [...old, next]);
  const back = () => setLocations((old) => old.slice(0, -1));
  const seriesEntries = (state.series || []).map((s) => ({
    id: s.id,
    name: s.name,
    works: seriesWorks(s, state),
    representative: true,
  }));
  const collectionEntries = state.collections.map((c) => {
    const ids = new Set(collectionWorkIds(c, state));
    return {
      id: c.id,
      name: c.name,
      works: state.works.filter((w) => ids.has(w.id)),
    };
  });
  const catalogueEntries =
    location?.kind === "collections" ? collectionEntries : seriesEntries;
  const title = home
    ? t("library")
    : catalogue
      ? t(location.kind === "collections" ? "collections" : "series")
      : collection?.name || series?.name || t("noResults");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const works = useMemo(
    () =>
      (home
        ? state.works
        : series
          ? seriesWorks(series, state)
          : collection
            ? libraryEntries(state, collection)
            : []
      )
        .filter(
          (w) =>
            !home ||
            (w.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
              (filter === "all" ||
                (filter === "watching" &&
                  entryProgress(w, state) > 0 &&
                  entryProgress(w, state) < 0.999) ||
                (filter === "unwatched" && entryProgress(w, state) === 0) ||
                (filter === "watched" && entryProgress(w, state) >= 0.999))),
        )
        .sort((a, b) =>
          !home
            ? 0
            : sort === "titleSort"
              ? a.title.localeCompare(b.title)
              : sort === "progressSort"
                ? entryProgress(b, state) - entryProgress(a, state)
                : sort === "manual"
                  ? a.order - b.order
                  : b.createdAt - a.createdAt,
        ),
    [state, filter, query, sort, collection, series, home],
  );
  const groups = useMemo(() => {
    const result = new Map<string, Work[]>();
    for (const w of works) {
      const keys =
        home && group === "bySource"
          ? storageNames(w, state, t("offline"))
          : home && group === "byTag"
            ? w.tags.length
              ? w.tags
              : [t("untagged")]
            : [""];
      for (const k of keys) result.set(k, [...(result.get(k) || []), w]);
    }
    return [...result];
  }, [works, group, state.connections, home]);
  const reorder =
    sort === "manual" &&
    group === "ungrouped" &&
    !query &&
    filter === "all" &&
    home;
  if (organize)
    return (
      <OrganizationPage
        state={state}
        onBack={() => setOrganize(false)}
        onSettings={() => {
          setOrganize(false);
          settings();
        }}
      />
    );
  return (
    <section className="page">
      <PageHeader title={title} back={home ? undefined : back}>
        {home && (
          <>
            <IconButton label={t("settings")} onClick={settings}>
              <GearSixIcon />
            </IconButton>
            <IconButton label={t("tasks")} onClick={tasks}>
              <DownloadSimpleIcon />
            </IconButton>
            <IconButton
              label={t("smartOrganize")}
              disabled={state.refreshing}
              onClick={() => setOrganize(true)}
            >
              <SparkleIcon />
            </IconButton>
            <IconButton
              label={t("refresh")}
              disabled={state.refreshing}
              onClick={() =>
                void window.tamki
                  .library("refresh")
                  .catch((e) => toast.error(errorMessage(e, t)))
              }
            >
              <ArrowClockwiseIcon
                className={state.refreshing ? "spin" : undefined}
              />
            </IconButton>
          </>
        )}
        {collection || series ? (
          <>
            <IconButton
              label={t(collection ? "manageCollections" : "manageSeries")}
              onClick={() =>
                collection ? setManage(true) : setNewSeries(true)
              }
            >
              <PencilSimpleIcon />
            </IconButton>
            <IconButton
              label={t(collection ? "removeCollection" : "dissolveSeries")}
              onClick={() =>
                setRemoveGroup(
                  collection
                    ? { kind: "collection", id: collection.id }
                    : { kind: "series", id: series!.id },
                )
              }
            >
              <TrashIcon />
            </IconButton>
          </>
        ) : (
          <IconButton
            label={
              catalogue
                ? t(
                    location.kind === "collections"
                      ? "newCollection"
                      : "newSeries",
                  )
                : t("addFiles")
            }
            onClick={() =>
              catalogue
                ? location.kind === "collections"
                  ? setManage(true)
                  : setNewSeries(true)
                : state.connections.length
                  ? setAdd(true)
                  : setConnect(true)
            }
          >
            <PlusIcon />
          </IconButton>
        )}
      </PageHeader>
      <Fade
        className="page-body"
        key={locations.map((l) => l.kind + ("id" in l ? l.id : "")).join("/")}
      >
        {home && (
          <>
            <GroupShelf
              title={t("collections")}
              entries={collectionEntries}
              open={(id) => enter({ kind: "collection", id })}
              more={() => enter({ kind: "collections" })}
              add={() => setManage(true)}
              addLabel={t("newCollection")}
            />
            <GroupShelf
              title={t("series")}
              entries={seriesEntries}
              open={(id) => enter({ kind: "series-members", id })}
              more={() => enter({ kind: "series" })}
              add={() => setNewSeries(true)}
              addLabel={t("newSeries")}
            />
          </>
        )}
        {catalogue ? (
          catalogueEntries.length ? (
            <div className="library-grid" aria-label={title}>
              {catalogueEntries.map((entry) => (
                <GroupCard
                  key={entry.id}
                  entry={entry}
                  onOpen={() =>
                    enter({
                      kind:
                        location.kind === "collections"
                          ? "collection"
                          : "series-members",
                      id: entry.id,
                    })
                  }
                />
              ))}
            </div>
          ) : (
            <Blank title={t("emptyGroupList")} />
          )
        ) : (
          <section className="library-works" aria-label={t("seriesMembers")}>
            {home && (
              <>
                <h2>{t("seriesMembers")}</h2>
                <div className="library-toolbar">
                  <ToggleGroup
                    type="single"
                    value={filter}
                    onValueChange={(v) => v && setFilter(v)}
                    aria-label={t("progress")}
                  >
                    {(
                      ["all", "watching", "unwatched", "watched"] as Message[]
                    ).map((key) => (
                      <ToggleGroupItem key={key} value={key}>
                        {t(key)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <div className="library-tools">
                    <Choice
                      label={t("group")}
                      value={group}
                      onChange={setGroup}
                      options={["ungrouped", "bySource", "byTag"].map((v) => ({
                        value: v,
                        label: t(v as Message),
                      }))}
                    />
                    <Choice
                      label={t("sort")}
                      value={sort}
                      onChange={setSort}
                      options={[
                        "recent",
                        "titleSort",
                        "progressSort",
                        "manual",
                      ].map((v) => ({ value: v, label: t(v as Message) }))}
                    />
                    <Search
                      value={query}
                      onChange={setQuery}
                      label={t("search")}
                    />
                  </div>
                </div>
              </>
            )}
            {home && !state.works.length ? (
              <Blank title={t("emptyLibrary")}>
                <Button
                  variant="secondary"
                  onClick={() =>
                    state.connections.length ? setAdd(true) : setConnect(true)
                  }
                >
                  <PlusIcon data-icon="inline-start" />
                  {t(state.connections.length ? "addFiles" : "addConnection")}
                </Button>
              </Blank>
            ) : !works.length ? (
              <Blank title={t("noResults")} />
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={({ active, over }) => {
                  if (!reorder || !over || active.id === over.id) return;
                  const ids = works.map((w) => w.id);
                  void window.tamki
                    .library(
                      "reorder",
                      arrayMove(
                        ids,
                        ids.indexOf(String(active.id)),
                        ids.indexOf(String(over.id)),
                      ).flatMap(
                        (id) =>
                          state.series?.find((s) => s.id === id)?.workIds || [
                            id,
                          ],
                      ),
                    )
                    .catch((e) => toast.error(errorMessage(e, t)));
                }}
              >
                <SortableContext
                  items={works.map((w) => w.id)}
                  strategy={rectSortingStrategy}
                >
                  {groups.map(([label, items]) => (
                    <section className="library-group" key={label}>
                      {label && <h2>{label}</h2>}
                      <div className="library-grid">
                        {items.map((w) => (
                          <MediaCard
                            key={w.id}
                            work={w}
                            state={state}
                            onOpen={() => {
                              const series = state.series?.find(
                                (s) => s.id === w.id,
                              );
                              if (series)
                                enter({
                                  kind: "series-members",
                                  id: series.id,
                                });
                              else detail(w.id);
                            }}
                            draggable={reorder}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </section>
        )}
      </Fade>
      {add && (
        <FilePicker
          connections={state.connections}
          onClose={() => setAdd(false)}
        />
      )}
      {connect && <ConnectionWizard onClose={() => setConnect(false)} />}
      {newSeries && (
        <SeriesEditor
          state={state}
          initial={series}
          onClose={() => setNewSeries(false)}
        />
      )}
      {manage && (
        <CollectionEditor
          state={state}
          initial={collection}
          onClose={() => setManage(false)}
        />
      )}
      {removeGroup && (
        <Confirm
          title={t(
            removeGroup.kind === "collection"
              ? "removeCollection"
              : "dissolveSeries",
          )}
          description={t(
            removeGroup.kind === "collection"
              ? "removeCollectionBody"
              : "dissolveSeriesBody",
          )}
          action={
            removeGroup.kind === "series" ? t("dissolveSeries") : undefined
          }
          onClose={() => setRemoveGroup(null)}
          onConfirm={() => {
            const target = removeGroup;
            void window.tamki
              .library(
                target.kind === "collection"
                  ? "remove-collection"
                  : "remove-series",
                target.id,
              )
              .then(() => setRemoveGroup(null))
              .catch((e) => toast.error(errorMessage(e, t)));
          }}
        />
      )}
    </section>
  );
}
export function CollectionEditor({
  state,
  initial,
  onClose,
}: {
  state: LibraryState;
  initial?: Collection;
  onClose(): void;
}) {
  const t = useI18n();
  const [name, setName] = useState(initial?.name || ""),
    [ids, setIds] = useState(initial?.workIds || []),
    [seriesIds, setSeriesIds] = useState(initial?.seriesIds || []),
    [busy, setBusy] = useState(false);
  return (
    <>
      <Modal
        open
        title={initial ? t("manageCollections") : t("newCollection")}
        onClose={onClose}
        className="collection-modal"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !name.trim()}
              onClick={() => {
                setBusy(true);
                void window.tamki
                  .library("save-collection", {
                    id: initial?.id,
                    name,
                    workIds: ids.filter(
                      (id) =>
                        !state.series?.some(
                          (s) =>
                            seriesIds.includes(s.id) && s.workIds.includes(id),
                        ),
                    ),
                    seriesIds,
                  })
                  .then(onClose)
                  .catch((e) => toast.error(errorMessage(e, t)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("save")}
            </Button>
          </>
        }
      >
        <Fade className="modal-body">
          <FieldGroup>
            <FormField label={t("collectionName")} htmlFor="collection-name">
              <Input
                id="collection-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </FormField>
            <div>
              {(state.series || [])
                .filter((s) => s.workIds.length)
                .map((s) => (
                  <label className="folder-row" key={s.id}>
                    <Checkbox
                      checked={seriesIds.includes(s.id)}
                      onCheckedChange={() =>
                        setSeriesIds((old) =>
                          old.includes(s.id)
                            ? old.filter((id) => id !== s.id)
                            : [...old, s.id],
                        )
                      }
                    />
                    <TextTip>{s.name}</TextTip>
                    <Badge variant="secondary">{t("series")}</Badge>
                  </label>
                ))}
              {state.works
                .filter(
                  (w) =>
                    !state.series?.some(
                      (s) =>
                        seriesIds.includes(s.id) && s.workIds.includes(w.id),
                    ),
                )
                .map((w) => (
                  <label className="folder-row" key={w.id}>
                    <Checkbox
                      checked={ids.includes(w.id)}
                      onCheckedChange={() =>
                        setIds((old) =>
                          old.includes(w.id)
                            ? old.filter((id) => id !== w.id)
                            : [...old, w.id],
                        )
                      }
                    />
                    <TextTip>{w.title}</TextTip>
                  </label>
                ))}
            </div>
          </FieldGroup>
        </Fade>
      </Modal>
    </>
  );
}
export function DetailPage({
  work,
  state,
  onBack,
  onEdit,
  onPlay,
  onSelectWork,
}: {
  work: Work;
  state: LibraryState;
  onBack(): void;
  onEdit(): void;
  onPlay(episodeId?: string): void;
  onSelectWork?(id: string): void;
}) {
  const t = useI18n();
  const [remove, setRemove] = useState(false),
    [full, setFull] = useState(false),
    [manageSeries, setManageSeries] = useState(false);
  const series = state.series?.find((s) => s.workIds.includes(work.id));
  const ratio = progress(work),
    source = state.connections.find((c) => c.id === work.connectionId);
  return (
    <section className="page">
      <PageHeader
        title={series?.name || work.title}
        back={onBack}
        sub={
          series && (
            <div
              className="series-tabs"
              role="tablist"
              aria-label={series.name}
            >
              {seriesWorks(series, state).map((w) => (
                <Button
                  role="tab"
                  aria-selected={w.id === work.id}
                  variant={w.id === work.id ? "default" : "secondary"}
                  key={w.id}
                  onClick={() => onSelectWork?.(w.id)}
                >
                  <TextTip>{w.title}</TextTip>
                </Button>
              ))}
            </div>
          )
        }
      >
        <IconButton
          label={t(series ? "manageSeries" : "newSeries")}
          onClick={() => setManageSeries(true)}
        >
          <StackIcon />
        </IconButton>
        <IconButton label={t("editInfo")} onClick={onEdit}>
          <PencilSimpleIcon />
        </IconButton>
        <IconButton label={t("remove")} onClick={() => setRemove(true)}>
          <TrashIcon />
        </IconButton>
        <Button onClick={() => onPlay()}>
          <PlayIcon data-icon="inline-start" />
          {t(work.resumeId ? "resume" : "play")}
        </Button>
      </PageHeader>
      <Fade className="page-body">
        <div className="detail-hero">
          <Poster cover={work.cover} />
          <div className="detail-info">
            <InlineSynopsis
              text={work.description}
              title={work.title}
              lines={4}
            />
            <div className="detail-progress">
              <span>{Math.floor(ratio * 100)}%</span>
              <div className="progress-bar">
                <i style={{ width: `${ratio * 100}%` }} />
              </div>
            </div>
            <div className="detail-location">
              <FolderIcon />
              <TextTip>{`${source?.name || t("offline")} · ${work.path}`}</TextTip>
            </div>
            <Tags tags={work.tags} />
            <RecognitionStatus
              work={work}
              automatic={state.settings.recognition.automatic !== false}
              onEdit={onEdit}
            />
          </div>
        </div>
        <div className="episode-list">
          {work.episodes.map((e) => (
            <button
              className="episode-row"
              key={e.id}
              onClick={() => onPlay(e.id)}
              disabled={
                e.missing ||
                !state.connections.some((c) => c.id === e.connectionId)
              }
            >
              <Poster
                episode={e}
                probe={state.connections.some((c) => c.id === e.connectionId)}
              />
              <div className="episode-copy">
                <div>
                  <TextTip>{episodeName(e)}</TextTip>
                  <span className="episode-metrics">
                    {(e.versions?.length || 0) > 1 && (
                      <>
                        {t("versionCount").replace(
                          "{n}",
                          String(e.versions!.length),
                        )}{" "}
                        ·{" "}
                      </>
                    )}
                    {clock(e.duration)} ·{" "}
                    {Math.floor(
                      e.duration
                        ? Math.min(1, e.position / e.duration) * 100
                        : 0,
                    )}
                    %
                  </span>
                </div>
                <p>{e.description}</p>
              </div>
            </button>
          ))}
        </div>
      </Fade>
      {manageSeries && (
        <SeriesEditor
          state={state}
          initial={series}
          workId={work.id}
          onClose={() => setManageSeries(false)}
        />
      )}
      {remove && (
        <Confirm
          title={t("removeWorkTitle")}
          description={t("removeWorkBody")}
          onClose={() => setRemove(false)}
          onConfirm={() =>
            void window.tamki
              .library("remove-work", work.id)
              .then(onBack)
              .catch((e) => toast.error(errorMessage(e, t)))
          }
        />
      )}
      {full && (
        <Modal open title={t("synopsis")} onClose={() => setFull(false)}>
          <Fade className="modal-body">
            <p>{work.description}</p>
          </Fade>
        </Modal>
      )}
    </section>
  );
}
