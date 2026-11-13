import { useEffect, useState } from "react";
import {
  FolderOpenIcon,
  FolderIcon,
  CaretLeftIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import type { Connection, Entry } from "../shared/model";
import type { SettingsState, SaveRule } from "../shared/settings";
import {
  Button,
  Choice,
  Fade,
  FormField,
  IconButton,
  Modal,
  TextTip,
  Blank,
} from "./common";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "./components/ui/field";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { ButtonGroup } from "./components/ui/button-group";
import { useI18n, errorMessage } from "./i18n";
import { toast } from "sonner";

export function DirectoryPicker({
  connection,
  initial,
  onClose,
  onSelect,
}: {
  connection: Connection;
  initial?: string;
  onClose(): void;
  onSelect(path: string): Promise<void>;
}) {
  const t = useI18n();
  const [roots, setRoots] = useState<string[]>([]),
    [directory, setDirectory] = useState(initial || ""),
    [entries, setEntries] = useState<Entry[]>([]),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    Promise.all([
      window.tamki.library<string[]>("browse-roots", connection.id),
      directory
        ? window.tamki.library<Entry[]>("list", {
            id: connection.id,
            path: directory,
          })
        : Promise.resolve([]),
    ])
      .then(([r, e]) => {
        if (live) {
          setRoots(r);
          setEntries(e.filter((i) => i.directory));
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e, t));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [connection.id, directory, retry]);
  const displayed = directory
    ? entries
    : roots.map((path) => ({ path, name: path }));
  return (
    <Modal
      open
      title={t("chooseFolder")}
      onClose={onClose}
      className="connection-modal"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !!error || !directory}
            onClick={() => {
              setBusy(true);
              onSelect(directory)
                .catch((e) => setError(errorMessage(e, t)))
                .finally(() => setBusy(false));
            }}
          >
            {t("chooseFolder")}
          </Button>
        </>
      }
    >
      <Fade className="modal-body">
        <FormField label={connection.name} error={error}>
          <div className="directory-toolbar">
            <IconButton
              label={t("back")}
              disabled={!directory || busy}
              onClick={() => {
                const parent =
                  directory.slice(0, directory.lastIndexOf("/")) || "/";
                setDirectory(
                  roots.some(
                    (r) =>
                      parent === r ||
                      parent.startsWith(r === "/" ? "/" : r + "/"),
                  )
                    ? parent
                    : "",
                );
              }}
            >
              <CaretLeftIcon />
            </IconButton>
            <TextTip>{directory || t("roots")}</TextTip>
          </div>
          <div className="directory-list" aria-busy={busy}>
            {busy ? (
              <span role="status">{t("loading")}</span>
            ) : error ? (
              <Button
                variant="secondary"
                onClick={() => setRetry((n) => n + 1)}
              >
                {t("refresh")}
              </Button>
            ) : displayed.length ? (
              displayed.map((entry) => (
                <Button
                  key={entry.path}
                  className="folder-open"
                  variant="ghost"
                  onClick={() => setDirectory(entry.path)}
                >
                  <FolderIcon data-icon="inline-start" />
                  <TextTip>{entry.name}</TextTip>
                  <CaretRightIcon data-icon="inline-end" />
                </Button>
              ))
            ) : (
              <Blank title={t("noFolders")} />
            )}
          </div>
        </FormField>
      </Fade>
    </Modal>
  );
}
export function SavePreferences({
  settings,
  connections,
}: {
  settings: SettingsState;
  connections: Connection[];
}) {
  const t = useI18n();
  const [picking, setPicking] = useState<"series" | "video" | null>(null);
  const update = async (
    kind: "series" | "video",
    patch: Partial<Pick<SaveRule, "mode" | "fixed">>,
  ) => {
    const rule = settings.downloads[kind];
    await window.tamki.library("save-preference", {
      kind,
      mode: rule.mode,
      fixed: rule.fixed,
      ...patch,
    });
  };
  const apply = (
    kind: "series" | "video",
    patch: Partial<Pick<SaveRule, "mode" | "fixed">>,
  ) => void update(kind, patch).catch((e) => toast.error(errorMessage(e, t)));
  const target = picking ? settings.downloads[picking].fixed : null;
  const connection = connections.find((c) => c.id === target?.connectionId);
  return (
    <>
      <FieldGroup>
        {(["series", "video"] as const).map((kind) => {
          const pref = settings.downloads[kind],
            follow = pref.mode === "last",
            target = follow ? pref.last : pref.fixed,
            connection = connections.find((c) => c.id === target?.connectionId),
            title = t(kind === "series" ? "seriesLocation" : "videoLocation");
          return (
            <FieldSet
              key={kind}
              data-save-kind={kind}
              className="save-preference"
            >
              <FieldLegend className="sr-only">{title}</FieldLegend>
              <div className="save-preference-heading">
                <span aria-hidden>{title}</span>
                <RadioGroup
                  orientation="horizontal"
                  value={pref.mode}
                  onValueChange={(mode) =>
                    apply(kind, { mode: mode as SaveRule["mode"] })
                  }
                  aria-label={title}
                  className="save-mode-options"
                >
                  {(["fixed", "last"] as const).map((mode) => (
                    <Field orientation="horizontal" key={mode}>
                      <RadioGroupItem
                        id={`save-${kind}-${mode}`}
                        value={mode}
                      />
                      <FieldLabel htmlFor={`save-${kind}-${mode}`}>
                        {t(mode === "fixed" ? "fixedLocation" : "followLast")}
                      </FieldLabel>
                    </Field>
                  ))}
                </RadioGroup>
              </div>
              <ButtonGroup
                className="save-target-control"
                data-disabled={follow}
              >
                <Choice
                  label={title + " · " + t("selectStorage")}
                  disabled={follow || !connections.length}
                  value={connection?.id || ""}
                  placeholder={t(
                    follow ? "noPreviousLocation" : "selectStorage",
                  )}
                  options={connections.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  onChange={(id) => {
                    const c = connections.find((c) => c.id === id)!;
                    apply(kind, {
                      fixed: { connectionId: id, path: c.roots[0] },
                    });
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={follow || !connection}
                  className="save-directory-trigger"
                  aria-label={title + " · " + t("chooseFolder")}
                  onClick={() => setPicking(kind)}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  <TextTip>
                    {target?.path ||
                      t(follow ? "noPreviousLocation" : "chooseFolder")}
                  </TextTip>
                </Button>
              </ButtonGroup>
            </FieldSet>
          );
        })}
      </FieldGroup>
      {picking && connection ? (
        <DirectoryPicker
          connection={connection}
          initial={target?.path}
          onClose={() => setPicking(null)}
          onSelect={async (path) => {
            await update(picking, {
              fixed: { connectionId: connection.id, path },
            });
            setPicking(null);
          }}
        />
      ) : null}
    </>
  );
}
