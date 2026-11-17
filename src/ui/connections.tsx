import { useEffect, useRef, useState } from "react";
import {
  FolderIcon,
  HardDrivesIcon,
  PlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  CaretRightIcon,
  CaretLeftIcon,
  ArrowSquareOutIcon,
  ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import {
  Button,
  IconButton,
  HelpTip,
  Modal,
  Fade,
  FormField,
  Choice,
  TextTip,
  Blank,
  Confirm,
} from "./common";
import { Field, FieldLabel, FieldGroup } from "./components/ui/field";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { useI18n, errorMessage } from "./i18n";
import type { Connection, Entry } from "../shared/model";
import { toast } from "sonner";
interface Draft {
  id: string;
  type: "local" | "zspace";
  roots: string[];
  authorized: boolean;
  selectedRoots?: string[];
}
export function ConnectionWizard({
  initial,
  onClose,
}: {
  initial?: Connection;
  onClose(): void;
}) {
  const t = useI18n();
  const [step, setStep] = useState<"type" | "auth" | "folders">(
    initial ? "folders" : "type",
  );
  const [type, setType] = useState<"local" | "zspace">(
    initial?.type || "local",
  );
  const [draft, setDraft] = useState<Draft>();
  const [auth, setAuth] = useState<{
    draftId: string;
    url: string;
    expiresAt: number;
  }>();
  const [allowLANHTTP, setAllowLANHTTP] = useState(
    initial?.allowLANHTTP || false,
  );
  const [name, setName] = useState(initial?.name || "");
  const [roots, setRoots] = useState<string[]>(initial?.roots || []);
  const [depths, setDepths] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      (initial?.roots || []).map((root) => [
        root,
        initial?.scanDepths?.[root] ?? 1,
      ]),
    ),
  );
  const [customDepths, setCustomDepths] = useState<string[]>([]);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const source = draft || initial;
  const ownedDraft = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [browseRoots, setBrowseRoots] = useState(
    initial?.browseRoots || initial?.roots || [],
  );
  const [retry, setRetry] = useState(0);
  const cancelDraft = (key: string) =>
    window.tamki.library("cancel-draft", key).catch(() => {});
  const own = async (key: string) => {
    if (!mounted.current) {
      await cancelDraft(key);
      return false;
    }
    if (ownedDraft.current && ownedDraft.current !== key)
      await cancelDraft(ownedDraft.current);
    ownedDraft.current = key;
    return true;
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (ownedDraft.current) void cancelDraft(ownedDraft.current);
    };
  }, []);
  const local = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await window.tamki.library<Draft | null>(
        "choose-local",
        source?.id,
      );
      if (value && (await own(value.id))) {
        setDraft(value);
        setBrowseRoots(value.roots);
        setType("local");
        setRoots([
          ...new Set([...roots, ...(value.selectedRoots || value.roots)]),
        ]);
        setName(name || t("local"));
        setStep("folders");
      }
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const begin = async () => {
    setType("zspace");
    setStep("auth");
    setError("");
    setBusy(true);
    setCode("");
    try {
      if (ownedDraft.current) await cancelDraft(ownedDraft.current);
      ownedDraft.current = undefined;
      setAuth(undefined);
      const value =
        await window.tamki.library<NonNullable<typeof auth>>("zspace-begin");
      if (await own(value.draftId)) setAuth(value);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      const value = await window.tamki.library<Draft>("zspace-finish", {
        draftId: auth.draftId,
        code,
      });
      if (!mounted.current) {
        await cancelDraft(value.id);
        return;
      }
      setCode("");
      setDraft(value);
      setBrowseRoots(value.roots);
      setName(t("zspace"));
      setStep("folders");
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!source) {
      setEntries([]);
      return;
    }
    let live = true;
    setBusy(true);
    setError("");
    setEntries([]);
    const load = directory
      ? window.tamki
          .library<Entry[]>("list", { id: source.id, path: directory })
          .then((items) => {
            if (live) setEntries(items.filter((e) => e.directory));
          })
      : window.tamki
          .library<string[]>("browse-roots", source.id)
          .then((roots) => {
            if (live) setBrowseRoots(roots);
          });
    load
      .catch((e) => {
        if (live) {
          setEntries([]);
          setError(errorMessage(e, t));
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [source?.id, directory, retry]);
  const toggle = (path: string) =>
    setRoots((old) =>
      old.includes(path) ? old.filter((p) => p !== path) : [...old, path],
    );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await window.tamki.library("save-connection", {
        id: initial?.id,
        type,
        name,
        roots,
        allowLANHTTP,
        scanDepths: Object.fromEntries(
          roots.map((root) => [root, depths[root] ?? 3]),
        ),
        draftId: draft?.id,
      });
      ownedDraft.current = undefined;
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const displayed: Entry[] = directory
    ? entries
    : browseRoots.map((path) => ({
        path,
        name: path,
        directory: true,
        size: 0,
        modified: 0,
      }));
  return (
    <Modal
      title={
        initial
          ? t("editConnection")
          : step === "auth"
            ? t("authorize")
            : t("addConnection")
      }
      open
      onClose={onClose}
      className="connection-modal"
      footer={
        step === "type" ? undefined : (
          <>
            <span className="modal-status" role="status">
              {busy ? t("loading") : step === "auth" ? error : ""}
            </span>
            <Button variant="secondary" onClick={onClose}>
              {t("cancel")}
            </Button>
            {step === "auth" ? (
              <Button
                disabled={!auth || busy || !code.trim()}
                onClick={() => void finish()}
              >
                {t("finishAuthorization")}
              </Button>
            ) : (
              <Button
                disabled={busy || !name.trim() || !roots.length}
                onClick={() => void save()}
              >
                {t("save")}
              </Button>
            )}
          </>
        )
      }
    >
      <Fade className="modal-body">
        {step === "type" ? (
          <>
            <div className="connection-types">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void begin()}
              >
                <HardDrivesIcon />
                <span>{t("zspace")}</span>
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void local()}
              >
                <FolderIcon />
                <span>{t("local")}</span>
              </Button>
            </div>
            <p role="status" className="error-text">
              {error}
            </p>
          </>
        ) : step === "auth" ? (
          <FieldGroup>
            <div className="provider-mark">
              <HardDrivesIcon />
              <h3>{t("zspace")}</h3>
            </div>
            <p className="muted">{t("authorizationHint")}</p>
            <Button
              variant="secondary"
              disabled={!auth || busy}
              onClick={() =>
                void window.tamki
                  .library("zspace-open", auth!.draftId)
                  .catch((e) => setError(errorMessage(e, t)))
              }
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              {t("openAuthorization")}
            </Button>
            <FormField label={t("authorizationCode")} htmlFor="auth-code">
              <Input
                id="auth-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void begin()}
              >
                <ArrowClockwiseIcon data-icon="inline-start" />
                {t("refresh")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void window.tamki
                    .library<boolean>("choose-cli")
                    .then((chosen) => {
                      if (chosen) return begin();
                    })
                    .catch((e) => setError(errorMessage(e, t)))
                }
              >
                {t("chooseCLI")}
              </Button>
            </div>
          </FieldGroup>
        ) : (
          <FieldGroup>
            <FormField label={t("name")} htmlFor="connection-name">
              <Input
                id="connection-name"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
            {type === "zspace" && (
              <Field orientation="horizontal">
                <Checkbox
                  id="allow-lan-http"
                  checked={allowLANHTTP}
                  onCheckedChange={(v) => setAllowLANHTTP(v === true)}
                />
                <FieldLabel htmlFor="allow-lan-http">{t("lanHTTP")}</FieldLabel>
                <HelpTip text={t("lanHTTPHelp")} />
              </Field>
            )}
            <FormField label={t("roots")} error={error}>
              <div className="directory-toolbar">
                <IconButton
                  label={t("back")}
                  disabled={!directory || busy}
                  onClick={() => {
                    const parent =
                      directory.slice(0, directory.lastIndexOf("/")) || "/";
                    setDirectory(
                      browseRoots.some(
                        (root) =>
                          parent === root ||
                          parent.startsWith(root === "/" ? "/" : root + "/"),
                      )
                        ? parent
                        : "",
                    );
                  }}
                >
                  <CaretLeftIcon />
                </IconButton>
                <TextTip>{directory || t("roots")}</TextTip>
                {type === "local" && (
                  <IconButton
                    label={t("chooseFolders")}
                    disabled={busy}
                    onClick={() => void local()}
                  >
                    <PlusIcon />
                  </IconButton>
                )}
              </div>
              <div className="directory-list">
                {directory && (
                  <label className="folder-row">
                    <Checkbox
                      disabled={busy}
                      checked={roots.includes(directory)}
                      onCheckedChange={() => toggle(directory)}
                    />
                    <span>{t("chooseFolder")}</span>
                  </label>
                )}
                {displayed.map((entry) => (
                  <div className="folder-row" key={entry.path}>
                    <Checkbox
                      disabled={busy}
                      aria-label={entry.name}
                      checked={roots.includes(entry.path)}
                      onCheckedChange={() => toggle(entry.path)}
                    />
                    <Button
                      variant="ghost"
                      className="folder-open"
                      disabled={busy}
                      onClick={() => setDirectory(entry.path)}
                    >
                      <FolderIcon data-icon="inline-start" />
                      <TextTip>{entry.name}</TextTip>
                      <CaretRightIcon data-icon="inline-end" />
                    </Button>
                  </div>
                ))}
                {error && !busy ? (
                  <Button
                    variant="secondary"
                    onClick={() => setRetry((v) => v + 1)}
                  >
                    {t("refresh")}
                  </Button>
                ) : (
                  !displayed.length && !busy && <Blank title={t("noFolders")} />
                )}
              </div>
            </FormField>
            <div className="settings-list">
              <div className="section-heading">
                <div className="field-title">
                  <h3>{t("scanDepth")}</h3>
                  <HelpTip text={t("scanDepthHelp")} />
                </div>
              </div>
              <div className="selected-roots">
                {roots.map((root) => (
                  <div key={root}>
                    <TextTip>{root}</TextTip>
                    <div className="root-depth">
                      <Choice
                        label={`${t("scanDepth")} · ${root}`}
                        value={
                          customDepths.includes(root) ||
                          ![0, 1, 2, 3, 4, 5].includes(depths[root] ?? 3)
                            ? "custom"
                            : String(depths[root] ?? 3)
                        }
                        onChange={(v) => {
                          setCustomDepths((old) =>
                            v === "custom"
                              ? [...old, root]
                              : old.filter((p) => p !== root),
                          );
                          if (v !== "custom")
                            setDepths((old) => ({ ...old, [root]: Number(v) }));
                        }}
                        options={[
                          ...[0, 1, 2, 3, 4, 5].map((n) => ({
                            value: String(n),
                            label:
                              n === 0
                                ? t("scanCurrent")
                                : n === 1
                                  ? t("scanOneLevel")
                                  : t("scanLevels").replace("{n}", String(n)),
                          })),
                          { value: "custom", label: t("scanCustom") },
                        ]}
                      />
                      {(customDepths.includes(root) ||
                        ![0, 1, 2, 3, 4, 5].includes(depths[root] ?? 3)) && (
                        <Input
                          type="number"
                          min={0}
                          max={32}
                          aria-label={t("scanDepth")}
                          value={depths[root] ?? 3}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isInteger(n) && n >= 0 && n <= 32)
                              setDepths((old) => ({ ...old, [root]: n }));
                          }}
                        />
                      )}
                    </div>
                    <IconButton
                      label={t("remove")}
                      onClick={() => toggle(root)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                ))}
              </div>
            </div>
          </FieldGroup>
        )}
      </Fade>
    </Modal>
  );
}
export function Connections({ connections }: { connections: Connection[] }) {
  const t = useI18n();
  const [edit, setEdit] = useState<Connection | "new" | null>(null),
    [remove, setRemove] = useState<Connection | null>(null);
  return (
    <>
      <div className="settings-list">
        <div className="section-heading">
          <h2>{t("storageConnections")}</h2>
          <Button variant="secondary" onClick={() => setEdit("new")}>
            <PlusIcon data-icon="inline-start" />
            {t("addConnection")}
          </Button>
        </div>
        <div className="connection-list">
          {!connections.length && (
            <Blank title={t("noConnections")} size="section" />
          )}
          {connections.map((c) => (
            <div className="connection-row" key={c.id}>
              <div className="connection-icon">
                {c.type === "local" ? <FolderIcon /> : <HardDrivesIcon />}
              </div>
              <div className="connection-copy">
                <TextTip>{c.name}</TextTip>
                <span className="muted">
                  {t(c.type)} · {t(c.status)}
                </span>
                {c.error && (
                  <span className="error-text">{errorMessage(c.error, t)}</span>
                )}
              </div>
              <IconButton
                label={t("testConnection")}
                disabled={c.status === "scanning"}
                onClick={() =>
                  void window.tamki
                    .library("test-connection", c.id)
                    .then(() => toast.success(t("connectionOK")))
                    .catch((e) => toast.error(errorMessage(e, t)))
                }
              >
                <ArrowClockwiseIcon />
              </IconButton>
              <IconButton
                label={t("editConnection")}
                onClick={() => setEdit(c)}
              >
                <PencilSimpleIcon />
              </IconButton>
              <IconButton label={t("remove")} onClick={() => setRemove(c)}>
                <TrashIcon />
              </IconButton>
            </div>
          ))}
        </div>
      </div>
      {edit && (
        <ConnectionWizard
          initial={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
        />
      )}
      {remove && (
        <Confirm
          title={t("removeConnectionTitle")}
          description={t("removeConnectionBody")}
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void window.tamki
              .library("remove-connection", remove.id)
              .then(() => setRemove(null))
              .catch((e) => toast.error(errorMessage(e, t)))
          }
        />
      )}
    </>
  );
}
export function FilePicker({
  connections,
  onClose,
  onSelect,
  title,
}: {
  connections: Connection[];
  onClose(): void;
  onSelect?(connectionId: string, paths: string[]): Promise<void>;
  title?: string;
}) {
  const t = useI18n();
  const [connectionId, setConnectionId] = useState(connections[0]?.id || ""),
    [directory, setDirectory] = useState(""),
    [entries, setEntries] = useState<Entry[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const connection = connections.find((c) => c.id === connectionId);
  useEffect(() => {
    if (!directory) {
      setEntries([]);
      return;
    }
    let live = true;
    setBusy(true);
    setError("");
    window.tamki
      .library<Entry[]>("list", { id: connectionId, path: directory })
      .then((items) => {
        if (live) setEntries(items);
      })
      .catch((e) => {
        if (live) {
          setError(errorMessage(e, t));
          setEntries([]);
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [connectionId, directory]);
  const displayed = directory
    ? entries.filter(
        (e) =>
          e.directory ||
          (/\.(mp4|m4v|webm|mkv|mov|avi|ts|m2ts|mpg|mpeg|rmvb|rm|wmv|flv)$/i.test(
            e.name,
          ) &&
            e.size > 0),
      )
    : connection?.roots.map((p) => ({
        path: p,
        name: p,
        directory: true,
        size: 0,
        modified: 0,
      })) || [];
  return (
    <Modal
      open
      title={title || t("addFiles")}
      onClose={onClose}
      className="connection-modal"
      footer={
        <>
          <span className="modal-status" role="status">
            {busy ? t("loading") : error}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={() => {
              setBusy(true);
              void (
                onSelect
                  ? onSelect(connectionId, selected)
                  : window.tamki.library("add-files", {
                      connectionId,
                      paths: selected,
                    })
              )
                .then(onClose)
                .catch((e) => setError(errorMessage(e, t)))
                .finally(() => setBusy(false));
            }}
          >
            {t("add")}
            {selected.length ? ` (${selected.length})` : ""}
          </Button>
        </>
      }
    >
      <Fade className="modal-body">
        <FieldGroup>
          <FormField label={t("selectStorage")}>
            <Choice
              label={t("selectStorage")}
              value={connectionId}
              onChange={(v) => {
                setConnectionId(v);
                setDirectory("");
                setSelected([]);
              }}
              options={connections.map((c) => ({ value: c.id, label: c.name }))}
            />
          </FormField>
          <div className="directory-toolbar">
            <IconButton
              label={t("back")}
              disabled={!directory || busy}
              onClick={() => {
                const parent = directory.slice(0, directory.lastIndexOf("/"));
                setDirectory(
                  connection?.roots.some(
                    (r) => parent === r || parent.startsWith(r + "/"),
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
          <div className="directory-list">
            {displayed.map((e) =>
              e.directory ? (
                <Button
                  variant="ghost"
                  className="folder-open"
                  key={e.path}
                  onClick={() => setDirectory(e.path)}
                >
                  <FolderIcon data-icon="inline-start" />
                  <TextTip>{e.name}</TextTip>
                  <CaretRightIcon data-icon="inline-end" />
                </Button>
              ) : (
                <label className="folder-row" key={e.path}>
                  <Checkbox
                    checked={selected.includes(e.path)}
                    onCheckedChange={() =>
                      setSelected((old) =>
                        old.includes(e.path)
                          ? old.filter((p) => p !== e.path)
                          : [...old, e.path],
                      )
                    }
                  />
                  <TextTip>{e.name}</TextTip>
                </label>
              ),
            )}
            {!displayed.length && !busy && !error && (
              <Blank title={t("noVideos")} />
            )}
          </div>
        </FieldGroup>
      </Fade>
    </Modal>
  );
}
