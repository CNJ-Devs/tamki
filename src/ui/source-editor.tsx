import { useState, type ComponentProps } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { Button, Choice, Fade, FormField, Modal } from "./common";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./components/ui/accordion";
import { TagEditor } from "./tag-editor";
import {
  providers,
  newSource,
  sourceConfig,
  sourceSchema,
  type CustomSource,
  type SourceConfig,
  type ModelOption,
} from "../shared/settings";
import { errorMessage, useI18n, type Message } from "./i18n";

export function SourceEditor({
  initial,
  isNew,
  onClose,
}: {
  initial: CustomSource;
  isNew: boolean;
  onClose(): void;
}) {
  const t = useI18n();
  const [source, setSource] = useState(() => sourceConfig(initial)),
    [models, setModels] = useState(initial.models),
    [apiKey, setApiKey] = useState(""),
    [searchKey, setSearchKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ field: string; message: string } | null>(
      null,
    ),
    [advanced, setAdvanced] = useState("");
  const official = source.provider !== "openai-compatible",
    searching = source.searchMode !== "none",
    external = source.searchMode === "external",
    standalone = external || source.provider === "deepseek";
  const change = <K extends keyof SourceConfig>(
    key: K,
    value: SourceConfig[K],
  ) => {
    setSource((s) => ({ ...s, [key]: value }));
    setError(null);
  };
  const fieldId = (key: string) => "source-" + key;
  const message = (key: string) =>
    error?.field === key ? error.message : undefined;
  const input = (
    key: keyof SourceConfig,
    label: Message,
    props: ComponentProps<typeof Input> = {},
  ) => (
    <FormField label={t(label)} htmlFor={fieldId(key)} error={message(key)}>
      <Input
        id={fieldId(key)}
        disabled={busy}
        value={source[key] as string | number}
        aria-invalid={!!message(key)}
        onChange={(e) => change(key, e.target.value as never)}
        {...props}
      />
    </FormField>
  );
  const select = (
    key: keyof SourceConfig,
    label: Message,
    options: { value: string; label: string; disabled?: boolean }[],
    disabled = false,
  ) => (
    <FormField label={t(label)} error={message(key)}>
      <Choice
        id={fieldId(key)}
        value={String(source[key])}
        label={t(label)}
        disabled={disabled || busy}
        options={options}
        onChange={(v) => change(key, v as never)}
      />
    </FormField>
  );
  const number = (
    key: keyof SourceConfig,
    label: Message,
    min: number,
    max: number,
  ) =>
    input(key, label, {
      type: "number",
      min,
      max,
      step: 1,
      inputMode: "numeric",
      onChange: (e) =>
        change(
          key,
          (e.target.value === "" ? NaN : Number(e.target.value)) as never,
        ),
    });
  const check = (key: keyof SourceConfig, label: Message) => (
    <Field orientation="horizontal">
      <Checkbox
        id={fieldId(key)}
        checked={source[key] === true}
        onCheckedChange={(v) => change(key, (v === true) as never)}
      />
      <FieldLabel htmlFor={fieldId(key)}>{t(label)}</FieldLabel>
    </Field>
  );
  const fail = (e: unknown) => {
    const m = errorMessage(e, t),
      raw = e instanceof Error ? e.message : String(e);
    const field =
      raw === "keyRequired" || raw === "sourceUnauthorized"
        ? "apiKey"
        : raw === "searchKeyRequired"
          ? "searchKey"
          : raw === "chooseModel" || raw === "modelListFailed"
            ? "model"
            : raw === "outputLimitExceeded"
              ? "maxOutputTokens"
              : "form";
    if (field === "maxOutputTokens") setAdvanced("advanced");
    setError({ field, message: m });
  };
  const validate = () => {
    const result = sourceSchema.safeParse(source);
    if (result.success) return true;
    const field = String(result.error.issues[0].path[0] || "form");
    setError({ field, message: t("invalidInput") });
    if (
      [
        "timeoutSeconds",
        "maxOutputTokens",
        "domains",
        "country",
        "resultCount",
        "maxPages",
        "maxSearches",
      ].includes(field)
    )
      setAdvanced("advanced");
    return false;
  };
  const payload = () => ({
    source,
    apiKey: apiKey || undefined,
    searchKey: searchKey || undefined,
  });
  const load = async () => {
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      const list = await window.tamki.library<ModelOption[]>(
        "source-models",
        payload(),
      );
      setModels(list);
      if (!list.some((m) => m.id === source.model)) change("model", "");
      if (!list.length) setError({ field: "model", message: t("chooseModel") });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      await window.tamki.library("save-source", payload());
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t(isNew ? "addSource" : "editSource")}
      onClose={onClose}
      className="source-config-modal"
      footer={
        <>
          <span role="status" className="modal-status">
            {error?.field === "form" ? error.message : busy ? t("loading") : ""}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {t("save")}
          </Button>
        </>
      }
    >
      <Fade className="modal-body">
        <FieldGroup>
          <FormField label={t("sourceType")}>
            <Choice
              disabled={!isNew || busy}
              value={source.provider}
              label={t("sourceType")}
              options={providers.map((p) => ({
                value: p.id,
                label:
                  p.id === "openai-compatible"
                    ? t("compatibleProvider")
                    : p.name,
              }))}
              onChange={(provider) => {
                setSource({
                  ...newSource(provider as SourceConfig["provider"]),
                  id: source.id,
                });
                setApiKey("");
                setSearchKey("");
                setModels([]);
                setError(null);
              }}
            />
          </FormField>
          {input("name", "name", { maxLength: 100 })}
          {!official ? (
            <>
              {select("protocol", "protocol", [
                { value: "chat-completions", label: "Chat Completions" },
                { value: "responses", label: "Responses" },
              ])}
              {input("endpoint", "endpoint", {
                type: "url",
                onChange: (e) => {
                  change("endpoint", e.target.value);
                  setApiKey("");
                  setModels([]);
                },
              })}
              {select("auth", "authMethod", [
                { value: "bearer", label: "Bearer Token" },
                { value: "x-api-key", label: "API Key" },
                { value: "none", label: t("noAuth") },
              ])}
            </>
          ) : null}
          {official || source.auth !== "none" ? (
            <FormField
              label={t("apiKey")}
              htmlFor="source-apiKey"
              error={message("apiKey")}
            >
              <Input
                id="source-apiKey"
                disabled={busy}
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={
                  initial.hasKey && source.endpoint === initial.endpoint
                    ? t("configured")
                    : ""
                }
                aria-invalid={!!message("apiKey")}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setModels([]);
                  setError(null);
                }}
              />
            </FormField>
          ) : null}
          <FormField label={t("model")} error={message("model")}>
            <div className="model-control">
              <Choice
                id="source-model"
                disabled={!models.length || busy}
                value={source.model}
                label={t("model")}
                placeholder={t("selectModel")}
                options={models.map((m) => ({ value: m.id, label: m.name }))}
                onChange={(model) => {
                  const limit = models.find((m) => m.id === model)?.outputLimit;
                  setSource((s) => ({
                    ...s,
                    model,
                    maxOutputTokens: limit
                      ? Math.min(limit, s.maxOutputTokens)
                      : s.maxOutputTokens,
                  }));
                  setError(null);
                }}
              />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void load()}
              >
                <ArrowClockwiseIcon data-icon="inline-start" />
                {t("loadModels")}
              </Button>
            </div>
          </FormField>
          {official ? (
            <Field orientation="horizontal">
              <Checkbox
                id="source-web-search"
                checked={searching}
                onCheckedChange={(v) =>
                  change("searchMode", v ? "native" : "none")
                }
              />
              <FieldLabel htmlFor="source-web-search">
                {t("webSearch")}
              </FieldLabel>
            </Field>
          ) : (
            select("searchMode", "webSearch", [
              { value: "none", label: t("searchOff") },
              {
                value: "native",
                label: t("nativeSearch"),
                disabled: source.protocol !== "responses",
              },
              { value: "external", label: t("externalSearch") },
            ])
          )}
          {external ? (
            <>
              <FormField label={t("searchService")}>
                <Choice
                  label={t("searchService")}
                  value="deepseek"
                  options={[{ value: "deepseek", label: "DeepSeek Search" }]}
                  onChange={() => {}}
                />
              </FormField>
              {input("searchEndpoint", "searchEndpoint", { type: "url" })}
              <FormField
                label={t("searchKey")}
                htmlFor="source-searchKey"
                error={message("searchKey")}
              >
                <Input
                  id="source-searchKey"
                  disabled={busy}
                  type="password"
                  autoComplete="off"
                  value={searchKey}
                  placeholder={
                    initial.hasSearchKey &&
                    initial.searchEndpoint === source.searchEndpoint
                      ? t("configured")
                      : ""
                  }
                  onChange={(e) => setSearchKey(e.target.value)}
                />
              </FormField>
            </>
          ) : null}
          <Accordion
            type="single"
            collapsible
            value={advanced}
            onValueChange={setAdvanced}
          >
            <AccordionItem value="advanced">
              <AccordionTrigger>{t("advanced")}</AccordionTrigger>
              <AccordionContent>
                <FieldGroup>
                  {searching && standalone
                    ? number("resultCount", "resultCount", 1, 50)
                    : null}
                  {searching &&
                  (standalone ||
                    source.provider === "anthropic" ||
                    source.provider === "gemini")
                    ? check("readPages", "readPages")
                    : null}
                  <div className="source-options-grid">
                    {number("timeoutSeconds", "timeoutSeconds", 5, 600)}
                    {number(
                      "maxOutputTokens",
                      "maxOutputTokens",
                      128,
                      Math.min(
                        131072,
                        models.find((m) => m.id === source.model)
                          ?.outputLimit || 131072,
                      ),
                    )}
                  </div>
                  {searching && source.provider !== "gemini"
                    ? number("maxSearches", "maxSearches", 1, 20)
                    : null}
                  {searching &&
                  source.readPages &&
                  (standalone || source.provider === "anthropic")
                    ? number("maxPages", "maxPages", 1, 20)
                    : null}
                  {searching &&
                  (source.provider === "openai" ||
                    (!official && source.searchMode === "native"))
                    ? check("liveAccess", "liveAccess")
                    : null}
                  {searching &&
                  (source.provider === "openai" ||
                    source.provider === "anthropic") ? (
                    <>
                      {select("domainMode", "domainMode", [
                        { value: "all", label: t("allDomains") },
                        { value: "allow", label: t("allowDomains") },
                        ...(source.provider === "anthropic"
                          ? [{ value: "block", label: t("blockDomains") }]
                          : []),
                      ])}
                      {source.domainMode !== "all" ? (
                        <FormField
                          label={t("domains")}
                          error={message("domains")}
                        >
                          <TagEditor
                            tags={source.domains}
                            onChange={(v) => change("domains", v)}
                          />
                        </FormField>
                      ) : null}
                      {input("country", "country", {
                        maxLength: 2,
                        placeholder: "CN",
                      })}
                    </>
                  ) : null}
                  {source.provider === "openai" ? (
                    <>
                      {input("project", "projectId")}
                      {input("organization", "organizationId")}
                    </>
                  ) : null}
                </FieldGroup>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </FieldGroup>
      </Fade>
    </Modal>
  );
}
