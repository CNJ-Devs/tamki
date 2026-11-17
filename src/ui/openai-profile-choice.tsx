import { useEffect, useRef, useState } from "react";
import { Choice, FormField } from "./common";
import { useI18n } from "./i18n";
import type { OAuthAccount, SourceConfig } from "../shared/settings";
import type { OpenAIProfiles } from "../shared/openai-profiles";
import { toast } from "sonner";

export function OpenAIProfileChoice(props: {
  source: SourceConfig;
  account: OAuthAccount;
  isNew: boolean;
  disabled: boolean;
  onBusy(value: boolean): void;
  onAccount(value: OAuthAccount): void;
  onError(error: unknown): void;
  onSelect?(): void;
}) {
  const t = useI18n();
  const [data, setData] = useState<OpenAIProfiles>();
  const latest = useRef(props);
  latest.current = props;
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    latest.current.onBusy(true);
    void window.tamki
      .library<OpenAIProfiles>("source-oauth-profiles", {
        source: latest.current.source,
      })
      .then((value) => {
        if (generation.current !== current) return;
        setData(value);
        latest.current.onAccount(value.account);
      })
      .catch((error) => {
        if (generation.current === current) latest.current.onError(error);
      })
      .finally(() => {
        if (generation.current === current) latest.current.onBusy(false);
      });
    return () => {
      generation.current++;
      latest.current.onBusy(false);
    };
  }, [props.source.id, props.account.status]);

  if (!data?.profiles.length) return null;
  const labels = data.profiles.map((profile) =>
    [profile.name, profile.email || t("oauthRegistrationIncomplete")].join(
      " · ",
    ),
  );
  return (
    <FormField label={t("oauthSavedIdentity")}>
      <Choice
        label={t("oauthSavedIdentity")}
        value={
          data.profiles.some((p) => p.id === data.selectedId)
            ? data.selectedId
            : "new"
        }
        disabled={!props.isNew || props.disabled}
        options={[
          ...data.profiles.map((profile, index) => ({
            value: profile.id,
            label:
              labels.filter((label) => label === labels[index]).length > 1
                ? `${labels[index]} · ${profile.id.slice(0, 8)}`
                : labels[index],
          })),
          ...(props.isNew
            ? [{ value: "new", label: t("oauthOtherAccount") }]
            : []),
        ]}
        onChange={(value) => {
          const current = generation.current;
          props.onBusy(true);
          void window.tamki
            .library<OpenAIProfiles>("source-oauth-select", {
              source: props.source,
              profileId: value === "new" ? null : value,
            })
            .then((result) => {
              if (generation.current !== current) return;
              setData(result);
              latest.current.onSelect?.();
              latest.current.onAccount(result.account);
              if (result.revoked === false)
                toast.error(t("oauthRevocationUnconfirmed"));
            })
            .catch((error) => {
              if (generation.current === current) latest.current.onError(error);
            })
            .finally(() => {
              if (generation.current === current) latest.current.onBusy(false);
            });
        }}
      />
    </FormField>
  );
}
