import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import { usePromptStore } from "./lib/opener";
import type { RemotesPanel as RemotesPanelType } from "./RemotesPanel";

/**
 * The panel and its dialogs are the bulk of the remotes UI and are worthless
 * to a user who never opens them, so they stay out of the startup graph. Only
 * the opener, store and types are eager, because a restored remote tab has to
 * be able to spawn before anything is rendered.
 */
const RemotesPanelInner = lazy(() =>
  import("./RemotesPanel").then((m) => ({ default: m.RemotesPanel })),
);

const RemotePromptsInner = lazy(() =>
  import("./RemotePrompts").then((m) => ({ default: m.RemotePrompts })),
);

export function RemotesPanel(props: ComponentProps<typeof RemotesPanelType>) {
  return (
    <Suspense fallback={null}>
      <RemotesPanelInner {...props} />
    </Suspense>
  );
}

/**
 * Mounted at the App root but inert until a connect actually asks something,
 * so the dialog chunk is fetched on the first prompt rather than at boot.
 */
export function RemotePrompts() {
  const pending = usePromptStore((s) => s.queue.length > 0);
  if (!pending) return null;
  return (
    <Suspense fallback={null}>
      <RemotePromptsInner />
    </Suspense>
  );
}
