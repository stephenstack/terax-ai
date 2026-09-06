import {
  readBgFastPath,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import { BG_OPACITY_SETTINGS_MAX } from "@/modules/settings/store";
import { useState } from "react";
import { createPortal } from "react-dom";
import { BackgroundImageLayer } from "./BackgroundImageLayer";

const OVERLAY_Z = 2147483646;

/**
 * The app-wide background, covering the window. A remote host's own
 * background is not painted here: it belongs to the terminal it applies to,
 * so it is rendered inside the pane rather than over the whole app.
 */
export function SurfaceLayer() {
  const [fastPath] = useState(readBgFastPath);
  const storeActive = usePreferencesStore(
    (s) => s.backgroundKind === "image" && !!s.backgroundImageId,
  );
  const storeImageId = usePreferencesStore((s) => s.backgroundImageId);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const opacity = usePreferencesStore((s) => s.backgroundOpacity);
  const blur = usePreferencesStore((s) => s.backgroundBlur);

  const active = hydrated ? storeActive : fastPath.active;
  const imageId = hydrated ? storeImageId : fastPath.imageId;

  if (!active || typeof document === "undefined") return null;

  return createPortal(
    <BackgroundImageLayer
      imageId={imageId}
      opacity={Math.min(opacity, opacityCeiling())}
      blur={blur}
      position="fixed"
      zIndex={OVERLAY_Z}
    />,
    document.body,
  );
}

/**
 * The settings window caps its own background so it can never hide the
 * opacity slider. Every other window honours the setting exactly.
 */
function opacityCeiling(): number {
  return document.getElementById("settings-root")
    ? BG_OPACITY_SETTINGS_MAX
    : 1;
}
