import { useEffect, useId, useRef, useState } from "react";
import { CopyIcon } from "@phosphor-icons/react";
import type { AuthorizationState } from "../shared/authorization";
import { Button, FormField, Tip } from "./common";
import { FieldGroup } from "./components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "./components/ui/input-group";
import { errorMessage, useI18n } from "./i18n";
import { toast } from "sonner";

/** Shared by standalone connections and the retained recognition-source editor. */
export function AuthorizationPending({
  sourceId,
  web,
  pending = true,
  disabled = false,
  ended,
  onStart,
}: {
  sourceId: string;
  web: boolean;
  pending?: boolean;
  disabled?: boolean;
  ended?: "cancelled" | "expired";
  onStart?(): void;
}) {
  const t = useI18n(),
    inputId = useId();
  const [authorization, setAuthorization] = useState<AuthorizationState | null>(
    null,
  );
  const [now, setNow] = useState(Date.now),
    [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [lastURL, setLastURL] = useState("");
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    generation.current++;
    setAuthorization(null);
    setAction(null);
    setError(null);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await window.tamki.library<AuthorizationState | null>(
          "source-authorization",
          sourceId,
        );
        if (disposed) return;
        setAuthorization(state);
        if (state?.url) setLastURL(state.url);
        setNow(Date.now());
      } catch (e) {
        if (!disposed) setError(errorMessage(e, t));
      }
      if (!disposed) timer = setTimeout(poll, 500);
    };
    if (web && pending) void poll();
    return () => {
      disposed = true;
      alive.current = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [sourceId, web, pending]);
  const remaining = authorization
    ? Math.max(0, Math.ceil((authorization.expiresAt - now) / 1000))
    : 0;
  const canOpen =
    pending &&
    !!authorization?.url &&
    remaining > 0 &&
    authorization.status === "waiting";
  const run = async (kind: "open" | "copy" | "cancel") => {
    const attempt = generation.current;
    const currentAttempt = () =>
      alive.current && generation.current === attempt;
    setAction(kind);
    setError(null);
    try {
      const current =
        authorization ||
        (web
          ? await window.tamki.library<AuthorizationState | null>(
              "source-authorization",
              sourceId,
            )
          : null);
      await window.tamki.library(`source-authorization-${kind}`, {
        sourceId,
        ...(current ? { authorizationId: current.id } : {}),
      });
      if (!currentAttempt()) return;
      if (kind === "copy") toast.success(t("oauthLinkCopied"));
    } catch (e) {
      if (currentAttempt()) setError(errorMessage(e, t));
    } finally {
      if (currentAttempt()) setAction(null);
    }
  };
  const status = !pending
    ? ended
      ? t(ended === "cancelled" ? "oauthLinkCancelled" : "oauthLinkExpired")
      : ""
    : authorization?.status === "finishing"
      ? t("oauthFinishing")
      : authorization
        ? t("oauthLinkExpires").replace(
            "{time}",
            `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
          )
        : t(web ? "oauthPreparingLink" : "oauthWaiting");
  return (
    <FieldGroup>
      {web && (
        <FormField
          label={t("oauthAuthorizationURL")}
          htmlFor={inputId}
          error={
            error ||
            (pending && authorization?.browserError
              ? t("oauthBrowserOpenFailed")
              : undefined)
          }
        >
          <InputGroup className="authorization-link">
            <InputGroupInput
              id={inputId}
              readOnly
              disabled={!canOpen}
              value={authorization?.url || lastURL}
              onFocus={(e) => e.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <Tip text={t("oauthCopyLink")}>
                <InputGroupButton
                  variant="secondary"
                  size="icon-sm"
                  aria-label={t("oauthCopyLink")}
                  disabled={!canOpen || action !== null}
                  onClick={() => void run("copy")}
                >
                  <CopyIcon />
                </InputGroupButton>
              </Tip>
            </InputGroupAddon>
          </InputGroup>
        </FormField>
      )}
      <div className="actions flex-wrap">
        {!pending ? (
          <Button variant="secondary" disabled={disabled} onClick={onStart}>
            {t("oauthStartAuthorization")}
          </Button>
        ) : (
          <>
            {web && (
              <Button
                variant="secondary"
                disabled={!canOpen || action !== null}
                onClick={() => void run("open")}
              >
                {t("oauthOpenDefault")}
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={action === "cancel"}
              onClick={() => void run("cancel")}
            >
              {t("oauthCancelAuthorization")}
            </Button>
          </>
        )}
        <span className="muted" role="status">
          {status}
        </span>
      </div>
      {!web && error && (
        <span className="field-error" role="status">
          {error}
        </span>
      )}
    </FieldGroup>
  );
}
