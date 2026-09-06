import { endpointIdFromCompatModel } from "@/modules/ai/config";
import type { usePreferencesStore } from "@/modules/settings/preferences";
import type { CompletionDeps } from "./provider";

type Prefs = ReturnType<typeof usePreferencesStore.getState>;

/**
 * Which model answers a completion, and how to reach it.
 *
 * The provider decides where the model id lives: a local runtime carries its
 * own, a custom endpoint hides one behind its id. Shared so the terminal asks
 * the same model the editor does rather than growing a second answer.
 */
export function resolveCompletionDeps(
  s: Prefs,
  apiKey: string | null,
): CompletionDeps {
  const p = s.autocompleteProvider;
  const compatEp =
    p === "openai-compatible"
      ? s.customEndpoints.find(
          (e) => e.id === endpointIdFromCompatModel(s.autocompleteModelId),
        )
      : undefined;

  const modelId =
    p === "lmstudio"
      ? s.lmstudioModelId
      : p === "mlx"
        ? s.mlxModelId
        : p === "ollama"
          ? s.ollamaModelId
          : p === "openai-compatible"
            ? (compatEp?.modelId ?? "")
            : p === "openrouter"
              ? s.openrouterModelId
              : s.autocompleteModelId;

  return {
    provider: p,
    modelId,
    apiKey,
    lmstudioBaseURL: s.lmstudioBaseURL,
    mlxBaseURL: s.mlxBaseURL,
    ollamaBaseURL: s.ollamaBaseURL,
    openaiCompatibleBaseURL: compatEp?.baseURL ?? s.openaiCompatibleBaseURL,
  };
}
