import { useState } from "react";
import {
  PlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  PlugsConnectedIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import {
  Button,
  Choice,
  Confirm,
  FormField,
  IconButton,
  Blank,
} from "./common";
import { FieldGroup } from "./components/ui/field";
import { SourceEditor } from "./source-editor";
import { PromptDialog } from "./prompt-editor";
import {
  newSource,
  providers,
  type CustomSource,
  type SettingsState,
} from "../shared/settings";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";

export function RecognitionSettings({
  config,
}: {
  config: SettingsState["recognition"];
}) {
  const t = useI18n();
  const [editing, setEditing] = useState<CustomSource | null>(null),
    [prompt, setPrompt] = useState(false),
    [remove, setRemove] = useState<CustomSource | null>(null);
  const update = (patch: Partial<Omit<typeof config, "sources">>) =>
    window.tamki.library("recognition-preferences", patch);
  const apply = (patch: Partial<Omit<typeof config, "sources">>) =>
    void update(patch).catch((e) => toast.error(errorMessage(e, t)));
  return (
    <FieldGroup>
      <FormField label={t("filenameParser")}>
        <div className="field-control-row">
          <Choice
            value={config.parser}
            label={t("filenameParser")}
            onChange={(parser) =>
              apply({ parser: parser as typeof config.parser })
            }
            options={[
              { value: "guessit", label: t("parserGeneral") },
              { value: "anitopy", label: t("parserAnime") },
            ]}
          />
          <IconButton label={t("parserHelp")}>
            <InfoIcon />
          </IconButton>
        </div>
      </FormField>
      <FormField label={t("defaultSource")}>
        <Choice
          label={t("defaultSource")}
          value={config.defaultSourceId}
          onChange={(defaultSourceId) => apply({ defaultSourceId })}
          options={[
            { value: "tmdb", label: "TMDB" },
            { value: "bangumi", label: "Bangumi" },
            ...config.sources.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </FormField>
      <div className="section-heading source-heading">
        <h3>{t("customSources")}</h3>
        <div className="actions">
          <Button variant="secondary" onClick={() => setPrompt(true)}>
            {t("aiPrompt")}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              setEditing({
                ...newSource(),
                hasKey: false,
                hasSearchKey: false,
                models: [],
              })
            }
          >
            <PlusIcon data-icon="inline-start" />
            {t("addSource")}
          </Button>
        </div>
      </div>
      {config.sources.length ? (
        <div>
          {config.sources.map((s) => (
            <div className="connection-row" key={s.id}>
              <div className="connection-icon">
                <PlugsConnectedIcon />
              </div>
              <div className="connection-copy">
                <strong>{s.name}</strong>
                <span className="muted">
                  {s.provider === "openai-compatible"
                    ? t("compatibleProvider")
                    : providers.find((p) => p.id === s.provider)?.name}{" "}
                  · {s.model}
                </span>
              </div>
              <IconButton label={t("editSource")} onClick={() => setEditing(s)}>
                <PencilSimpleIcon />
              </IconButton>
              <IconButton
                label={t("removeSource")}
                onClick={() => setRemove(s)}
              >
                <TrashIcon />
              </IconButton>
            </div>
          ))}
        </div>
      ) : (
        <Blank title={t("noCustomSources")} />
      )}
      {editing ? (
        <SourceEditor
          initial={editing}
          isNew={!config.sources.some((s) => s.id === editing.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {prompt ? (
        <PromptDialog
          initial={config.aiPrompt}
          onClose={() => setPrompt(false)}
          onSave={async (aiPrompt) => {
            await update({ aiPrompt });
            setPrompt(false);
          }}
        />
      ) : null}
      {remove ? (
        <Confirm
          title={t("removeSourceTitle")}
          description={t("removeSourceBody")}
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void window.tamki
              .library("remove-source", remove.id)
              .then(() => setRemove(null))
              .catch((e) => toast.error(errorMessage(e, t)))
          }
        />
      ) : null}
    </FieldGroup>
  );
}
