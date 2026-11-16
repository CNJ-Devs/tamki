import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Tasks } from "./tasks";
import { Toaster, toast } from "sonner";
import {
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
import type { BrowserState, LibraryState } from "../shared/model";
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
import { useLibraryDurations } from "./media";
import { LocaleContext, useI18n, errorMessage } from "./i18n";
import { applyTheme } from "./theme";
import { cn } from "./lib/utils";
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
  const addressRef = useRef<HTMLInputElement>(null),
    strip = useRef<HTMLDivElement>(null),
    pickerTrigger = useRef<HTMLButtonElement>(null);
  const [density, setDensity] = useState("normal"),
    [tabWidth, setTabWidth] = useState(200);
  const act = useCallback(
    async (type: string, value?: unknown) => {
      try {
        setError("");
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
    const focusTabs = window.tamki.onFocusTabs(() =>
      pickerTrigger.current?.focus(),
    );
    return () => {
      off();
      offPage();
      offPlayDownload();
      focus();
      focusTabs();
    };
  }, []);
  const current = browser.tabs.find((tab) => tab.id === browser.active),
    work = state.works.find((w) => w.id === workId);
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
          (el.clientWidth - (window.tamki.platform === "darwin" ? 284 : 164)) /
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
    void act("navigate", address);
    addressRef.current?.blur();
  };
  return (
    <div
      className="app-shell"
      data-platform={window.tamki.platform}
      onPointerDown={(event) => {
        if (
          browser.pickerOpen &&
          !(event.target as Element).closest(".browser-actions")
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
                ) : (
                  <GlobeIcon className={tab.loading ? "spin" : undefined} />
                )}
                <TextTip>{tab.title || t("newTab")}</TextTip>
              </button>
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
        <div className="browser-actions">
          <Button
            ref={pickerTrigger}
            variant="ghost"
            size="icon"
            aria-label={t("allTabs")}
            aria-haspopup="dialog"
            aria-expanded={browser.pickerOpen && browser.pickerMode === "tabs"}
            onClick={() => void act("tabs-open")}
          >
            <CaretDownIcon />
          </Button>{" "}
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
              <InputGroup data-invalid={!!error}>
                <InputGroupAddon>
                  <MagnifyingGlassIcon />
                </InputGroupAddon>
                <InputGroupInput
                  ref={addressRef}
                  id="address"
                  aria-label={t("address")}
                  placeholder={t("address")}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!error}
                  aria-describedby={error ? "error" : undefined}
                />
                {error && (
                  <InputGroupAddon align="inline-end">
                    <span id="error" role="alert">
                      {error}
                    </span>
                  </InputGroupAddon>
                )}
              </InputGroup>
            </form>
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
