import { useEffect, useRef, useState } from "react";
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
import { VideoTask, DownloadRate } from "./tasks";
import { TooltipProvider } from "./components/ui/tooltip";
import { IconButton } from "./common";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { toast, Toaster } from "sonner";
import { errorMessage } from "./i18n";

function Picker() {
  const [state, setState] = useState<TabPickerState>();
  useEffect(() => {
    const off = window.tamkiTabs.onState(setState);
    void window.tamkiTabs.action("state").then(setState);
    return off;
  }, []);
  useEffect(() => {
    if (!state) return;
    const update = () => applyTheme(state.preferences);
    update();
    const query = matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [state?.preferences]);
  return (
    state && (
      <LocaleContext value={state.preferences.language}>
        <TooltipProvider delayDuration={350}>
          <QuickPanel state={state} />
          <Toaster position="bottom-center" />
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
  return (
    <div
      className="native-tab-picker quick-panel"
      role="dialog"
      aria-label={t(state.mode === "history" ? "browserHistory" : "tasks")}
    >
      <header>
        <strong>
          {t(state.mode === "history" ? "browserHistory" : "tasks")}
        </strong>
      </header>
      {state.mode === "history" ? (
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("search")}
          />
          <CommandList>
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
            <CommandEmpty>{t("noResults")}</CommandEmpty>
          </CommandList>
        </Command>
      ) : (
        <>
          <div className="quick-task-list">
            {(state.jobs || []).map((job) => (
              <VideoTask
                key={job.id}
                job={job}
                onPlayEpisode={(_episodeId, itemId) =>
                  void window.tamkiTabs
                    .action("play-download", { jobId: job.id, itemId })
                    .catch((error) => toast.error(errorMessage(error, t)))
                }
                onCommand={(action, itemId) =>
                  window.tamkiTabs.action("download-action", {
                    id: job.id,
                    action,
                    itemId,
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
                        state:
                          task.state === "interrupted" ? "failed" : task.state,
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
              <p>{t("downloadNoMatches")}</p>
            )}
          </div>
          <button
            className="quick-all-tasks"
            onClick={() => void window.tamkiTabs.action("all-tasks")}
          >
            {t("allTasks")}
          </button>
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
      <Command>
        <CommandInput
          ref={input}
          value={query}
          onValueChange={setQuery}
          placeholder={t("allTabs")}
        />
        <CommandList ref={list}>
          <CommandEmpty>{t("noResults")}</CommandEmpty>
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
document.documentElement.classList.add("tab-picker-surface");
createRoot(document.getElementById("root")!).render(<Picker />);
