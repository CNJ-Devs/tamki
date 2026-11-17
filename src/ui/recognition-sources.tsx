import { useEffect, useRef, useState } from "react";
import {
  PlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  PlugsConnectedIcon,
} from "@phosphor-icons/react";
import {
  Button,
  Confirm,
  Fade,
  FormField,
  IconButton,
  Modal,
  PageHeader,
  TextTip,
} from "./common";
import { Input } from "./components/ui/input";
import { FieldGroup } from "./components/ui/field";
import { SourceEditor } from "./source-editor";
import {
  newSource,
  providers,
  usesAccount,
  type CustomSource,
  type SettingsState,
} from "../shared/settings";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";
import type { AIConnection } from "../shared/ai-connections";

export function RecognitionSources({
  config,
  connections,
  onConnections,
  onBack,
}: {
  config: SettingsState["recognition"];
  connections: AIConnection[];
  onConnections(): void;
  onBack(): void;
}) {
  const t = useI18n();
  const page = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState<CustomSource | null>(null),
    [remove, setRemove] = useState<CustomSource | null>(null);
  const [credentials, setCredentials] = useState(false),
    [token, setToken] = useState(""),
    [tokenBusy, setTokenBusy] = useState(false);
  useEffect(() => {
    page.current?.focus({ preventScroll: true });
  }, []);
  const builtin = (name: string, status: string, configure?: () => void) => (
    <div className="connection-row" key={name} role="group" aria-label={name}>
      <div className="connection-icon">
        <PlugsConnectedIcon />
      </div>
      <div className="connection-copy">
        <strong>{name}</strong>
        <span className="muted truncate">{status}</span>
      </div>
      {configure && (
        <IconButton label={t("tmdbCredentials")} onClick={configure}>
          <PencilSimpleIcon />
        </IconButton>
      )}
    </div>
  );
  return (
    <section
      className="page"
      aria-label={t("sourceSettings")}
      ref={page}
      tabIndex={-1}
    >
      <PageHeader title={t("sourceSettings")} back={onBack}>
        <Button
          variant="secondary"
          onClick={() =>
            setEditing({
              ...newSource(),
              name: "",
              hasKey: false,
              hasSearchKey: false,
              models: [],
            })
          }
        >
          <PlusIcon data-icon="inline-start" />
          {t("addSource")}
        </Button>
      </PageHeader>
      <Fade className="page-body">
        <div className="settings-content">
          <div>
            {builtin("Bangumi", t("sourceAvailable"))}
            {builtin("Bilibili", t("bilibiliPublicMetadata"))}
            {builtin(
              "TMDB",
              t(config.tmdbConfigured ? "configured" : "notConfigured"),
              () => {
                setToken("");
                setCredentials(true);
              },
            )}
            {builtin(
              t("filenameSource"),
              t(config.parser === "anitomy" ? "parserAnime" : "parserGeneral"),
            )}
            {config.sources.map((s) => (
              <div
                className="connection-row"
                key={s.id}
                role="group"
                aria-label={s.name}
              >
                <div className="connection-icon">
                  <PlugsConnectedIcon />
                </div>
                <div className="connection-copy">
                  <strong className="truncate">
                    <TextTip>{s.name}</TextTip>
                  </strong>
                  <span className="muted truncate">
                    {connections.find((c) => c.id === s.connectionId)?.name ||
                      (s.provider === "openai-compatible"
                        ? t("compatibleProvider")
                        : s.provider === "openai-oauth"
                          ? t("oauthProvider")
                          : s.provider === "claude-code"
                            ? t("claudeProvider")
                            : s.provider === "gemini-oauth"
                              ? t("googleProvider")
                              : providers.find((p) => p.id === s.provider)
                                  ?.name)}{" "}
                    ·{" "}
                    {usesAccount(s.provider) &&
                    s.account?.status !== "connected"
                      ? t("oauthSignedOut")
                      : s.model}
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
        </div>
      </Fade>
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
          connections={connections}
          onConnections={() => {
            setEditing(null);
            onConnections();
          }}
          isNew={!config.sources.some((s) => s.id === editing.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {remove ? (
        <Confirm
          title={t("removeSourceTitle")}
          description={t("removeSourceBody")}
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void window.tamki
              .library<{ revoked: boolean }>("remove-source", remove.id)
              .then((result) => {
                setRemove(null);
                if (!result.revoked)
                  toast.error(
                    t(
                      remove.provider === "openai-oauth"
                        ? "oauthRevocationUnconfirmed"
                        : "accountRevocationUnconfirmed",
                    ),
                  );
              })
              .catch((e) => toast.error(errorMessage(e, t)))
          }
        />
      ) : null}
    </section>
  );
}
