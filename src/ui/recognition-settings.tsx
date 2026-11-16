import { useState } from "react";
import { Button, Choice, FormField } from "./common";
import { Checkbox } from "./components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { recognitionOptions } from "./recognition-flow";
import { PromptDialog } from "./prompt-editor";
import type { SettingsState } from "../shared/settings";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";

export function RecognitionSettings({
  config,
  connections,
  onSources,
}: {
  config: SettingsState["recognition"];
  connections?: SettingsState["aiConnections"];
  onSources(): void;
}) {
  const t = useI18n();
  const [prompt, setPrompt] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const update = (patch: Partial<Omit<typeof config, "sources">>) =>
    window.tamki.library("recognition-preferences", patch);
  const apply = (patch: Partial<Omit<typeof config, "sources">>) =>
    void update(patch).catch((e) => toast.error(errorMessage(e, t)));
  return (
    <>
      <div className="section-heading recognition-heading">
        <h2>{t("recognition")}</h2>
        <div className="actions">
          <Button
            variant="secondary"
            disabled={config.automatic === false || retrying}
            onClick={() => {
              setRetrying(true);
              void window.tamki
                .library("retry-recognition")
                .catch((e) => toast.error(errorMessage(e, t)))
                .finally(() => setRetrying(false));
            }}
          >
            {t("retryUnidentified")}
          </Button>
          <Button variant="secondary" onClick={() => setPrompt(true)}>
            {t("aiPrompt")}
          </Button>
          <Button variant="secondary" onClick={onSources}>
            {t("sourceSettings")}
          </Button>
        </div>
      </div>
      <FieldGroup className="recognition-controls">
        <FormField
          label={t("filenameParser")}
          htmlFor="filename-parser"
          help={t("parserHelp")}
        >
          <Choice
            id="filename-parser"
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
        </FormField>
        <FormField label={t("defaultSource")}>
          <Choice
            label={t("defaultSource")}
            value={config.defaultSourceId}
            onChange={(defaultSourceId) => apply({ defaultSourceId })}
            options={recognitionOptions(
              config,
              t("filenameSource"),
              t("notConfigured"),
              connections,
            )}
          />
        </FormField>
        <Field orientation="horizontal" className="recognition-automatic">
          <Checkbox
            id="automatic-recognition"
            checked={config.automatic !== false}
            onCheckedChange={(value) => apply({ automatic: value === true })}
          />
          <FieldLabel htmlFor="automatic-recognition">
            {t("automaticRecognition")}
          </FieldLabel>
        </Field>
      </FieldGroup>
      {prompt && (
        <PromptDialog
          initial={config.aiPrompt}
          onClose={() => setPrompt(false)}
          onSave={async (aiPrompt) => {
            await update({ aiPrompt });
            setPrompt(false);
          }}
        />
      )}
    </>
  );
}
