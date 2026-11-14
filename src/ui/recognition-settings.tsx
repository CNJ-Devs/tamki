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
  Modal,
} from "./common";
import { Input } from "./components/ui/input";
import { recognitionOptions } from "./recognition-flow";
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
  const [credentials, setCredentials] = useState(false),
    [token, setToken] = useState(""),
    [tokenBusy, setTokenBusy] = useState(false);
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
              { value: "release", label: t("parserGeneral") },
              { value: "anitomy", label: t("parserAnime") },
            ]}
          />
          <IconButton label={t("parserHelp")}>
            <InfoIcon />
          </IconButton>
        </div>
      </FormField>
      <FormField label={t("defaultSource")}>
        <div className="field-control-row">
          <Choice
            label={t("defaultSource")}
            value={config.defaultSourceId}
            onChange={(defaultSourceId) => apply({ defaultSourceId })}
            options={recognitionOptions(
              config,
              t("filenameSource"),
              t("notConfigured"),
            )}
          />
          <IconButton
            label={t("tmdbCredentials")}
            onClick={() => setCredentials(true)}
          >
            <PencilSimpleIcon />
          </IconButton>
        </div>
      </FormField>
      <div className="settings-list">
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
                <IconButton
                  label={t("editSource")}
                  onClick={() => setEditing(s)}
                >
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
          <Blank title={t("noCustomSources")} size="section" />
        )}
      </div>
      {credentials && (
        <Modal
          open
          title={t("tmdbCredentials")}
          onClose={() => !tokenBusy && setCredentials(false)}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={tokenBusy}
                onClick={() => setCredentials(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                disabled={tokenBusy || !token.trim()}
                onClick={() => {
                  setTokenBusy(true);
                  void window.tamki
                    .library("tmdb-credentials", token)
                    .then(() => {
                      setToken("");
                      setCredentials(false);
                    })
                    .catch((e) => toast.error(errorMessage(e, t)))
                    .finally(() => setTokenBusy(false));
                }}
              >
                {t("save")}
              </Button>
            </>
          }
        >
          <div className="modal-body">
            <FieldGroup>
              <FormField label={t("tmdbToken")} htmlFor="tmdb-token">
                <Input
                  id="tmdb-token"
                  type="password"
                  value={token}
                  placeholder={config.tmdbConfigured ? t("configured") : ""}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </FormField>
            </FieldGroup>
          </div>
        </Modal>
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
