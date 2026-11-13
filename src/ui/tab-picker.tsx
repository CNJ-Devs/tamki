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
        <TabSearch state={state} />
      </LocaleContext>
    )
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
