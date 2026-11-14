/**
 * A ResizeObserver that reports the first size at once and later sizes only
 * once they settle, so an animated layout change (the rail growing, a split
 * divider being dragged) re-lays out a chart or graph once at the end instead
 * of on every frame.
 */
export function observeSettledSize(el: Element, onSize: (rect: DOMRectReadOnly) => void, settleMs = 160): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  let first = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const rect = entry.contentRect;
    if (first) {
      first = false;
      onSize(rect);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onSize(rect), settleMs);
  });
  ro.observe(el);
  return () => {
    if (timer) clearTimeout(timer);
    ro.disconnect();
  };
}
