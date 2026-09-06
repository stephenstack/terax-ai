import { create } from "zustand";

/**
 * A background that outranks the app-wide preference while it is set, so a
 * remote host can carry its own. Owned by the theme module and written to by
 * whoever knows which session is active, which keeps theme from depending on
 * remotes.
 */
export type BackgroundOverride = {
  imageId: string;
  opacity: number;
  blur: number;
};

type State = {
  override: BackgroundOverride | null;
};

export const useBackgroundOverride = create<State>(() => ({ override: null }));

export function setBackgroundOverride(next: BackgroundOverride | null): void {
  const current = useBackgroundOverride.getState().override;
  if (
    current === next ||
    (current &&
      next &&
      current.imageId === next.imageId &&
      current.opacity === next.opacity &&
      current.blur === next.blur)
  ) {
    return;
  }
  useBackgroundOverride.setState({ override: next });
}
