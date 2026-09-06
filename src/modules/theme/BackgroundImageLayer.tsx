import { useEffect, useRef, useState } from "react";

const RESIZE_IDLE_MS = 280;
const FADE_IN_MS = 200;

/**
 * Paints one stored image as a translucent layer. `fixed` covers the window
 * for the app-wide background; `absolute` fills whichever positioned ancestor
 * it is mounted in, which is how a host background stays inside the terminal.
 */
export function BackgroundImageLayer({
  imageId,
  opacity,
  blur,
  position,
  zIndex,
}: {
  imageId: string | null;
  opacity: number;
  blur: number;
  position: "fixed" | "absolute";
  zIndex: number;
}) {
  const [state, setState] = useState<{ url: string; animated: boolean } | null>(
    null,
  );
  const [visible, setVisible] = useState(false);
  const lastUrlRef = useRef<string | null>(null);
  const resizing = useWindowResizing(RESIZE_IDLE_MS);
  const docHidden = useDocumentHidden();

  useEffect(() => {
    if (!imageId) return;
    let alive = true;
    let rafId: number | null = null;
    setVisible(false);
    void (async () => {
      const { getBgImage } = await import("./bgImageStore");
      const blob = await getBgImage(imageId).catch(() => null);
      if (!alive || !blob) return;
      const url = URL.createObjectURL(blob);
      if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current);
      lastUrlRef.current = url;
      const t = blob.type.toLowerCase();
      const animated =
        t === "image/gif" || t === "image/apng" || t === "image/webp";
      setState({ url, animated });
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (alive) setVisible(true);
      });
    })();
    return () => {
      alive = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [imageId]);

  useEffect(() => {
    return () => {
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current);
        lastUrlRef.current = null;
      }
    };
  }, []);

  if (!state) return null;
  const { url, animated } = state;

  const suspendAnimated = animated && (resizing || docHidden);
  const blurActive = !animated && blur > 0 && !resizing;

  return (
    <div
      aria-hidden
      className="terax-bg-surface"
      style={{
        position,
        inset: 0,
        zIndex,
        pointerEvents: "none",
        backgroundImage: suspendAnimated ? "none" : `url(${url})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        opacity: visible && !suspendAnimated ? opacity : 0,
        filter: blurActive ? `blur(${blur}px)` : undefined,
        transform: "translateZ(0)",
        transition: `opacity ${FADE_IN_MS}ms ease-out`,
      }}
    />
  );
}

function useWindowResizing(idleMs: number): boolean {
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    let timer: number | null = null;
    let active = false;
    const onResize = () => {
      if (!active) {
        active = true;
        setResizing(true);
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        active = false;
        setResizing(false);
        timer = null;
      }, idleMs);
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [idleMs]);
  return resizing;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.hidden,
  );
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}
