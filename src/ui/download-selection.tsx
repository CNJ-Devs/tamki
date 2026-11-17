import { useId, useState, type ReactNode } from "react";
import {
  CaretRightIcon,
  CaretDownIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  videoQualityLabel,
  type DownloadChoice,
  type DownloadDraft,
} from "../shared/capture";
import { Button, TextTip, Tip } from "./common";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "./components/ui/popover";
import { Checkbox } from "./components/ui/checkbox";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./components/ui/field";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { useI18n, errorMessage } from "./i18n";
export interface EpisodeQualityControls {
  info: DownloadDraft["itemQualities"];
  defaults: number[];
  overrides: Record<string, number[]>;
  setOverride(id: string, qualities?: number[]): void;
  check(id: string): void;
}
function unavailableQualities(
  quality: EpisodeQualityControls,
  id: string,
): number[] {
  const available = quality.info?.[id]?.qualities;
  const wanted =
    id in quality.overrides ? quality.overrides[id] : quality.defaults;
  return available
    ? wanted.filter((q) => q !== 0 && !available.some((v) => v.id === q))
    : [];
}
export function DownloadSection({
  title,
  summary,
  disabled,
  children,
}: {
  title: string;
  summary?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <FieldSet disabled={disabled} className="capture-form-section">
        <FieldLegend variant="label" className="capture-section-legend">
          <CollapsibleTrigger asChild>
            <Button
              variant="plain"
              className="capture-section-trigger capture-chevron"
              aria-label={title}
              disabled={disabled}
            >
              <span>{title}</span>
              <span className="capture-section-summary" aria-live="polite">
                {summary}
              </span>
              <CaretRightIcon />
            </Button>
          </CollapsibleTrigger>
        </FieldLegend>
        <CollapsibleContent className="capture-items capture-section-body">
          {children}
        </CollapsibleContent>
      </FieldSet>
    </Collapsible>
  );
}
function EpisodeQualityPicker({
  choice,
  quality,
  disabled,
}: {
  choice: DownloadChoice;
  quality: EpisodeQualityControls;
  disabled: boolean;
}) {
  const t = useI18n(),
    id = useId(),
    resourceId = choice.resourceIds[0];
  const info = quality.info?.[resourceId],
    own = quality.overrides[resourceId];
  const missing = unavailableQualities(quality, resourceId);
  const hint = missing.length
    ? t("captureQualityMissing").replace(
        "{quality}",
        missing.map(videoQualityLabel).join("、"),
      )
    : info?.error
      ? errorMessage(new Error(info.error), t)
      : "";
  const available = info?.qualities || [];
  const options = [
    ...available,
    ...(own || [])
      .filter((q) => !available.some((v) => v.id === q))
      .map((q) => ({
        id: q,
        label: q === 0 ? t("downloadQualityAuto") : videoQualityLabel(q),
      })),
  ];
  return (
    <div className="capture-episode-quality">
      {hint && (
        <Tip text={hint}>
          <span
            className="capture-quality-warning"
            tabIndex={0}
            aria-label={hint}
          >
            <WarningCircleIcon />
          </span>
        </Tip>
      )}
      <Popover
        onOpenChange={(open) => {
          if (open && info?.error) quality.check(resourceId);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            role="combobox"
            aria-haspopup="dialog"
            aria-label={`${t("captureEpisodeQuality")} · ${choice.title}`}
            disabled={disabled}
            className="capture-episode-quality-trigger"
          >
            <TextTip>
              {own
                ? own
                    .map(
                      (q) =>
                        options.find((v) => v.id === q)?.label ||
                        videoQualityLabel(q),
                    )
                    .join(" · ")
                : t("captureQualityInherit")}
            </TextTip>
            <CaretDownIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={`${t("captureEpisodeQuality")} · ${choice.title}`}
        >
          <FieldSet className="gap-2">
            <FieldLegend className="sr-only">
              {t("captureEpisodeQuality")}
            </FieldLegend>
            <Field orientation="horizontal">
              <Checkbox
                id={`${id}-inherit`}
                checked={!own}
                disabled={disabled || (!own && !available.length)}
                onCheckedChange={(checked) => {
                  const defaults = quality.defaults.filter((q) =>
                    available.some((v) => v.id === q),
                  );
                  quality.setOverride(
                    resourceId,
                    checked === true
                      ? undefined
                      : defaults.length
                        ? defaults
                        : available.length
                          ? [available[0].id]
                          : undefined,
                  );
                }}
              />
              <FieldLabel htmlFor={`${id}-inherit`}>
                {t("captureQualityInherit")}
              </FieldLabel>
            </Field>
            {options.map((option) => (
              <Field orientation="horizontal" key={option.id}>
                <Checkbox
                  id={`${id}-${option.id}`}
                  checked={!!own?.includes(option.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    const next =
                      checked === true
                        ? option.id === 0
                          ? [0]
                          : [...(own || []).filter((q) => q !== 0), option.id]
                        : (own || []).filter((q) => q !== option.id);
                    quality.setOverride(
                      resourceId,
                      next.length ? [...new Set(next)] : undefined,
                    );
                  }}
                />
                <FieldLabel htmlFor={`${id}-${option.id}`}>
                  {option.label}
                </FieldLabel>
              </Field>
            ))}
            {!info && <small role="status">{t("loading")}</small>}
            {info?.error && (
              <small className="muted">
                {errorMessage(new Error(info.error), t)}
              </small>
            )}
          </FieldSet>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ChoiceRow({
  choice,
  selected,
  toggle,
  disabled,
  quality,
  expandedChoices,
  onExpand,
}: {
  choice: DownloadChoice;
  selected: Set<string>;
  toggle(ids: string[], checked: boolean): void;
  disabled: boolean;
  quality?: EpisodeQualityControls;
  expandedChoices: Record<string, boolean>;
  onExpand(id: string, expanded: boolean): void;
}) {
  const t = useI18n(),
    id = useId();
  const expanded = !!expandedChoices[choice.id];
  const count = choice.resourceIds.filter((id) => selected.has(id)).length;
  const checked =
    count === choice.resourceIds.length
      ? true
      : count
        ? "indeterminate"
        : false;
  const row = (
    <Field
      orientation="horizontal"
      className="capture-choice-row"
      data-disabled={disabled}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(checked) =>
          toggle(choice.resourceIds, checked === true)
        }
      />
      <FieldLabel htmlFor={id}>
        <TextTip>{choice.title}</TextTip>
      </FieldLabel>
      {choice.children && (
        <>
          <small>
            {count} / {choice.resourceIds.length}
          </small>
          <CollapsibleTrigger asChild>
            <Button
              variant="plain"
              size="icon-xs"
              className="capture-chevron"
              disabled={disabled}
              aria-label={t(expanded ? "captureCollapse" : "captureExpand")}
            >
              <CaretRightIcon />
            </Button>
          </CollapsibleTrigger>
        </>
      )}
    </Field>
  );
  return choice.children ? (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => onExpand(choice.id, open)}
      className="capture-choice-group"
    >
      {row}
      <CollapsibleContent className="capture-items capture-choice-children">
        {choice.children.map((child) => (
          <ChoiceRow
            key={child.id}
            choice={child}
            selected={selected}
            toggle={toggle}
            disabled={disabled}
            quality={quality}
            expandedChoices={expandedChoices}
            onExpand={onExpand}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  ) : (
    <div className="capture-choice-leaf">
      {row}
      {quality && count > 0 && (
        <EpisodeQualityPicker
          choice={choice}
          quality={quality}
          disabled={disabled}
        />
      )}
    </div>
  );
}

export function DownloadSelection({
  choices,
  selected,
  onChange,
  disabled,
  byWork,
  quality,
}: {
  choices: DownloadChoice[];
  selected: Set<string>;
  onChange(value: Set<string>): void;
  disabled: boolean;
  byWork: boolean;
  quality?: EpisodeQualityControls;
}) {
  const t = useI18n();
  const [expandedChoices, setExpandedChoices] = useState<
    Record<string, boolean>
  >({});
  const all = [...new Set(choices.flatMap((choice) => choice.resourceIds))];
  const allId = useId();
  const needsChanges = quality
    ? all.filter(
        (id) => selected.has(id) && unavailableQualities(quality, id).length,
      ).length
    : 0;
  const toggle = (ids: string[], checked: boolean) => {
    const next = new Set(selected);
    for (const id of ids)
      if (checked) next.add(id);
      else next.delete(id);
    onChange(next);
  };
  return (
    <DownloadSection
      disabled={disabled}
      title={t("captureDownloadContents")}
      summary={
        <>
          {!!needsChanges && (
            <>
              <span className="error-text">
                {t("captureQualitiesNeedChanges").replace(
                  "{n}",
                  String(needsChanges),
                )}
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          {t("captureSelectedCount")
            .replace("{selected}", String(selected.size))
            .replace("{total}", String(all.length))}
        </>
      }
    >
      <div className="capture-selection-toolbar">
        <Field orientation="horizontal">
          <Checkbox
            id={allId}
            checked={selected.size === all.length}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? new Set(all) : new Set())
            }
          />
          <FieldLabel htmlFor={allId}>{t("captureSelectAll")}</FieldLabel>
        </Field>
      </div>
      {byWork && <small className="muted">{t("captureSaveByWork")}</small>}
      <div className="capture-choice-list">
        {choices.map((choice) => (
          <ChoiceRow
            key={choice.id}
            choice={choice}
            selected={selected}
            toggle={toggle}
            disabled={disabled}
            quality={quality}
            expandedChoices={expandedChoices}
            onExpand={(id, expanded) =>
              setExpandedChoices((old) => ({ ...old, [id]: expanded }))
            }
          />
        ))}
      </div>
    </DownloadSection>
  );
}
