/**
 * A background painted over a terminal tab's own area rather than the window.
 *
 * Lives in the terminal module because that is what renders it; remote
 * profiles re-export this as their background shape so there is exactly one
 * definition and no dependency from the terminal back onto remotes.
 */
export type TerminalBackground = {
  imageId: string;
  /** 0..1, exactly as rendered. */
  opacity: number;
  blur: number;
};
