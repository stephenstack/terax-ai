import { setBackgroundOverride } from "@/modules/theme";
import { useEffect } from "react";
import { useRemotesStore } from "./store";

/**
 * Point the surface at the active host's own background, and hand it back to
 * the app-wide preference whenever the active pane is not a remote that
 * defines one.
 */
export function useRemoteSurface(remoteId: string | undefined): void {
  const background = useRemotesStore((s) =>
    remoteId ? s.profiles.find((p) => p.id === remoteId)?.background : undefined,
  );

  useEffect(() => {
    setBackgroundOverride(background ?? null);
  }, [background]);

  useEffect(() => () => setBackgroundOverride(null), []);
}
