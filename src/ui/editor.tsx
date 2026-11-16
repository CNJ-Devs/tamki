import { episodeVersions } from "../shared/versions";
import { useState } from "react";
import {
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TrashIcon,
  DotsSixVerticalIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Episode, LibraryState, Work } from "../shared/model";
import { episodeName } from "../shared/model";
import {
  Button,
  IconButton,
  PageHeader,
  Fade,
  FormField,
  TextTip,
  Confirm,
  clock,
} from "./common";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { FieldGroup } from "./components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Badge } from "./components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from "./components/ui/command";
import { useI18n, errorMessage } from "./i18n";
import { toast } from "sonner";
import { RecognitionFlow } from "./recognition-flow";
import type { RecognitionRequest } from "../shared/recognition";
import { FilePicker } from "./connections";
const editable = (work: Work) => ({
  title: work.title,
  description: work.description,
  tags: work.tags,
  cover: work.cover,
  episodes: work.episodes.map(({ id, number, title, description }) => ({
    id,
    number,
    title,
    description,
  })),
});
function EpisodeRow({
  episode,
  edit,
  remove,
}: {
  episode: Episode;
  edit(): void;
  remove(): void;
}) {
  const t = useI18n();
  const drag = useSortable({ id: episode.id });
  return (
    <div
      ref={drag.setNodeRef}
      className="edit-episode-row"
      style={{
        transform: CSS.Transform.toString(drag.transform),
        transition: drag.transition,
      }}
      {...drag.attributes}
      {...drag.listeners}
      onClick={() => !drag.isDragging && edit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          edit();
        } else drag.listeners?.onKeyDown?.(e);
      }}
    >
      <DotsSixVerticalIcon aria-label={t("reorder")} />
      <TextTip>{episodeName(episode)}</TextTip>
      <span className="muted">{clock(episode.duration)}</span>
      <div
        className="actions"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <IconButton label={t("edit")} onClick={edit}>
          <PencilSimpleIcon />
        </IconButton>
        <IconButton label={t("remove")} onClick={remove}>
          <TrashIcon />
        </IconButton>
      </div>
    </div>
  );
}
export function MetadataEditor({
  work,
  state,
  onBack,
}: {
  work: Work;
  state: LibraryState;
  onBack(): void;
}) {
  const t = useI18n();
  const [draft, setDraft] = useState(() => structuredClone(work)),
    [baseline, setBaseline] = useState(() => editable(work)),
    [tab, setTab] = useState("work"),
    [episodeId, setEpisodeId] = useState<string | null>(null),
    [discard, setDiscard] = useState(false),
    [remove, setRemove] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [tag, setTag] = useState(""),
    [tagsOpen, setTagsOpen] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [adding, setAdding] = useState(false);
  const episode = draft.episodes.find((e) => e.id === episodeId);
  const dirty = JSON.stringify(editable(draft)) !== JSON.stringify(baseline);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const setEpisode = (patch: Partial<Episode>) =>
    setDraft((old) => ({
      ...old,
      episodes: old.episodes.map((e) =>
        e.id === episodeId ? { ...e, ...patch } : e,
      ),
    }));
  const addTag = (value: string) => {
    const clean = value.trim().slice(0, 100);
    if (clean)
      setDraft((old) => ({ ...old, tags: [...new Set([...old.tags, clean])] }));
    setTag("");
    setTagsOpen(false);
  };
  const suggestions = [...new Set(state.works.flatMap((w) => w.tags))].filter(
    (s) =>
      !draft.tags.includes(s) &&
      s.toLocaleLowerCase().includes(tag.toLocaleLowerCase()),
  );
  const editInput = (value: Work): RecognitionRequest["draft"] => ({
    id: value.id,
    title: value.title,
    description: value.description,
    tags: value.tags,
    cover: value.cover,
    removedEpisodeIds: baseline.episodes
      .filter((e) => !value.episodes.some((current) => current.id === e.id))
      .map((e) => e.id),
    attachments: value.episodes
      .filter((e) => !baseline.episodes.some((old) => old.id === e.id))
      .map((e) => ({ connectionId: e.connectionId, path: e.path })),
    episodes: value.episodes.map(({ id, number, title, description }) => ({
      id,
      number,
      title,
      description,
    })),
  });
  const persist = async (value: Work, metadataReviewed = false) => {
    const updated = await window.tamki.library<LibraryState>("edit", {
      ...editInput(value),
      metadataReviewed,
    });
    const saved = updated.works.find((w) => w.id === value.id) || value;
    setDraft(saved);
    setBaseline(editable(saved));
  };
  const save = async () => {
    setSaving(true);
    try {
      await persist(draft);
      onBack();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="page">
      <PageHeader
        title={episode ? episodeName(episode) : t("editInfo")}
        back={() =>
          episode ? setEpisodeId(null) : dirty ? setDiscard(true) : onBack()
        }
        sub={
          !episode && (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="work">{t("work")}</TabsTrigger>
                <TabsTrigger value="episodes">{t("episodes")}</TabsTrigger>
              </TabsList>
            </Tabs>
          )
        }
      >
        <Button
          variant="secondary"
          disabled={saving || !draft.episodes.length || !draft.title.trim()}
          onClick={() => setRecognizing(true)}
        >
          <MagnifyingGlassIcon data-icon="inline-start" />
          {t(episode ? "recognizeEpisode" : "recognizeWork")}
        </Button>
        {!episode && tab === "episodes" && (
          <Button
            variant="secondary"
            disabled={!state.connections.length}
            onClick={() => setAdding(true)}
          >
            <PlusIcon data-icon="inline-start" />
            {t("appendEpisodes")}
          </Button>
        )}
        <Button
          disabled={saving || !draft.title.trim()}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
      </PageHeader>
      <Fade className="page-body">
        <div className="editor-content">
          {episode ? (
            <FieldGroup>
              <div className="episode-fields">
                <FormField label={t("episodeNumber")} htmlFor="episode-number">
                  <Input
                    id="episode-number"
                    value={episode.number}
                    maxLength={100}
                    onChange={(e) => setEpisode({ number: e.target.value })}
                  />
                </FormField>
                <FormField label={t("episodeTitle")} htmlFor="episode-title">
                  <Input
                    id="episode-title"
                    value={episode.title}
                    maxLength={500}
                    onChange={(e) => setEpisode({ title: e.target.value })}
                  />
                </FormField>
              </div>
              <FormField label={t("description")} htmlFor="episode-description">
                <Textarea
                  id="episode-description"
                  value={episode.description}
                  maxLength={30000}
                  onChange={(e) => setEpisode({ description: e.target.value })}
                />
              </FormField>
              {episodeVersions(episode).map((version, index) => (
                <div key={version.id} className="episode-version-facts">
                  {(episode.versions?.length || 0) > 1 && (
                    <strong>
                      {version.label ||
                        t("versionNumber").replace("{n}", String(index + 1))}
                    </strong>
                  )}
                  {version.files.map((file) => (
                    <div key={file.id} className="file-facts">
                      <span>{t("fileName")}</span>
                      <TextTip>{file.fileName}</TextTip>
                      <span>{t("duration")}</span>
                      <span>{clock(file.duration)}</span>
                      <span>{t("location")}</span>
                      <TextTip>{`${state.connections.find((c) => c.id === file.connectionId)?.name || t("offline")} · ${file.path}`}</TextTip>
                    </div>
                  ))}
                </div>
              ))}
            </FieldGroup>
          ) : tab === "work" ? (
            <FieldGroup>
              <FormField label={t("name")} htmlFor="work-title">
                <Input
                  id="work-title"
                  value={draft.title}
                  maxLength={500}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </FormField>
              <FormField label={t("description")} htmlFor="work-description">
                <Textarea
                  id="work-description"
                  value={draft.description}
                  maxLength={30000}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </FormField>
              <FormField label={t("tags")}>
                <div className="tag-editor">
                  {draft.tags.map((tag) => (
                    <Badge variant="secondary" key={tag}>
                      <TextTip>{tag}</TextTip>
                      <button
                        aria-label={`${t("remove")} ${tag}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            tags: draft.tags.filter((s) => s !== tag),
                          })
                        }
                      >
                        <XIcon />
                      </button>
                    </Badge>
                  ))}
                  <Popover open={tagsOpen} onOpenChange={setTagsOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="secondary" size="sm">
                        <PlusIcon data-icon="inline-start" />
                        {t("addTag")}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="tag-popover">
                      <Command shouldFilter={false}>
                        <CommandInput
                          placeholder={t("tagPlaceholder")}
                          value={tag}
                          onValueChange={setTag}
                        />
                        <CommandList>
                          <CommandGroup>
                            {tag.trim() && !draft.tags.includes(tag.trim()) && (
                              <CommandItem onSelect={() => addTag(tag)}>
                                <PlusIcon />
                                {tag.trim()}
                              </CommandItem>
                            )}
                            {suggestions.map((s) => (
                              <CommandItem key={s} onSelect={() => addTag(s)}>
                                {s}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              </FormField>
            </FieldGroup>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (over && active.id !== over.id)
                  setDraft((old) => ({
                    ...old,
                    episodes: arrayMove(
                      old.episodes,
                      old.episodes.findIndex((e) => e.id === active.id),
                      old.episodes.findIndex((e) => e.id === over.id),
                    ),
                  }));
              }}
            >
              <SortableContext
                items={draft.episodes.map((e) => e.id)}
                strategy={verticalListSortingStrategy}
              >
                {draft.episodes.map((e) => (
                  <EpisodeRow
                    key={e.id}
                    episode={e}
                    edit={() => setEpisodeId(e.id)}
                    remove={() => setRemove(e.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </Fade>
      {recognizing && (
        <RecognitionFlow
          work={draft}
          config={state.settings.recognition}
          connections={state.settings.aiConnections}
          episodeId={episode?.id}
          draftInput={editInput(draft)}
          onApply={async (value) => {
            await persist(value, !episode);
            onBack();
          }}
          onClose={() => setRecognizing(false)}
        />
      )}
      {adding && (
        <FilePicker
          connections={state.connections}
          title={t("appendEpisodes")}
          onClose={() => setAdding(false)}
          onSelect={async (connectionId, paths) => {
            const additions = await window.tamki.library<Episode[]>(
              "prepare-episodes",
              { workId: work.id, connectionId, paths },
            );
            setDraft((old) => ({
              ...old,
              episodes: [
                ...old.episodes,
                ...additions.filter(
                  (e) => !old.episodes.some((current) => current.id === e.id),
                ),
              ],
            }));
          }}
        />
      )}
      {discard && (
        <Confirm
          title={t("discardTitle")}
          description={t("discardBody")}
          action={t("discard")}
          onClose={() => setDiscard(false)}
          onConfirm={onBack}
        />
      )}
      {remove && (
        <Confirm
          title={t("removeEpisode")}
          description={t("removeEpisodeBody")}
          onClose={() => setRemove(null)}
          onConfirm={() => {
            setDraft({
              ...draft,
              episodes: draft.episodes.filter((e) => e.id !== remove),
            });
            setRemove(null);
          }}
        />
      )}
    </section>
  );
}
