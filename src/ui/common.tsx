import {
  useEffect,
  useState,
  type RefObject,
  useRef,
  type ReactNode,
  type ComponentProps,
  type ReactElement,
} from "react";
import {
  MagnifyingGlassIcon,
  XIcon,
  CaretLeftIcon,
  CaretRightIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import { Button } from "./components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "./components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./components/ui/alert-dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./components/ui/input-group";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyContent,
} from "./components/ui/empty";
import { Field, FieldLabel } from "./components/ui/field";
import { useI18n } from "./i18n";
import { cn } from "./lib/utils";
export { Button };
export function Tip({
  text,
  children,
}: {
  text: string;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        portalContainer={
          (document.fullscreenElement as HTMLElement) || undefined
        }
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "size"> & { label: string }) {
  return (
    <Tip text={label}>
      <Button variant="ghost" size="icon" aria-label={label} {...props}>
        {children}
      </Button>
    </Tip>
  );
}
export function HelpTip({ text }: { text: string }) {
  return (
    <Tip text={text}>
      <Button variant="ghost" size="icon-xs" aria-label={text}>
        <InfoIcon />
      </Button>
    </Tip>
  );
}
export function TextTip({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <Tip text={children}>
      <span tabIndex={0} className={cn("truncate min-w-0", className)}>
        {children}
      </span>
    </Tip>
  );
}
export function Choice({
  value,
  onChange,
  options,
  label,
  disabled,
  id,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function Fade({
  children,
  className,
  horizontal,
  scrollRef,
  onEdges,
  ...props
}: ComponentProps<"div"> & {
  horizontal?: boolean;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onEdges?: (edges: { start: boolean; end: boolean }) => void;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef || internalRef;
  useEffect(() => {
    const el = ref.current!;
    const update = () => {
      const max = horizontal
        ? el.scrollWidth - el.clientWidth
        : el.scrollHeight - el.clientHeight;
      const position = horizontal ? el.scrollLeft : el.scrollTop;
      onEdges?.({
        start: position > 1 && max > 1,
        end: position < max - 1 && max > 1,
      });
      el.style.setProperty(
        "--fade-start",
        position > 1 && max > 1 ? "16px" : "0px",
      );
      el.style.setProperty(
        "--fade-end",
        position < max - 1 && max > 1 ? "16px" : "0px",
      );
      if (horizontal) {
        el.style.setProperty(
          "--fade-start-alpha",
          position > 1 && max > 1 ? "1" : "0",
        );
        el.style.setProperty(
          "--fade-end-alpha",
          position < max - 1 && max > 1 ? "1" : "0",
        );
      }
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of el.children) ro.observe(child);
      update();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [horizontal, onEdges, ref]);
  return (
    <div
      ref={ref}
      className={cn("fade-scroll", horizontal && "horizontal", className)}
      {...props}
    >
      {children}
    </div>
  );
}
/** Shared single-row navigation: edge fades and page buttons only where content remains. */
export function HorizontalScroll({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  const t = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const onEdges = useRef((next: { start: boolean; end: boolean }) =>
    setEdges((old) =>
      old.start === next.start && old.end === next.end ? old : next,
    ),
  ).current;
  const page = (direction: number) =>
    ref.current?.scrollBy({
      left: direction * Math.max(80, ref.current.clientWidth * 0.8),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  return (
    <div className={cn("horizontal-scroll", className)} {...props}>
      <Fade
        horizontal
        scrollRef={ref}
        onEdges={onEdges}
        className="horizontal-scroll-items"
      >
        {children}
      </Fade>
      <IconButton
        className="horizontal-scroll-previous"
        label={t("scrollPrevious")}
        data-visible={edges.start}
        aria-hidden={!edges.start}
        disabled={!edges.start}
        onClick={() => page(-1)}
      >
        <CaretLeftIcon />
      </IconButton>
      <IconButton
        className="horizontal-scroll-next"
        label={t("scrollNext")}
        data-visible={edges.end}
        aria-hidden={!edges.end}
        disabled={!edges.end}
        onClick={() => page(1)}
      >
        <CaretRightIcon />
      </IconButton>
    </div>
  );
}
export function Search({
  value,
  onChange,
  label,
  id,
}: {
  value: string;
  onChange(v: string): void;
  label: string;
  id?: string;
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <MagnifyingGlassIcon />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </InputGroup>
  );
}
export function FormField({
  label,
  children,
  htmlFor,
  error,
  help,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  error?: string;
  help?: string;
}) {
  return (
    <Field data-invalid={!!error}>
      <div className="field-heading">
        {help ? (
          <div className="field-title">
            <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
            <HelpTip text={help} />
          </div>
        ) : (
          <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        )}
        <span className="field-error" role="status">
          {error}
        </span>
      </div>
      {children}
    </Field>
  );
}
export function PageHeader({
  title,
  back,
  children,
  sub,
}: {
  title: string;
  back?: () => void;
  children?: ReactNode;
  sub?: ReactNode;
}) {
  const t = useI18n();
  return (
    <header className="page-header">
      <div className="header-main">
        <div className="heading">
          <div className="heading-slot">
            {back ? (
              <IconButton label={t("back")} onClick={back}>
                <CaretLeftIcon />
              </IconButton>
            ) : (
              <span className="mark" />
            )}
          </div>
          <TextTip className="page-title">{title}</TextTip>
        </div>
        <div className="actions">{children}</div>
      </div>
      {sub && <div className="header-sub">{sub}</div>}
    </header>
  );
}
export function Blank({
  title,
  children,
  size = "page",
}: {
  title: string;
  children?: ReactNode;
  size?: "page" | "section";
}) {
  return (
    <Empty data-size={size}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  className,
}: {
  title: string;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const t = useI18n();
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn("modal", className)}
      >
        <header className="modal-header">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t("close")}>
              <XIcon />
            </Button>
          </DialogClose>
        </header>
        {children}
        {footer && <footer className="modal-footer">{footer}</footer>}
      </DialogContent>
    </Dialog>
  );
}
export function Confirm({
  title,
  description,
  onConfirm,
  onClose,
  action,
}: {
  title: string;
  description: string;
  onConfirm(): void;
  onClose(): void;
  action?: string;
}) {
  const t = useI18n();
  return (
    <AlertDialog open onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent className="confirmation">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action || t("remove")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function clock(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
