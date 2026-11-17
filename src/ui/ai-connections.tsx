import { useEffect, useRef, useState } from "react";
import {
  PlusIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import {
  Blank,
  Button,
  Choice,
  Confirm,
  Fade,
  FormField,
  IconButton,
  Modal,
  Tip,
} from "./common";
import { FieldGroup } from "./components/ui/field";
import { Input } from "./components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./components/ui/accordion";
import {
  aiConnectionSchema,
  connectionConfig,
  connectionSource,
  newAIConnection,
  type AIConnection,
  type AIConnectionConfig,
} from "../shared/ai-connections";
import { providers, usesAccount, type OAuthAccount } from "../shared/settings";
import { errorMessage, useI18n, type Message } from "./i18n";
import { toast } from "sonner";
import { AuthorizationPending } from "./authorization-pending";
import { OpenAIProfileChoice } from "./openai-profile-choice";

function providerName(
  provider: AIConnectionConfig["provider"],
  t: ReturnType<typeof useI18n>,
) {
  return provider === "openai-compatible"
    ? t("compatibleProvider")
    : provider === "openai-oauth"
      ? t("oauthProvider")
      : provider === "gemini-oauth"
        ? t("googleProvider")
        : provider === "claude-code"
          ? t("claudeProvider")
          : t("aiAPIKeyProvider").replace(
              "{name}",
              providers.find((p) => p.id === provider)!.name,
            );
}

export function AIConnections({
  connections,
}: {
  connections: AIConnection[];
}) {
  const t = useI18n();
  const [editing, setEditing] = useState<AIConnection | null>(null);
  const [removing, setRemoving] = useState<AIConnection | null>(null);
  return (
    <>
      <div className="section-heading">
        <h2>{t("aiConnections")}</h2>
        <Button
          variant="secondary"
          onClick={() => setEditing(newAIConnection())}
        >
          <PlusIcon data-icon="inline-start" />
          {t("addAIConnection")}
        </Button>
      </div>
      {connections.length ? (
        connections.map((connection) => (
          <div className="connection-row" key={connection.id}>
            <div className="connection-icon">
              <PlugsConnectedIcon />
            </div>
            <div className="connection-copy">
              <Tip text={connection.name}>
                <strong className="truncate">{connection.name}</strong>
              </Tip>
              <span className="muted truncate">
                {providerName(connection.provider, t)} ·{" "}
                {usesAccount(connection.provider)
                  ? connection.account?.status === "connected"
                    ? connection.account.email || t("connected")
                    : t("oauthSignedOut")
                  : connection.auth === "none"
                    ? t("aiNoAuthentication")
                    : t(connection.hasKey ? "configured" : "notConfigured")}
              </span>
            </div>
            <IconButton
              label={t("editAIConnection")}
              onClick={() => setEditing(connection)}
            >
              <PencilSimpleIcon />
            </IconButton>
            <IconButton
              label={t("removeAIConnection")}
              onClick={() => setRemoving(connection)}
            >
              <TrashIcon />
            </IconButton>
          </div>
        ))
      ) : (
        <Blank title={t("noAIConnections")} size="section" />
      )}
      {editing && (
        <AIConnectionEditor
          initial={editing}
          isNew={!connections.some((c) => c.id === editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <Confirm
          title={t("removeAIConnectionTitle")}
          description={t("removeAIConnectionBody")}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            void window.tamki
              .library<{ revoked: boolean }>(
                "ai-connection-remove",
                removing.id,
              )
              .then((result) => {
                setRemoving(null);
                if (!result.revoked)
                  toast.error(t("accountRevocationUnconfirmed"));
              })
              .catch((error) => toast.error(errorMessage(error, t)));
          }}
        />
      )}
    </>
  );
}

export function AIConnectionEditor({
  initial,
  isNew,
  onClose,
}: {
  initial: AIConnection;
  isNew: boolean;
  onClose(): void;
}) {
  const t = useI18n();
  const [connection, setConnection] = useState(() => connectionConfig(initial));
  const [apiKey, setKey] = useState(""),
    [clientSecret, setClientSecret] = useState("");
  const [account, setAccount] = useState<OAuthAccount>(
    initial.account || { email: "", status: "signedOut" },
  );
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [activity, setActivity] = useState<string | null>(null),
    [tested, setTested] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [error, setError] = useState<{ field: string; message: string } | null>(
    null,
  );
  const [welcome, setWelcome] = useState(false);
  const [authorizationEnd, setAuthorizationEnd] = useState<
    "cancelled" | "expired"
  >();
  const alive = useRef(true),
    currentId = useRef(connection.id);
  currentId.current = connection.id;
  const current = () => alive.current && currentId.current === connection.id;
  const busy = activity !== null || profileBusy,
    connected = account.status === "connected";
  const google = connection.provider === "gemini-oauth",
    claude = connection.provider === "claude-code",
    oauth = connection.provider === "openai-oauth";
  const accountBased = usesAccount(connection.provider),
    compatible = connection.provider === "openai-compatible";
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void window.tamki
        .library<{ revoked: boolean }>("ai-connection-discard", connection.id)
        .then((result) => {
          if (!result.revoked) toast.error(t("accountRevocationUnconfirmed"));
        })
        .catch(() => {});
    };
  }, [connection.id]);
  const change = <K extends keyof AIConnectionConfig>(
    key: K,
    value: AIConnectionConfig[K],
  ) => {
    if (key === "endpoint" || key === "auth") setKey("");
    setConnection((c) => ({ ...c, [key]: value }));
    setError(null);
    setTested(false);
  };
  const payload = () => ({
    connection,
    ...(apiKey ? { apiKey } : {}),
    ...(google && clientSecret ? { oauthClientSecret: clientSecret } : {}),
  });
  const fail = (e: unknown) => {
    if (!current()) return;
    const raw = e instanceof Error ? e.message : String(e);
    if (raw === "oauthCancelled") {
      setError(null);
      return;
    }
    const field =
      ["keyRequired", "sourceUnauthorized"].includes(raw) && !accountBased
        ? "apiKey"
        : ["googleClientRequired", "googleClientInvalid"].includes(raw)
          ? "oauthClientId"
          : [
                "googleProjectRequired",
                "googleProjectDenied",
                "googleBillingRequired",
                "googleAPIDisabled",
              ].includes(raw)
            ? "project"
            : raw === "aiConnectionNameTaken"
              ? "name"
              : "form";
    setError({ field, message: errorMessage(e, t) });
    if (["oauthSignInRequired", "accountSignInRequired"].includes(raw))
      setAccount({ email: "", status: "signedOut" });
  };
  const validate = () => {
    const result = aiConnectionSchema.safeParse(connection);
    if (result.success) return true;
    setError({
      field: String(result.error.issues[0].path[0] || "form"),
      message: t("invalidInput"),
    });
    return false;
  };
  const loadProjects = async () => {
    const result = await window.tamki.library<{ id: string; name: string }[]>(
      "ai-connection-projects",
      payload(),
    );
    if (current()) setProjects(result);
  };
  const run = async (
    action: "login" | "logout" | "projects" | "test" | "save",
  ) => {
    if (action !== "logout" && !validate()) return;
    if (action === "login") setAuthorizationEnd(undefined);
    setActivity(action);
    setError(null);
    setTested(false);
    try {
      if (action === "login") {
        const result = await window.tamki.library<{
          account: OAuthAccount;
          firstUse: boolean;
        }>("ai-connection-login", payload());
        if (!current()) return;
        setAccount(result.account);
        setClientSecret("");
        if (result.firstUse) setWelcome(true);
        if (google && result.account.status === "connected")
          await loadProjects();
      } else if (action === "logout") {
        const result = await window.tamki.library<{
          account: OAuthAccount;
          revoked: boolean;
        }>("ai-connection-logout", connection.id);
        if (!current()) return;
        setAccount(result.account);
        setProjects([]);
        if (!result.revoked) toast.error(t("accountRevocationUnconfirmed"));
      } else if (action === "projects") await loadProjects();
      else if (action === "test") {
        await window.tamki.library("ai-connection-test", payload());
        if (current()) setTested(true);
      } else {
        await window.tamki.library("ai-connection-save", payload());
        if (current()) onClose();
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      if (
        current() &&
        action === "login" &&
        (oauth || google) &&
        ["oauthCancelled", "authExpired"].includes(code)
      ) {
        setAuthorizationEnd(
          code === "oauthCancelled" ? "cancelled" : "expired",
        );
        setError(null);
      } else fail(e);
    } finally {
      if (current()) setActivity(null);
    }
  };
  const open = (url: string) =>
    void window.tamki
      .library("open-citation", url)
      .catch((e) => toast.error(errorMessage(e, t)));
  const usage = () =>
    open(
      google
        ? "https://aistudio.google.com/billing"
        : claude
          ? "https://claude.ai/settings/usage"
          : "https://chatgpt.com/settings/usage",
    );
  const message = (field: string) =>
    error?.field === field ? error.message : undefined;
  const input = (
    key: keyof AIConnectionConfig,
    label: Message,
    disabled = false,
  ) => (
    <FormField label={t(label)} htmlFor={`ai-${key}`} error={message(key)}>
      <Input
        id={`ai-${key}`}
        value={connection[key]}
        disabled={busy || disabled}
        aria-invalid={!!message(key)}
        onChange={(e) => change(key, e.target.value as never)}
      />
    </FormField>
  );
  const choose = (
    key: keyof AIConnectionConfig,
    label: Message,
    options: { value: string; label: string }[],
  ) => (
    <FormField label={t(label)} error={message(key)}>
      <Choice
        value={connection[key]}
        label={t(label)}
        options={options}
        disabled={busy}
        onChange={(v) => change(key, v as never)}
      />
    </FormField>
  );
  const canUse =
    !busy && (!accountBased || connected) && (!google || !!connection.project);
  return (
    <>
      <Modal
        open
        title={t(isNew ? "addAIConnection" : "editAIConnection")}
        onClose={onClose}
        className="connection-modal"
        footer={
          <>
            <Tip text={t("aiTestHelp")}>
              <Button
                variant="secondary"
                disabled={!canUse}
                onClick={() => void run("test")}
              >
                {t("testConnection")}
              </Button>
            </Tip>
            <span className="modal-status" role="status">
              <span className={error ? undefined : "muted"}>
                {error?.field === "form"
                  ? error.message
                  : activity === "login"
                    ? ""
                    : busy
                      ? t(activity === "login" ? "oauthWaiting" : "loading")
                      : tested
                        ? t("connectionOK")
                        : ""}
              </span>
            </span>
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button disabled={!canUse} onClick={() => void run("save")}>
              {t("save")}
            </Button>
          </>
        }
      >
        <Fade className="modal-body">
          <FieldGroup>
            <FormField label={t("aiConnectionType")}>
              <Choice
                value={connection.provider}
                label={t("aiConnectionType")}
                disabled={!isNew || busy}
                options={providers.map((p) => ({
                  value: p.id,
                  label: providerName(p.id, t),
                }))}
                onChange={(provider) => {
                  setConnection(
                    connectionConfig(
                      newAIConnection(
                        provider as AIConnectionConfig["provider"],
                      ),
                    ),
                  );
                  setKey("");
                  setClientSecret("");
                  setAccount({ email: "", status: "signedOut" });
                  setProjects([]);
                  setError(null);
                  setTested(false);
                  setAuthorizationEnd(undefined);
                }}
              />
            </FormField>
            {input("name", "name")}
            {compatible && (
              <>
                {choose("protocol", "protocol", [
                  { value: "chat-completions", label: "Chat Completions" },
                  { value: "responses", label: "Responses" },
                ])}
                {input("endpoint", "endpoint")}
                {choose("auth", "authMethod", [
                  { value: "bearer", label: "Bearer Token" },
                  { value: "x-api-key", label: "API Key" },
                  { value: "none", label: t("noAuth") },
                ])}
              </>
            )}
            {google && (
              <>
                <FormField
                  label={t("googleClientId")}
                  htmlFor="ai-oauthClientId"
                  error={message("oauthClientId")}
                >
                  <div className="model-control">
                    <Input
                      id="ai-oauthClientId"
                      value={connection.oauthClientId}
                      disabled={busy || connected}
                      aria-invalid={!!message("oauthClientId")}
                      onChange={(e) =>
                        change("oauthClientId", e.target.value.trim())
                      }
                    />
                    <Tip text={t("googleSetupHelp")}>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open("https://console.cloud.google.com/auth/clients")
                        }
                      >
                        {t("googleSetup")}
                      </Button>
                    </Tip>
                  </div>
                </FormField>
                {!connected && (
                  <FormField
                    label={t("googleClientSecret")}
                    htmlFor="ai-client-secret"
                  >
                    <Input
                      id="ai-client-secret"
                      type="password"
                      autoComplete="off"
                      disabled={busy}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </FormField>
                )}
              </>
            )}
            {oauth && (
              <OpenAIProfileChoice
                key={connection.id}
                source={connectionSource(connection)}
                account={account}
                isNew={isNew}
                disabled={busy}
                onBusy={setProfileBusy}
                onError={fail}
                onSelect={() => setAuthorizationEnd(undefined)}
                onAccount={(value) => {
                  setAccount(value);
                  setTested(false);
                }}
              />
            )}
            {accountBased ? (
              <FormField
                label={t(
                  oauth
                    ? "oauthAccount"
                    : google
                      ? "googleAccount"
                      : "claudeAccount",
                )}
              >
                <div className="oauth-account">
                  <div className="oauth-identity" role="status">
                    {account.email && (
                      <span className="truncate">{account.email}</span>
                    )}
                    <span className="muted">
                      {t(
                        connected
                          ? google
                            ? "googleUsingCloud"
                            : claude
                              ? account.billing === "api"
                                ? "claudeUsingAPI"
                                : "claudeUsingPlan"
                              : "oauthUsingPlan"
                          : account.status === "planRequired"
                            ? "oauthPlanRequired"
                            : "oauthSignedOut",
                      )}
                    </span>
                  </div>
                  {(oauth || google) && (!connected || activity === "login") ? (
                    <AuthorizationPending
                      key={connection.id}
                      sourceId={connection.id}
                      web
                      pending={activity === "login"}
                      disabled={busy}
                      ended={authorizationEnd}
                      onStart={() => void run("login")}
                    />
                  ) : activity === "login" ? (
                    <AuthorizationPending
                      sourceId={connection.id}
                      web={false}
                    />
                  ) : (
                    <div className="actions">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void run("login")}
                      >
                        {t(
                          oauth
                            ? "oauthContinue"
                            : google
                              ? "googleContinue"
                              : "claudeContinue",
                        )}
                      </Button>
                      {account.status !== "signedOut" && (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void run("logout")}
                        >
                          {t("oauthSignOut")}
                        </Button>
                      )}
                      {connected && (
                        <Button variant="secondary" onClick={usage}>
                          {t("oauthManageUsage")}
                        </Button>
                      )}
                      {claude && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            open("https://code.claude.com/docs/en/setup")
                          }
                        >
                          {t("claudeInstall")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </FormField>
            ) : connection.auth !== "none" ? (
              <FormField
                label={t("apiKey")}
                htmlFor="ai-apiKey"
                error={message("apiKey")}
              >
                <Input
                  id="ai-apiKey"
                  type="password"
                  autoComplete="off"
                  disabled={busy}
                  value={apiKey}
                  aria-invalid={!!message("apiKey")}
                  placeholder={
                    initial.hasKey &&
                    initial.endpoint === connection.endpoint &&
                    initial.auth === connection.auth
                      ? t("configured")
                      : ""
                  }
                  onChange={(e) => {
                    setKey(e.target.value);
                    setError(null);
                    setTested(false);
                  }}
                />
              </FormField>
            ) : null}
            {google && (
              <FormField label={t("googleProject")} error={message("project")}>
                <div className="model-control">
                  <Choice
                    label={t("googleProject")}
                    value={connection.project}
                    placeholder={t("googleChooseProject")}
                    disabled={busy || !connected}
                    options={[
                      ...(connection.project &&
                      !projects.some((p) => p.id === connection.project)
                        ? [
                            {
                              value: connection.project,
                              label: connection.project,
                            },
                          ]
                        : []),
                      ...projects.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    onChange={(v) => change("project", v)}
                  />
                  <Tip text={t("googleBillingHelp")}>
                    <Button
                      variant="secondary"
                      disabled={busy || !connected}
                      onClick={() => void run("projects")}
                    >
                      {t("googleLoadProjects")}
                    </Button>
                  </Tip>
                </div>
                <span className="muted">{t("googleBillingNotice")}</span>
              </FormField>
            )}
            {(claude || connection.provider === "openai") && (
              <Accordion type="single" collapsible>
                <AccordionItem value="advanced">
                  <AccordionTrigger>{t("advanced")}</AccordionTrigger>
                  <AccordionContent>
                    <FieldGroup>
                      {claude ? (
                        input("runtimePath", "claudePath", connected)
                      ) : (
                        <>
                          {input("project", "projectId")}
                          {input("organization", "organizationId")}
                        </>
                      )}
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </FieldGroup>
        </Fade>
      </Modal>
      {welcome && (
        <Modal
          open
          title={t("oauthWelcome")}
          onClose={() => setWelcome(false)}
          footer={
            <Button
              onClick={() => {
                setWelcome(false);
                void window.tamki
                  .library("source-oauth-welcome")
                  .catch(() => {});
              }}
            >
              {t("oauthGotIt")}
            </Button>
          }
        >
          <p className="modal-body">{t("oauthWelcomeBody")}</p>
        </Modal>
      )}
    </>
  );
}
