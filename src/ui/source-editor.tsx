import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { Button, Choice, Fade, FormField, Modal, Tip } from "./common";
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
  newSource,
  sourceConfig,
  searchSettingsKey,
  usesAccount,
  type OAuthAccount,
  type CustomSource,
  type ModelOption,
} from "../shared/settings";
import { connectionConfig, type AIConnection } from "../shared/ai-connections";
import {
  recognitionSourceConfig,
  recognitionSourceSchema,
  resolveRecognitionSource,
  type RecognitionSourceConfig,
} from "../shared/recognition-source";
import { errorMessage, useI18n, type Message } from "./i18n";

export function SourceEditor({
  initial,
  isNew,
  connections,
  onConnections,
  onClose,
}: {
  initial: CustomSource;
  isNew: boolean;
  connections: AIConnection[];
  onConnections(): void;
  onClose(): void;
}) {
  const t = useI18n();
  const [draft, setDraft] = useState<RecognitionSourceConfig>(() => ({
    ...recognitionSourceConfig(initial),
    connectionId: initial.connectionId || (isNew ? "" : initial.id),
  }));
  const connection = connections.find((c) => c.id === draft.connectionId);
  const source = {
    ...sourceConfig(initial),
    ...(connection ? connectionConfig(connection) : {}),
    ...draft,
  };
  const [models, setModels] = useState(initial.models);
  const [searchKey, setSearchKey] = useState("");
  const [activity, setActivity] = useState<"models" | "search" | "save" | null>(
    null,
  );
  const [error, setError] = useState<{ field: string; message: string } | null>(
    null,
  );
  const [advanced, setAdvanced] = useState("");
  const [verified, setVerified] = useState<{
    connectionId: string;
    account: OAuthAccount;
  } | null>(null);
  const busy = activity !== null;
  const account =
    verified && verified.connectionId === connection?.id
      ? verified.account
      : connection?.account;
  const connectedSource = usesAccount(source.provider);
  const usable =
    !!connection &&
    (connectedSource
      ? connection.account?.status === "connected"
      : connection.auth === "none" || connection.hasKey);
  const official = source.provider !== "openai-compatible",
    oauth = source.provider === "openai-oauth",
    google = source.provider === "gemini-oauth",
    claude = source.provider === "claude-code";
  const searching = source.searchMode !== "none",
    external = source.searchMode === "external",
    standalone = external || source.provider === "deepseek";
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const change = <K extends keyof RecognitionSourceConfig>(
    key: K,
    value: RecognitionSourceConfig[K],
  ) => {
    setDraft((s) => ({ ...s, [key]: value }));
    setError(null);
  };
  const selectConnection = (id: string) => {
    const next = connections.find((c) => c.id === id);
    if (!next) return;
    revision.current++;
    const defaults = recognitionSourceConfig({
      ...newSource(next.provider),
      hasKey: false,
      hasSearchKey: false,
      models: [],
    });
    setDraft((s) => ({
      ...(connection?.provider === next.provider &&
      connection.protocol === next.protocol
        ? s
        : defaults),
      id: s.id,
      name: s.name || next.name,
      connectionId: id,
      model: "",
    }));
    setModels(next.models);
    setSearchKey("");
    setVerified(null);
    setError(null);
  };
  const message = (key: string) =>
    error?.field === key ? error.message : undefined;
  const fieldId = (key: string) => "source-" + key;
  const input = (
    key: keyof RecognitionSourceConfig,
    label: Message,
    props: ComponentProps<typeof Input> = {},
  ) => (
    <FormField label={t(label)} htmlFor={fieldId(key)} error={message(key)}>
      <Input
        id={fieldId(key)}
        disabled={busy}
        value={draft[key] as string | number}
        aria-invalid={!!message(key)}
        onChange={(e) => change(key, e.target.value as never)}
        {...props}
      />
    </FormField>
  );
  const select = (
    key: keyof RecognitionSourceConfig,
    label: Message,
    options: { value: string; label: string; disabled?: boolean }[],
  ) => (
    <FormField label={t(label)} htmlFor={fieldId(key)} error={message(key)}>
      <Choice
        id={fieldId(key)}
        value={String(draft[key])}
        label={t(label)}
        disabled={busy}
        options={options}
        onChange={(v) => change(key, v as never)}
      />
    </FormField>
  );
  const number = (
    key: keyof RecognitionSourceConfig,
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
  const check = (key: keyof RecognitionSourceConfig, label: Message) => (
    <Field orientation="horizontal">
      <Checkbox
        id={fieldId(key)}
        disabled={busy}
        checked={draft[key] === true}
        onCheckedChange={(v) => change(key, (v === true) as never)}
      />
      <FieldLabel htmlFor={fieldId(key)}>{t(label)}</FieldLabel>
    </Field>
  );
  const fail = (e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e);
    const field = [
      "aiConnectionMissing",
      "aiConnectionChanged",
      "accountSignInRequired",
      "oauthSignInRequired",
      "oauthPlanRequired",
      "keyRequired",
      "sourceUnauthorized",
    ].includes(raw)
      ? "connectionId"
      : raw === "searchKeyRequired"
        ? "searchKey"
        : ["chooseModel", "modelListFailed"].includes(raw)
          ? "model"
          : raw === "outputLimitExceeded"
            ? "maxOutputTokens"
            : "form";
    if (field === "maxOutputTokens") setAdvanced("advanced");
    setError({ field, message: errorMessage(e, t) });
  };
  const validate = () => {
    if (!connection) {
      setError({ field: "connectionId", message: t("chooseAIConnection") });
      return false;
    }
    const result = recognitionSourceSchema.safeParse(draft);
    if (!result.success) {
      const field = String(result.error.issues[0].path[0] || "form");
      setError({ field, message: t("invalidInput") });
      if (
        ![
          "name",
          "connectionId",
          "model",
          "searchMode",
          "searchEndpoint",
        ].includes(field)
      )
        setAdvanced("advanced");
      return false;
    }
    try {
      resolveRecognitionSource(result.data, connection);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const run = async (action: "models" | "search" | "save") => {
    if (!validate()) return;
    const version = revision.current;
    const current = () => alive.current && version === revision.current;
    setActivity(action);
    setError(null);
    try {
      const payload = {
        source: draft,
        ...(external && searchKey ? { searchKey } : {}),
      };
      if (action === "models") {
        const list = await window.tamki.library<ModelOption[]>(
          "recognition-source-models",
          payload,
        );
        if (!current()) return;
        setModels(list);
        if (!list.some((m) => m.id === draft.model)) change("model", "");
        if (!list.length)
          setError({ field: "model", message: t("chooseModel") });
      } else if (action === "search") {
        setVerified(null);
        const result = await window.tamki.library<OAuthAccount>(
          "recognition-source-search",
          payload,
        );
        if (current())
          setVerified({ connectionId: draft.connectionId, account: result });
      } else {
        await window.tamki.library("save-recognition-source", payload);
        if (current()) onClose();
      }
    } catch (e) {
      if (current()) fail(e);
    } finally {
      if (current()) setActivity(null);
    }
  };
  return (
    <Modal
      open
      title={t(isNew ? "addSource" : "editSource")}
      onClose={() => !busy && onClose()}
      className="source-config-modal"
      footer={
        <>
          <span role="status" className="modal-status">
            {error?.field === "form"
              ? error.message
              : activity === "search"
                ? t("oauthSearchTesting")
                : busy
                  ? t("loading")
                  : ""}
          </span>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !usable || !draft.model}
            onClick={() => void run("save")}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <Fade className="modal-body">
        <FieldGroup>
          {input("name", "name")}
          <FormField
            label={t("aiConnection")}
            htmlFor="source-connectionId"
            error={message("connectionId")}
          >
            <div className="model-control">
              <Choice
                id="source-connectionId"
                label={t("aiConnection")}
                value={draft.connectionId}
                placeholder={t(
                  connections.length ? "chooseAIConnection" : "noAIConnections",
                )}
                disabled={busy || !connections.length}
                options={connections.map((c) => ({
                  value: c.id,
                  label:
                    c.name +
                    (usesAccount(c.provider) &&
                    c.account?.status !== "connected"
                      ? " · " + t("oauthSignedOut")
                      : ""),
                }))}
                onChange={selectConnection}
              />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={onConnections}
              >
                {t("manageAIConnections")}
              </Button>
            </div>
          </FormField>
          {connection ? (
            <>
              <FormField
                label={t("model")}
                htmlFor="source-model"
                error={message("model")}
              >
                <div className="model-control">
                  <Choice
                    id="source-model"
                    value={draft.model}
                    label={t("model")}
                    disabled={busy || !usable}
                    options={models.map((m) => ({
                      value: m.id,
                      label: m.name,
                    }))}
                    onChange={(model) => {
                      const limit = models.find(
                        (m) => m.id === model,
                      )?.outputLimit;
                      setDraft((s) => ({
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
                    disabled={busy || !usable}
                    onClick={() => void run("models")}
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
                    disabled={busy}
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
              {connectedSource && searching ? (
                <div className="oauth-search-row">
                  <span className="muted" role="status">
                    {t(
                      account?.search?.settingsKey === searchSettingsKey(source)
                        ? "oauthSearchVerified"
                        : "oauthSearchUntested",
                    )}
                  </span>
                  <Tip
                    text={t(
                      oauth ? "oauthTestSearchHelp" : "accountTestSearchHelp",
                    )}
                  >
                    <Button
                      variant="secondary"
                      disabled={busy || !source.model || !usable}
                      onClick={() => void run("search")}
                    >
                      {t("oauthTestSearch")}
                    </Button>
                  </Tip>
                </div>
              ) : null}
              {external ? (
                <>
                  <FormField label={t("searchService")}>
                    <Choice
                      label={t("searchService")}
                      value="deepseek"
                      options={[
                        { value: "deepseek", label: "DeepSeek Search" },
                      ]}
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
                        source.provider === "gemini" ||
                        google ||
                        claude)
                        ? check("readPages", "readPages")
                        : null}
                      <div className="source-options-grid">
                        {number("timeoutSeconds", "timeoutSeconds", 5, 600)}
                        {!oauth && !claude
                          ? number(
                              "maxOutputTokens",
                              "maxOutputTokens",
                              128,
                              Math.min(
                                131072,
                                models.find((m) => m.id === source.model)
                                  ?.outputLimit || 131072,
                              ),
                            )
                          : null}
                      </div>
                      {searching &&
                      source.provider !== "gemini" &&
                      !connectedSource
                        ? number("maxSearches", "maxSearches", 1, 20)
                        : null}
                      {searching &&
                      source.readPages &&
                      (standalone || source.provider === "anthropic")
                        ? number("maxPages", "maxPages", 1, 20)
                        : null}
                      {searching &&
                      (source.provider === "openai" ||
                        oauth ||
                        (!official && source.searchMode === "native"))
                        ? check("liveAccess", "liveAccess")
                        : null}
                      {searching &&
                      (source.provider === "openai" ||
                        oauth ||
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
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </>
          ) : null}
        </FieldGroup>
      </Fade>
    </Modal>
  );
}
