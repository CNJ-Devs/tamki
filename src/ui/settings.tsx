import type { LibraryState, Palette, Preferences } from "../shared/model";
import { appIconAsset, appIconStyles } from "../shared/app-icon";
import { useRef, useState } from "react";
import { PageHeader, Fade, FormField, Choice } from "./common";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "./components/ui/field";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Checkbox } from "./components/ui/checkbox";
import { Connections } from "./connections";
import { SavePreferences } from "./save-preferences";
import { RecognitionSettings } from "./recognition-settings";
import { RecognitionSources } from "./recognition-sources";
import { AIConnections } from "./ai-connections";
import { useI18n, errorMessage } from "./i18n";
import themes from "./themes.json";
import { toast } from "sonner";
export function Settings({
  state,
  onBack,
}: {
  state: LibraryState;
  onBack(): void;
}) {
  const t = useI18n();
  const [sources, setSources] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const aiSection = useRef<HTMLElement>(null);
  const p = state.preferences;
  const update = (patch: Partial<Preferences>) =>
    void window.tamki
      .library("preferences", { ...p, ...patch })
      .catch((e) => toast.error(errorMessage(e, t)));
  return (
    <>
      <section className="page" hidden={sources}>
        <PageHeader title={t("settings")} back={onBack} />
        <Fade className="page-body">
          <div className="settings-content">
            <section>
              <h2>{t("appearance")}</h2>
              <FieldGroup>
                <FieldSet>
                  <FieldLegend>{t("palette")}</FieldLegend>
                  <RadioGroup
                    className="palette-grid"
                    value={p.palette}
                    onValueChange={(v) => update({ palette: v as Palette })}
                  >
                    {Object.entries(themes.palettes).map(([key, palette]) => (
                      <label className="palette-option" key={key}>
                        <div
                          className="palette-preview"
                          style={{ background: palette.light.paper }}
                        >
                          <div style={{ background: palette.light.rail }} />
                          <div
                            className="palette-picture"
                            style={{ background: palette.light.accent }}
                          />
                          <div
                            className="palette-lines"
                            style={{ color: palette.light.soft }}
                          >
                            <i />
                            <i />
                            <i />
                          </div>
                        </div>
                        <span>{t(key as Palette)}</span>
                        <RadioGroupItem
                          value={key}
                          aria-label={t(key as Palette)}
                        />
                      </label>
                    ))}
                  </RadioGroup>
                </FieldSet>
                <FieldSet>
                  <FieldLegend>{t("appIcon")}</FieldLegend>
                  <FieldDescription>{t("appIconHelp")}</FieldDescription>
                  <RadioGroup
                    aria-label={t("appIcon")}
                    className="app-icon-grid"
                    value={p.appIconStyle || "default"}
                    onValueChange={(value) =>
                      update({
                        appIconStyle: value as Preferences["appIconStyle"],
                      })
                    }
                  >
                    {appIconStyles.map((style) => (
                      <label
                        className="palette-option app-icon-option"
                        key={style}
                      >
                        <img
                          src={`assets/${appIconAsset({ ...p, appIconStyle: style })}`}
                          alt=""
                          width="72"
                          height="72"
                        />
                        <span>
                          {t(
                            style === "default"
                              ? "appIconDefault"
                              : style === "light"
                                ? "appIconLight"
                                : "appIconColor",
                          )}
                        </span>
                        <span className="muted">
                          {t(
                            style === "default"
                              ? "appIconFixed"
                              : "appIconFollowsTheme",
                          )}
                        </span>
                        <RadioGroupItem
                          value={style}
                          aria-label={t(
                            style === "default"
                              ? "appIconDefault"
                              : style === "light"
                                ? "appIconLight"
                                : "appIconColor",
                          )}
                        />
                      </label>
                    ))}
                  </RadioGroup>
                </FieldSet>
                <FieldSet>
                  <FieldLegend>{t("mode")}</FieldLegend>
                  <RadioGroup
                    className="mode-grid"
                    value={p.mode}
                    onValueChange={(v) =>
                      update({ mode: v as Preferences["mode"] })
                    }
                  >
                    {(["light", "dark", "system"] as const).map((mode) => (
                      <label key={mode}>
                        <RadioGroupItem value={mode} />
                        {t(mode)}
                      </label>
                    ))}
                  </RadioGroup>
                </FieldSet>
                <FormField label={t("language")}>
                  <Choice
                    value={p.language}
                    onChange={(v) =>
                      update({ language: v as Preferences["language"] })
                    }
                    label={t("language")}
                    options={[
                      { value: "en", label: "English" },
                      { value: "zh", label: "简体中文" },
                    ]}
                  />
                </FormField>
              </FieldGroup>
            </section>
            <section>
              <Connections connections={state.connections} />
            </section>
            <section>
              <h2>{t("downloads")}</h2>
              <SavePreferences
                settings={state.settings}
                connections={state.connections}
              />
            </section>
            <section
              aria-label={t("aiConnections")}
              ref={aiSection}
              tabIndex={-1}
            >
              <AIConnections connections={state.settings.aiConnections || []} />
            </section>
            <section aria-label={t("recognition")}>
              <RecognitionSettings
                config={state.settings.recognition}
                connections={state.settings.aiConnections}
                onSources={() => {
                  returnFocus.current = document.activeElement as HTMLElement;
                  setSources(true);
                }}
              />
            </section>
            <section>
              <h2>{t("library")}</h2>
              <Field orientation="horizontal">
                <Checkbox
                  id="refresh-on-open"
                  checked={p.refreshOnOpen}
                  onCheckedChange={(v) => update({ refreshOnOpen: v === true })}
                />
                <FieldLabel htmlFor="refresh-on-open">
                  {t("refreshOnOpen")}
                </FieldLabel>
              </Field>
            </section>
          </div>
        </Fade>
      </section>
      {sources && (
        <RecognitionSources
          config={state.settings.recognition}
          connections={state.settings.aiConnections || []}
          onConnections={() => {
            setSources(false);
            requestAnimationFrame(() => {
              aiSection.current?.scrollIntoView({ block: "start" });
              aiSection.current?.focus({ preventScroll: true });
            });
          }}
          onBack={() => {
            setSources(false);
            requestAnimationFrame(() =>
              returnFocus.current?.focus({ preventScroll: true }),
            );
          }}
        />
      )}
    </>
  );
}
