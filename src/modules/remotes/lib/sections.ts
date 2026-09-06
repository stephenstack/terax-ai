import { create } from "zustand";

/**
 * localStorage, but never throwing: it is unavailable in a private window and
 * a remembered pane width is not worth taking the panel down for.
 */
export const sectionStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};


type State = {
  filesExpanded: boolean;
  gitExpanded: boolean;
  /** Height of each open section as a percentage of the panel. */
  sizes: Record<string, number>;
  toggle: (section: "files" | "git") => void;
  setSize: (id: string, percent: number) => void;
};

/**
 * Which lower sections are open. Module state rather than the panel's own,
 * because switching the sidebar to another view unmounts the panel and the
 * arrangement should still be there on the way back.
 *
 */
export const useRemoteSections = create<State>((set) => ({
  filesExpanded: true,
  gitExpanded: false,
  sizes: readSizes(),
  toggle: (section) =>
    set((s) =>
      section === "files"
        ? { filesExpanded: !s.filesExpanded }
        : { gitExpanded: !s.gitExpanded },
    ),
  setSize: (id, percent) =>
    set((s) => {
      if (Math.abs((s.sizes[id] ?? 0) - percent) < 0.5) return s;
      const sizes = { ...s.sizes, [id]: percent };
      writeSizes(sizes);
      return { sizes };
    }),
}));

const SIZES_KEY = "terax.remotes.sectionSizes";

function readSizes(): Record<string, number> {
  const raw = sectionStorage.getItem(SIZES_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function writeSizes(sizes: Record<string, number>): void {
  sectionStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
}

