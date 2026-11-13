import { useEffect, type RefObject } from "react";

// Works with a component-owned scroll element (CommandList), without nesting scrollbars.
export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.style.setProperty("--fade-start", el.scrollTop > 1 ? "12px" : "0px");
      el.style.setProperty(
        "--fade-end",
        el.scrollHeight - el.clientHeight - el.scrollTop > 1 ? "12px" : "0px",
      );
    };
    const size = new ResizeObserver(update);
    const content = new MutationObserver(update);
    size.observe(el);
    content.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      size.disconnect();
      content.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [ref]);
}
