import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Tasks } from "./tasks";
import { Toaster, toast } from "sonner";
import {
  StarIcon,
  SlidersHorizontalIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  DotsThreeIcon,
  CaretUpIcon,
  HouseIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  GlobeIcon,
  PlayCircleIcon,
  PlusIcon,
  XIcon,
  CaretDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowClockwiseIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import type { BrowserState, BrowserTab, LibraryState } from "../shared/model";
import { Button, IconButton, PageHeader, Fade, TextTip, Blank } from "./common";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "./components/ui/input-group";
import { LibraryPage, DetailPage } from "./library-page";
import { Settings } from "./settings";
import { MetadataEditor } from "./editor";
import { Player } from "./player";
import { Picker } from "./tab-picker";
import { useLibraryDurations } from "./media";
import { LocaleContext, useI18n, errorMessage } from "./i18n";
import { applyTheme } from "./theme";
import { cn } from "./lib/utils";
function BrowserFind({
  tab,
  act,
}: {
  tab: BrowserTab;
  act: (type: string, value?: unknown) => Promise<unknown>;
}) {
  const t = useI18n(),
    input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(tab.find?.text || "");
  useEffect(
    () =>
      window.tamki.onFocusFind(() => {
        input.current?.focus();
        input.current?.select();
      }),
    [],
  );
  return (
    <div className="browser-find" role="search" aria-label={t("findPage")}>
      <InputGroup>
        <InputGroupInput
          ref={input}
          autoFocus
          aria-label={t("findPage")}
          placeholder={t("findPage")}
          value={text}
          maxLength={1000}
          onChange={(e) => {
            setText(e.target.value);
            void act("find", { text: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              void act("find-close");
            } else if (e.key === "Enter") {
              e.preventDefault();
              void act("find", { text, next: true, forward: !e.shiftKey });
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <span aria-live="polite">
            {text
              ? tab.find?.matches
                ? `${tab.find.active}/${tab.find.matches}`
                : t("noMatches")
              : ""}
          </span>
        </InputGroupAddon>
      </InputGroup>
      <IconButton
        label={t("findPrevious")}
        disabled={!tab.find?.matches}
        onClick={() => void act("find", { text, next: true, forward: false })}
      >
        <CaretUpIcon />
      </IconButton>
      <IconButton
        label={t("findNext")}
        disabled={!tab.find?.matches}
        onClick={() => void act("find", { text, next: true, forward: true })}
      >
        <CaretDownIcon />
      </IconButton>
      <IconButton label={t("closeFind")} onClick={() => void act("find-close")}>
        <XIcon />
      </IconButton>
    </div>
  );
}
function App() {
  const [state, setState] = useState<LibraryState>();
  useLibraryDurations(state);
  useEffect(() => {
    const off = window.tamki.onLibrary(setState);
    const offDownloads = window.tamki.onDownloads((videoDownloads) =>
      setState((previous) =>
        previous ? { ...previous, videoDownloads } : previous,
      ),
    );
    void window.tamki.library("state").then(setState);
    return () => {
      off();
      offDownloads();
    };
  }, []);
  useEffect(() => {
    if (!state) return;
    const update = () => applyTheme(state.preferences);
    update();
    const query = matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [state?.preferences]);
  if (!state) return null;
  return (
    <LocaleContext value={state.preferences.language}>
      <TooltipProvider delayDuration={350}>
        <Shell state={state} />
        <Toaster
          position="bottom-center"
          offset={24}
          theme={
            document.documentElement.dataset.mode === "dark" ? "dark" : "light"
          }
        />
      </TooltipProvider>
    </LocaleContext>
  );
}
function Shell({ state }: { state: LibraryState }) {
  const t = useI18n();
  const [browser, setBrowser] = useState<BrowserState>({
      active: 0,
      tabs: [],
      pickerOpen: false,
    }),
    [page, setPage] = useState("library"),
    [workId, setWorkId] = useState<string | null>(null),
    [requests, setRequests] = useState<
      Record<string, { id: string; nonce: number }>
    >({}),
    [address, setAddress] = useState(""),
    [error, setError] = useState("");
  const draggedTab = useRef<number | null>(null);
  const addressRef = useRef<HTMLInputElement>(null),
    strip = useRef<HTMLDivElement>(null),
    pickerTrigger = useRef<HTMLButtonElement>(null);
  const [density, setDensity] = useState("normal"),
    [tabWidth, setTabWidth] = useState(200);
  const act = useCallback(
    async (type: string, value?: unknown) => {
      try {
        // Suggestion layout/selection refreshes may arrive after a rejected
        // navigation. Keep its error visible until input or another action.
        if (type !== "address-suggest" && type !== "address-step") setError("");
        const b = await window.tamki.action(type, value);
        setBrowser(b);
        return b;
      } catch (e) {
        setError(errorMessage(e, t));
      }
    },
    [t],
  );
  useEffect(() => {
    const off = window.tamki.onState(setBrowser);
    const offPage = window.tamki.onOpenPage(setPage);
    const offPlayDownload = window.tamki.onPlayDownload(
      ({ workId, episodeId }) => {
        setRequests((old) => ({
          ...old,
          [workId]: { id: episodeId, nonce: Date.now() },
        }));
        void act("play", workId);
      },
    );
    void window.tamki.action("state").then(setBrowser);
    const focus = window.tamki.onFocusAddress(() => {
      requestAnimationFrame(() => {
        addressRef.current?.focus();
        addressRef.current?.select();
      });
    });
    const focusTabs = window.tamki.onFocusTabs(() => {
      const actions = document.querySelector<HTMLElement>(".browser-actions");
      const index = ["tabs", "bookmarks", "history", "tasks"].indexOf(
        actions?.dataset.pickerMode || "tabs",
      );
      const button =
        actions?.querySelectorAll<HTMLButtonElement>(":scope > button")[
          Math.max(0, index)
        ];
      (button || pickerTrigger.current)?.focus();
    });
    return () => {
      off();
      offPage();
      offPlayDownload();
      focus();
      focusTabs();
    };
  }, []);
  const suggest = (query: string) => {
    const bounds = addressRef.current
      ?.closest('[data-slot="input-group"]')
      ?.getBoundingClientRect();
    if (bounds)
      void act("address-suggest", {
        query,
        x: bounds.left,
        y: bounds.bottom + 4,
        width: bounds.width,
      });
  };
  const current = browser.tabs.find((tab) => tab.id === browser.active),
    work = state.works.find((w) => w.id === workId);
  useEffect(() => {
    if (!browser.pickerOpen || browser.pickerMode !== "address") return;
    const group = addressRef.current?.closest('[data-slot="input-group"]');
    if (!group) return;
    const observer = new ResizeObserver(() =>
      suggest(addressRef.current?.value || ""),
    );
    observer.observe(group);
    return () => observer.disconnect();
  }, [browser.pickerOpen, browser.pickerMode, current?.id]);
  useEffect(() => {
    if (document.activeElement !== addressRef.current)
      setAddress(current?.url === "about:blank" ? "" : current?.url || "");
  }, [current?.url, current?.id]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const update = () => {
      const width = Math.max(
        32,
        Math.min(
          202,
          (el.clientWidth - (window.tamki.platform === "darwin" ? 320 : 200)) /
            Math.max(1, browser.tabs.length),
        ),
      );
      setTabWidth(width);
      setDensity(width < 66 ? "icons" : width < 120 ? "tight" : "normal");
    };
    const ob = new ResizeObserver(update);
    ob.observe(el);
    update();
    return () => ob.disconnect();
  }, [browser.tabs.length]);
  const play = (id: string, episodeId?: string) => {
    if (episodeId)
      setRequests((old) => ({
        ...old,
        [id]: { id: episodeId, nonce: Date.now() },
      }));
    void act("play", id);
  };
  const openDetail = (id: string) => {
    setWorkId(id);
    setPage("detail");
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void act("address-accept", address);
    addressRef.current?.blur();
  };
  return (
    <div
      className="app-shell"
      data-platform={window.tamki.platform}
      data-picker-open={browser.pickerOpen && browser.pickerMode !== "address"}
      data-panel-overlay={
        browser.pickerOpen &&
        browser.pickerMode !== "address" &&
        current?.kind === "web" &&
        /^https?:/.test(current.url) &&
        !current.error
      }
      onPointerDown={(event) => {
        if (
          browser.pickerOpen &&
          !(event.target as Element).closest(
            ".browser-actions, .browser-address",
          )
        )
          void act("tabs-dismiss");
      }}
    >
      <div className="tabstrip" ref={strip}>
        {window.tamki.platform === "darwin" && (
          <div className="window-controls-space" aria-hidden="true" />
        )}
        <button
          className={cn("home-tab", browser.active === 0 && "selected")}
          aria-label={t("home")}
          aria-current={browser.active === 0 ? "page" : undefined}
          onClick={() => void act("select", 0)}
        >
          <HouseIcon />
        </button>
        <Fade
          horizontal
          className="web-tabs"
          data-density={density}
          style={{ "--tab-width": `${tabWidth}px` } as React.CSSProperties}
        >
          {browser.tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn("web-tab", tab.id === browser.active && "selected")}
              draggable
              onDragStart={(e) => {
                draggedTab.current = tab.id;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(
                  "application/x-tamki-tab",
                  String(tab.id),
                );
              }}
              onDragEnd={() => {
                draggedTab.current = null;
              }}
              onDragOver={(e) => {
                if (draggedTab.current !== null) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = draggedTab.current;
                draggedTab.current = null;
                if (id === null) return;
                const bounds = e.currentTarget.getBoundingClientRect();
                void act("tab-reorder", {
                  id,
                  before: tab.id,
                  after: e.clientX > bounds.left + bounds.width / 2,
                });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                void act("tab-menu", tab.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void act("close", tab.id);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
            >
              <span className="tab-rule left" />
              <button
                className="tab-select"
                aria-label={tab.title || t("newTab")}
                aria-current={tab.id === browser.active ? "page" : undefined}
                onClick={() => void act("select", tab.id)}
              >
                {tab.kind === "player" ? (
                  <PlayCircleIcon />
                ) : tab.favicon && !tab.loading ? (
                  <img
                    className="browser-favicon"
                    src={tab.favicon}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <GlobeIcon className={tab.loading ? "spin" : undefined} />
                )}
                <TextTip>{tab.title || t("newTab")}</TextTip>
              </button>
              {tab.kind === "web" && (tab.audible || tab.muted) && (
                <button
                  className="tab-sound"
                  aria-label={t(tab.muted ? "unmuteTab" : "muteTab")}
                  onClick={() => void act("tab-mute", tab.id)}
                >
                  {tab.muted ? <SpeakerSlashIcon /> : <SpeakerHighIcon />}
                </button>
              )}
              <button
                className="close-tab"
                aria-label={`${t("close")} ${tab.title || t("newTab")}`}
                onClick={() => void act("close", tab.id)}
              >
                <XIcon />
              </button>
              <span className="tab-rule right" />
            </div>
          ))}
        </Fade>
        <IconButton
          label={t("newTab")}
          className="add-tab"
          onClick={() => void act("new")}
        >
          <PlusIcon />
        </IconButton>
        <div className="tabstrip-space" />
        <div className="browser-actions" data-picker-mode={browser.pickerMode}>
          <IconButton
            ref={pickerTrigger}
            label={t("allTabs")}
            aria-haspopup="dialog"
            aria-expanded={browser.pickerOpen && browser.pickerMode === "tabs"}
            onClick={() => void act("tabs-open")}
          >
            <CaretDownIcon />
          </IconButton>
          <IconButton
            label={t("bookmarks")}
            aria-haspopup="dialog"
            aria-expanded={
              browser.pickerOpen && browser.pickerMode === "bookmarks"
            }
            onClick={() => void act("bookmarks-open")}
          >
            <StarIcon />
          </IconButton>
          <IconButton
            label={t("browserHistory")}
            aria-haspopup="dialog"
            aria-expanded={
              browser.pickerOpen && browser.pickerMode === "history"
            }
            onClick={() => void act("history-open")}
          >
            <ClockCounterClockwiseIcon />
          </IconButton>
          <IconButton
            label={t("tasks")}
            aria-haspopup="dialog"
            aria-expanded={browser.pickerOpen && browser.pickerMode === "tasks"}
            onClick={() => void act("tasks-open")}
          >
            <DownloadSimpleIcon />
          </IconButton>
          {browser.pickerOpen && browser.pickerMode !== "address" && (
            <div
              className="toolbar-panel"
              data-mode={browser.pickerMode || "tabs"}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (
                  event.defaultPrevented ||
                  (event.target as Element).closest('[role="alertdialog"]')
                )
                  return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  void window.tamkiTabs.action("dismiss");
                }
              }}
              onBlurCapture={(event) => {
                if (
                  event.relatedTarget &&
                  !(event.relatedTarget as Element).closest(
                    '.browser-actions, [role="alertdialog"]',
                  )
                )
                  void act("tabs-dismiss");
              }}
            >
              <span className="toolbar-panel-cap" aria-hidden="true" />
              <Picker embedded />
            </div>
          )}
        </div>
      </div>
      <main className={cn("content", browser.active === 0 && "home-active")}>
        <div className="home-content" hidden={browser.active !== 0}>
          <div className="home-content" hidden={page !== "library"}>
            <LibraryPage
              state={state}
              settings={() => setPage("settings")}
              tasks={() => setPage("tasks")}
              detail={openDetail}
            />
          </div>
          {page === "settings" ? (
            <Settings state={state} onBack={() => setPage("library")} />
          ) : page === "tasks" ? (
            <Tasks
              state={state}
              onBack={() => setPage("library")}
              play={play}
            />
          ) : page === "edit" && work ? (
            <MetadataEditor
              key={work.id}
              work={work}
              state={state}
              onBack={() => setPage("detail")}
            />
          ) : page === "detail" && work ? (
            <DetailPage
              key={work.id}
              onSelectWork={setWorkId}
              work={work}
              state={state}
              onBack={() => setPage("library")}
              onEdit={() => setPage("edit")}
              onPlay={(e) => play(work.id, e)}
            />
          ) : null}
        </div>
        {current?.kind === "web" && (
          <div className="browser-page">
            <form id="navigation" onSubmit={submit}>
              <IconButton
                id="back"
                label={t("back")}
                disabled={!current.back}
                onClick={() => void act("back")}
              >
                <ArrowLeftIcon />
              </IconButton>
              <IconButton
                id="forward"
                label={t("forward")}
                disabled={!current.forward}
                onClick={() => void act("forward")}
              >
                <ArrowRightIcon />
              </IconButton>
              <IconButton
                id="reload"
                label={t(current.loading ? "stop" : "reload")}
                onClick={() => void act(current.loading ? "stop" : "reload")}
              >
                {current.loading ? <XIcon /> : <ArrowClockwiseIcon />}
              </IconButton>
              <InputGroup data-invalid={!!error} className="browser-address">
                <InputGroupAddon>
                  <IconButton
                    label={t("sitePermissions")}
                    disabled={!/^https?:/.test(current.url)}
                    onClick={() => void act("site-menu")}
                  >
                    <SlidersHorizontalIcon />
                  </IconButton>
                </InputGroupAddon>
                <InputGroupInput
                  ref={addressRef}
                  id="address"
                  aria-label={t("address")}
                  placeholder={t("address")}
                  value={address}
                  onChange={(e) => {
                    setError("");
                    setAddress(e.target.value);
                    suggest(e.target.value);
                  }}
                  onFocus={() => suggest(address)}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-expanded={
                    browser.pickerOpen && browser.pickerMode === "address"
                  }
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      if (
                        browser.pickerOpen &&
                        browser.pickerMode === "address"
                      )
                        void act(
                          "address-step",
                          e.key === "ArrowDown" ? 1 : -1,
                        );
                      else suggest(address);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      void act("tabs-dismiss");
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!error}
                  aria-describedby={error ? "error" : undefined}
                />
                <InputGroupAddon align="inline-end">
                  <IconButton
                    label={t(
                      browser.bookmarks?.some((b) => b.url === current.url)
                        ? "removeBookmark"
                        : "bookmarkPage",
                    )}
                    disabled={!/^https?:/.test(current.url)}
                    onClick={() => void act("bookmark-toggle")}
                  >
                    <StarIcon
                      weight={
                        browser.bookmarks?.some((b) => b.url === current.url)
                          ? "fill"
                          : "regular"
                      }
                    />
                  </IconButton>
                </InputGroupAddon>
                {error && (
                  <InputGroupAddon align="inline-end">
                    <span id="error" role="alert">
                      {error}
                    </span>
                  </InputGroupAddon>
                )}
              </InputGroup>
              {current.zoom !== undefined && current.zoom !== 100 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("resetZoom")}
                  onClick={() => void act("zoom", 0)}
                >
                  {current.zoom}%
                </Button>
              )}
              <IconButton
                label={t("browserMore")}
                onClick={() => void act("page-menu")}
              >
                <DotsThreeIcon />
              </IconButton>
            </form>
            {current.find?.open && (
              <BrowserFind key={current.id} tab={current} act={act} />
            )}
            {(current.url === "about:blank" || !current.url) && (
              <div className="new-tab-page">
                <span className="mark" />
                <h1>Tamki</h1>
                <form onSubmit={submit}>
                  <InputGroup>
                    <InputGroupAddon>
                      <MagnifyingGlassIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label={t("search")}
                      placeholder={t("address")}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                  </InputGroup>
                </form>
              </div>
            )}
            {current.error && (
              <div className="page-error" role="alert">
                {errorMessage(current.error, t)}
              </div>
            )}
          </div>
        )}
        {browser.tabs
          .filter((tab) => tab.kind === "player")
          .map((tab) => {
            const work =
              tab.onlineWork || state.works.find((w) => w.id === tab.workId);
            return work ? (
              <Player
                key={tab.id}
                online={!!tab.onlineWork}
                work={work}
                relatedWorks={
                  tab.onlineWork
                    ? []
                    : (() => {
                        const series = state.series?.find((s) =>
                          s.workIds.includes(work.id),
                        );
                        return series
                          ? series.workIds
                              .map((id) =>
                                state.works.find((w) => w.id === id)!,
                              )
                              .filter(Boolean)
                          : [];
                      })()
                }
                onWork={(id) => void act("play", id)}
                active={browser.active === tab.id}
                requestedEpisode={requests[work.id]}
                activate={() => void act("select", tab.id)}
              />
            ) : null;
          })}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
