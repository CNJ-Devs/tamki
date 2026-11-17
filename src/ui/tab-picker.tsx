import { Input } from "./components/ui/input";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "./components/ui/input-group";
import { PencilSimpleIcon, TrashIcon, StarIcon } from "@phosphor-icons/react";
import type { BrowserBookmark } from "../shared/model";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { GlobeIcon, HouseIcon, PlayCircleIcon } from "@phosphor-icons/react";
import type { TabPickerState } from "../shared/model";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "./components/ui/command";
import { LocaleContext, useI18n } from "./i18n";
import { applyTheme } from "./theme";
import {
  VideoTask,
  DownloadRate,
  TaskSelectionBar,
  type TaskAction,
} from "./tasks";
import { TooltipProvider } from "./components/ui/tooltip";
import { Button, IconButton, Confirm } from "./common";
import {
  PauseIcon,
  PlayIcon,
  MagnifyingGlassIcon,
  DownloadSimpleIcon,
  ClockCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { toast, Toaster } from "sonner";
import { errorMessage } from "./i18n";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty";

function PanelEmpty({ title, icon }: { title: string; icon: ReactNode }) {
  return (
    <Empty className="quick-panel-empty" role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

export function Picker({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<TabPickerState>();
  useEffect(() => {
    const off = window.tamkiTabs.onState(setState);
    void window.tamkiTabs.action("state").then(setState);
    return off;
  }, []);
  useEffect(() => {
    if (!state || embedded) return;
    const update = () => applyTheme(state.preferences);
    update();
    const query = matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [state?.preferences, embedded]);
  return (
    state && (
      <LocaleContext value={state.preferences.language}>
        <TooltipProvider delayDuration={350}>
          <QuickPanel state={state} />
          {!embedded && <Toaster position="bottom-center" />}
        </TooltipProvider>
      </LocaleContext>
    )
  );
}

function QuickPanel({ state }: { state: TabPickerState }) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [state.mode, state.browser.pickerOpen]);
  if (!state.mode || state.mode === "tabs") return <TabSearch state={state} />;
  if (state.mode === "address")
    return (
      <div
        className="native-tab-picker address-suggestions"
        role="listbox"
        aria-label={t("addressSuggestions")}
      >
        {state.suggestions?.length ? (
          state.suggestions.map((item, index) => (
            <button
              role="option"
              aria-selected={state.suggestionIndex === index}
              key={item.url}
              onClick={() =>
                void window.tamkiTabs.action("open-suggestion", item.url)
              }
            >
              <span className="tab-picker-copy">
                <b>{item.title || item.url}</b>
                <small>{item.url}</small>
              </span>
            </button>
          ))
        ) : (
          <p>{t("noResults")}</p>
        )}
      </div>
    );
  if (state.mode === "bookmarks") return <Bookmarks state={state} />;
  if (state.mode === "tasks") return <QuickTasks state={state} />;
  return (
    <div
      className="native-tab-picker quick-panel"
      role="dialog"
      aria-label={t("browserHistory")}
    >
      <header className="quick-panel-header">
        <strong>{t("browserHistory")}</strong>
      </header>
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("search")}
        />
        <CommandList>
          <CommandGroup>
            {(state.history || [])
              .filter((entry) =>
                `${entry.title} ${entry.url}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((entry) => (
                <CommandItem
                  key={entry.url}
                  value={entry.url}
                  onSelect={() =>
                    void window.tamkiTabs.action("open-history", entry.url)
                  }
                >
                  <span className="tab-picker-copy">
                    <b>{entry.title}</b>
                    <small>{entry.url}</small>
                    <small>
                      {new Date(entry.time).toLocaleString(
                        state.preferences.language,
                      )}
                    </small>
                  </span>
                </CommandItem>
              ))}
          </CommandGroup>
          <CommandEmpty className="quick-panel-command-empty">
            <PanelEmpty
              title={t(
                state.history?.length ? "noResults" : "noBrowserHistory",
              )}
              icon={
                state.history?.length ? (
                  <MagnifyingGlassIcon />
                ) : (
                  <ClockCounterClockwiseIcon />
                )
              }
            />
          </CommandEmpty>
        </CommandList>
      </Command>
    </div>
  );
}

function QuickTasks({ state }: { state: TabPickerState }) {
  const t = useI18n();
  const [selected, setSelected] = useState(() => new Set<string>());
  const [confirmation, setConfirmation] = useState<"cancel" | "remove" | null>(
    null,
  );
  const jobs = state.jobs || [];
  const items = jobs.flatMap((job) => job.items);
  const toggle = (ids: string[], checked: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      for (const id of ids)
        if (checked) next.add(id);
        else next.delete(id);
      return next;
    });
  const batch = async (action: TaskAction) => {
    const results = await Promise.allSettled(
      jobs.flatMap((job) => {
        const itemIds = job.items
          .filter((item) => selected.has(item.id))
          .map((item) => item.id);
        return itemIds.length
          ? [
              window.tamkiTabs.action("download-action", {
                id: job.id,
                action,
                itemIds,
              }),
            ]
          : [];
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      toast.error(errorMessage(failed.reason, t));
    if (action === "remove") setSelected(new Set());
  };
  return (
    <div
      className="native-tab-picker quick-panel"
      role="dialog"
      aria-label={t("tasks")}
    >
      <header className="quick-panel-header">
        <strong>{t("tasks")}</strong>
        {!!items.length && (
          <TaskSelectionBar
            items={items}
            selected={selected}
            toggleAll={(checked) =>
              toggle(
                items.map((item) => item.id),
                checked,
              )
            }
            command={(action) => {
              if (action === "cancel" || action === "remove")
                setConfirmation(action);
              else void batch(action);
            }}
          />
        )}
      </header>
      <div className="quick-task-list">
        {(state.jobs || []).map((job) => (
          <VideoTask
            key={job.id}
            job={job}
            selection={selected}
            onSelection={toggle}
            onPlayEpisode={(_episodeId, itemId) =>
              void window.tamkiTabs
                .action("play-download", { jobId: job.id, itemId })
                .catch((error) => toast.error(errorMessage(error, t)))
            }
            onCommand={(action, itemId) =>
              window.tamkiTabs.action("download-action", {
                id: job.id,
                action,
                ...(Array.isArray(itemId) ? { itemIds: itemId } : { itemId }),
              })
            }
          />
        ))}
        {(state.transfers || []).map((task) => (
          <div className="quick-task" key={task.id}>
            <b>{task.name}</b>
            <small>
              {t(task.state)} · {Math.round(task.received / 1048576)} MiB
              <DownloadRate
                items={[
                  {
                    id: task.id,
                    state: task.state === "interrupted" ? "failed" : task.state,
                    stage: "transferring",
                    received: task.received,
                  },
                ]}
              />
            </small>
            {["running", "paused", "interrupted"].includes(task.state) && (
              <IconButton
                label={t(
                  task.state === "running" ? "pause" : "resumeDownloadTask",
                )}
                onClick={() =>
                  void window.tamkiTabs
                    .action("transfer-action", {
                      id: task.id,
                      action: task.state === "running" ? "pause" : "resume",
                    })
                    .catch((error) => toast.error(errorMessage(error, t)))
                }
              >
                {task.state === "running" ? <PauseIcon /> : <PlayIcon />}
              </IconButton>
            )}
          </div>
        ))}
        {!state.jobs?.length && !state.transfers?.length && (
          <PanelEmpty title={t("emptyTasks")} icon={<DownloadSimpleIcon />} />
        )}
      </div>
      <Button
        variant="secondary"
        className="quick-all-tasks"
        onClick={() => void window.tamkiTabs.action("all-tasks")}
      >
        {t("allTasks")}
      </Button>

      {confirmation && (
        <Confirm
          title={t(
            confirmation === "cancel"
              ? "downloadCancelTitle"
              : "removeDownloadTask",
          )}
          description={t(
            confirmation === "cancel"
              ? "downloadCancelBody"
              : "removeDownloadTaskBody",
          )}
          action={t(
            confirmation === "cancel"
              ? "downloadCancelAction"
              : "removeDownloadTask",
          )}
          onClose={() => setConfirmation(null)}
          onConfirm={() => {
            void batch(confirmation);
            setConfirmation(null);
          }}
        />
      )}
    </div>
  );
}

function Bookmarks({ state }: { state: TabPickerState }) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<BrowserBookmark | null>(null);
  const perform = async (type: string, value: unknown) => {
    try {
      await window.tamkiTabs.action(type, value);
      return true;
    } catch {
      toast.error(t("bookmarkInvalid"));
      return false;
    }
  };
  const items = (state.browser.bookmarks || []).filter((b) =>
    `${b.title} ${b.url}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <div
      className="native-tab-picker bookmark-panel"
      role="dialog"
      aria-label={t("bookmarks")}
    >
      <header className="quick-panel-header">
        <strong>{t("bookmarks")}</strong>
      </header>
      {edit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform("bookmark-edit", edit).then((ok) => {
              if (ok) setEdit(null);
            });
          }}
        >
          <label>
            {t("bookmarkTitle")}
            <Input
              value={edit.title}
              maxLength={500}
              required
              onChange={(e) => setEdit({ ...edit, title: e.target.value })}
            />
          </label>
          <label>
            {t("bookmarkURL")}
            <Input
              value={edit.url}
              maxLength={8192}
              required
              onChange={(e) => setEdit({ ...edit, url: e.target.value })}
            />
          </label>
          <div className="bookmark-edit-actions">
            <Button variant="secondary" onClick={() => setEdit(null)}>
              {t("browserCancel")}
            </Button>
            <Button type="submit">{t("saveBookmark")}</Button>
          </div>
        </form>
      ) : (
        <>
          <InputGroup>
            <InputGroupInput
              autoFocus
              aria-label={t("search")}
              placeholder={t("search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
          </InputGroup>
          <div className="bookmark-list">
            {items.map((b) => (
              <div className="bookmark-row" key={b.id}>
                <button
                  className="bookmark-open"
                  onClick={() => void perform("bookmark-open", b.id)}
                >
                  <StarIcon />
                  <span className="tab-picker-copy">
                    <b>{b.title}</b>
                    <small>{b.url}</small>
                  </span>
                </button>
                <IconButton
                  label={t("editBookmark")}
                  onClick={() => setEdit(b)}
                >
                  <PencilSimpleIcon />
                </IconButton>
                <IconButton
                  label={t("removeBookmark")}
                  onClick={() => void perform("bookmark-remove", b.id)}
                >
                  <TrashIcon />
                </IconButton>
              </div>
            ))}
            {!items.length && (
              <PanelEmpty
                title={t(
                  state.browser.bookmarks?.length ? "noResults" : "noBookmarks",
                )}
                icon={
                  state.browser.bookmarks?.length ? (
                    <MagnifyingGlassIcon />
                  ) : (
                    <StarIcon />
                  )
                }
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TabSearch({ state }: { state: TabPickerState }) {
  const t = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (state.browser.pickerOpen) {
      setQuery("");
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [state.browser.pickerOpen]);
  const choose = (id: number) => void window.tamkiTabs.action("select", id);
  return (
    <div
      className="native-tab-picker"
      role="dialog"
      aria-label={t("allTabs")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void window.tamkiTabs.action("dismiss");
        }
      }}
    >
      <header className="quick-panel-header">
        <strong>{t("allTabs")}</strong>
      </header>
      <Command>
        <CommandInput
          ref={input}
          value={query}
          onValueChange={setQuery}
          placeholder={t("search")}
        />
        <CommandList ref={list}>
          <CommandEmpty className="quick-panel-command-empty">
            <PanelEmpty title={t("noResults")} icon={<MagnifyingGlassIcon />} />
          </CommandEmpty>
          <CommandGroup>
            <CommandItem
              value={`0 ${t("home")} ${t("library")}`}
              onSelect={() => choose(0)}
            >
              <HouseIcon />
              <span>{t("library")}</span>
            </CommandItem>
            {state.browser.tabs.map((tab) => (
              <CommandItem
                key={tab.id}
                value={`${tab.id} ${tab.title} ${tab.url}`}
                onSelect={() => choose(tab.id)}
              >
                {tab.kind === "player" ? <PlayCircleIcon /> : <GlobeIcon />}
                <span className="tab-picker-copy">
                  <b>{tab.title || t("newTab")}</b>
                  <small>{tab.url}</small>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
if (location.pathname.endsWith("/tab-picker.html")) {
  document.documentElement.classList.add("tab-picker-surface");
  createRoot(document.getElementById("root")!).render(<Picker />);
}
