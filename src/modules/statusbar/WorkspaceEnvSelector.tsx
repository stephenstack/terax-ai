import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import { useRemoteWorkspaceStore } from "@/modules/remotes";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { Refresh01Icon, ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
};

/**
 * Shown when there is something to switch between: WSL on Windows, or a remote
 * workspace on any platform. Elsewhere the environment is always local, and a
 * one-item picker would be noise.
 */
export function WorkspaceEnvSelector({ onSelect }: Props) {
  const remote = useRemoteWorkspaceStore((s) => s.active);
  if (!IS_WINDOWS && !remote) return null;
  return <WorkspaceEnvPicker onSelect={onSelect} />;
}

function WorkspaceEnvPicker({ onSelect }: Props) {
  const remote = useRemoteWorkspaceStore((s) => s.active);
  const closeRemote = useRemoteWorkspaceStore((s) => s.close);
  const env = useWorkspaceEnvStore((s) => s.env);
  const distros = useWorkspaceEnvStore((s) => s.distros);
  const loading = useWorkspaceEnvStore((s) => s.loading);
  const error = useWorkspaceEnvStore((s) => s.error);
  const refreshDistros = useWorkspaceEnvStore((s) => s.refreshDistros);

  const handleOpenChange = (open: boolean) => {
    if (open && IS_WINDOWS && distros.length === 0 && !loading) {
      void refreshDistros();
    }
  };

  const localLabel = IS_WINDOWS ? "Windows Local" : "Local";
  const label =
    env.kind === "ssh" && remote
      ? `${remote.user}@${remote.host}`
      : env.kind === "wsl"
        ? `WSL: ${env.distro}`
        : localLabel;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title="Workspace environment"
        >
          <HugeiconsIcon
            icon={ServerStack03Icon}
            size={13}
            strokeWidth={1.75}
          />
          <span className="max-w-28 truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuItem onSelect={() => onSelect(LOCAL_WORKSPACE)}>
          {localLabel}
        </DropdownMenuItem>
        {remote ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                onSelect({
                  kind: "ssh",
                  conn: remote.conn,
                  profileId: remote.profileId,
                })
              }
            >
              {remote.user}@{remote.host}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                // Leave the remote first so nothing keeps querying a
                // connection that is about to go away.
                onSelect(LOCAL_WORKSPACE);
                void closeRemote();
              }}
            >
              Disconnect remote workspace
            </DropdownMenuItem>
          </>
        ) : null}
        {!IS_WINDOWS ? null : (
        <>
        <DropdownMenuSeparator />
        {distros.length === 0 ? (
          <DropdownMenuItem disabled>
            {loading
              ? "Loading WSL distros..."
              : error
                ? "WSL unavailable"
                : "No WSL distros found"}
          </DropdownMenuItem>
        ) : (
          distros.map((distro) => (
            <DropdownMenuItem
              key={distro.name}
              onSelect={() => onSelect({ kind: "wsl", distro: distro.name })}
            >
              WSL: {distro.name}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void refreshDistros()}>
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
          Refresh
        </DropdownMenuItem>
        </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
