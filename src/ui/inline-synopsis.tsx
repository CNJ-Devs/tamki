import { useLayoutEffect, useRef, useState } from "react";
import { Button, Fade, Modal } from "./common";
import { useI18n } from "./i18n";
export function InlineSynopsis({
  text,
  title,
  lines = 4,
}: {
  text: string;
  title: string;
  lines?: number;
}) {
  const t = useI18n(),
    root = useRef<HTMLDivElement>(null),
    measure = useRef<HTMLDivElement>(null),
    copy = useRef<HTMLSpanElement>(null),
    tail = useRef<HTMLSpanElement>(null);
  const [summary, setSummary] = useState({ excerpt: text, clipped: false }),
    [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = root.current,
      box = measure.current,
      content = copy.current,
      ending = tail.current;
    if (!el || !box || !content || !ending) return;
    const segments = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        text,
      ),
    ].map((s) => s.segment);
    let live = true,
      frame = 0;
    const update = () => {
      if (!live || !el.clientWidth) return;
      const height = parseFloat(getComputedStyle(el).lineHeight) * lines;
      const fits = (value: string, more: boolean) => {
        content.textContent = value;
        ending.hidden = !more;
        return box.offsetHeight <= height + 0.5;
      };
      let excerpt = text,
        clipped = !fits(text, false);
      if (clipped) {
        let low = 0,
          high = segments.length;
        const prefix = (length: number) =>
          segments
            .slice(0, length)
            .join("")
            .replace(/[\s.…]+$/u, "");
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(prefix(mid), true)) low = mid;
          else high = mid - 1;
        }
        excerpt = prefix(low);
      }
      setSummary((old) =>
        old.excerpt === excerpt && old.clipped === clipped
          ? old
          : { excerpt, clipped },
      );
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(el);
    update();
    void document.fonts.ready.then(update);
    return () => {
      live = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [text, lines, t("more")]);
  if (!text) return null;
  return (
    <>
      <div className="inline-synopsis" ref={root}>
        <span>{summary.excerpt}</span>
        {summary.clipped && (
          <span className="synopsis-tail">
            …
            <Button
              variant="link"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(true);
              }}
            >
              {t("more")}
            </Button>
          </span>
        )}
        <div className="synopsis-measure-box" aria-hidden="true">
          <div ref={measure}>
            <span ref={copy} />
            <span ref={tail} className="synopsis-tail">
              …<span>{t("more")}</span>
            </span>
          </div>
        </div>
      </div>
      {open && (
        <Modal title={title} open onClose={() => setOpen(false)}>
          <Fade className="modal-body">
            <p className="full-synopsis">{text}</p>
          </Fade>
        </Modal>
      )}
    </>
  );
}
