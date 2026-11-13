import { useMemo, useState } from "react";
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
function storageNames(work: Work, state: LibraryState, offline: string) {
  return [
    ...new Set(
      work.episodes.map(
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
  const ratio = progress(work);
  const source = state.connections.find(
    (c) => c.id === work.episodes[0]?.connectionId,
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
        <Poster episode={work.episodes[0]} probe={source?.type === "local"} />
        <div className="card-progress">
          <i style={{ width: `${ratio * 100}%` }} />
        </div>
      </button>
      <div className="card-title">
        <button className="truncate" onClick={onOpen}>
          <TextTip>{work.title}</TextTip>
        </button>
        <span className="percent">{Math.floor(ratio * 100)}%</span>
      </div>
      <div className="card-meta">
        <span className="card-count">
          {work.episodes.length > 1
            ? `${work.episodes.length} ${t("episodeCount")}`
            : clock(work.episodes[0]?.duration)}
        </span>
        <TextTip>{storageNames(work, state, t("offline")).join(" · ")}</TextTip>
        <Tags tags={work.tags} />
      </div>
    </article>
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
    [collectionId, setCollectionId] = useState<string | null>(null),
    [manage, setManage] = useState(false);
  const collection = state.collections.find((c) => c.id === collectionId);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const works = useMemo(
    () =>
      state.works
        .filter(
          (w) =>
            (!collection || collection.workIds.includes(w.id)) &&
            w.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
            (filter === "all" ||
              (filter === "watching" &&
                progress(w) > 0 &&
                progress(w) < 0.999) ||
              (filter === "unwatched" && progress(w) === 0) ||
              (filter === "watched" && progress(w) >= 0.999)),
        )
        .sort((a, b) =>
          sort === "titleSort"
            ? a.title.localeCompare(b.title)
            : sort === "progressSort"
              ? progress(b) - progress(a)
              : sort === "manual"
                ? a.order - b.order
                : b.createdAt - a.createdAt,
        ),
    [state.works, filter, query, sort, collection],
  );
  const groups = useMemo(() => {
    const result = new Map<string, Work[]>();
    for (const w of works) {
      const keys =
        group === "bySource"
          ? storageNames(w, state, t("offline"))
          : group === "byTag"
            ? w.tags.length
              ? w.tags
              : [t("untagged")]
            : [""];
      for (const k of keys) result.set(k, [...(result.get(k) || []), w]);
    }
    return [...result];
  }, [works, group, state.connections]);
  const reorder =
    sort === "manual" &&
    group === "ungrouped" &&
    !query &&
    filter === "all" &&
    !collection;
  return (
    <section className="page">
      <PageHeader
        title={collection?.name || t("library")}
        back={
          collection
            ? () => {
                setCollectionId(null);
                setQuery("");
              }
            : undefined
        }
        sub={
          !collection && (
            <div className="library-toolbar">
              <ToggleGroup
                type="single"
                value={filter}
                onValueChange={(v) => v && setFilter(v)}
                aria-label={t("progress")}
              >
                {(["all", "watching", "unwatched", "watched"] as Message[]).map(
                  (key) => (
                    <ToggleGroupItem key={key} value={key}>
                      {t(key)}
                    </ToggleGroupItem>
                  ),
                )}
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
                <Search value={query} onChange={setQuery} label={t("search")} />
              </div>
            </div>
          )
        }
      >
        {!collection && (
          <>
            <IconButton label={t("settings")} onClick={settings}>
              <GearSixIcon />
            </IconButton>
            <IconButton label={t("tasks")} onClick={tasks}>
              <DownloadSimpleIcon />
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
        <IconButton
          label={collection ? t("manageCollections") : t("addFiles")}
          onClick={() =>
            collection
              ? setManage(true)
              : state.connections.length
                ? setAdd(true)
                : setConnect(true)
          }
        >
          <PlusIcon />
        </IconButton>
      </PageHeader>
      <Fade className="page-body">
        {!collection && state.works.length > 0 && (
          <div className="collection-strip">
            {state.collections.map((c) => (
              <Button
                key={c.id}
                variant="secondary"
                onClick={() => {
                  setCollectionId(c.id);
                  setQuery("");
                  setFilter("all");
                  setGroup("ungrouped");
                }}
              >
                <StackIcon data-icon="inline-start" />
                {c.name}
              </Button>
            ))}
            <Button variant="secondary" onClick={() => setManage(true)}>
              <PlusIcon data-icon="inline-start" />
              {t("newCollection")}
            </Button>
          </div>
        )}
        {!state.works.length ? (
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
                        onOpen={() => detail(w.id)}
                        draggable={reorder}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </Fade>
      {add && (
        <FilePicker
          connections={state.connections}
          onClose={() => setAdd(false)}
        />
      )}
      {connect && <ConnectionWizard onClose={() => setConnect(false)} />}
      {manage && (
        <CollectionEditor
          state={state}
          initial={collection}
          onClose={() => setManage(false)}
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
    [busy, setBusy] = useState(false);
  return (
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
                  workIds: ids,
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
            {state.works.map((w) => (
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
  );
}
export function DetailPage({
  work,
  state,
  onBack,
  onEdit,
  onPlay,
}: {
  work: Work;
  state: LibraryState;
  onBack(): void;
  onEdit(): void;
  onPlay(episodeId?: string): void;
}) {
  const t = useI18n();
  const [remove, setRemove] = useState(false),
    [full, setFull] = useState(false);
  const ratio = progress(work),
    source = state.connections.find((c) => c.id === work.connectionId);
  return (
    <section className="page">
      <PageHeader title={work.title} back={onBack}>
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
          <Poster episode={work.episodes[0]} probe={source?.type === "local"} />
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
                probe={
                  state.connections.find((c) => c.id === e.connectionId)
                    ?.type === "local"
                }
              />
              <div className="episode-copy">
                <div>
                  <TextTip>{episodeName(e)}</TextTip>
                  <span className="episode-metrics">
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
