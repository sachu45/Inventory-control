import { Search } from '@/components/ui/icons';

type AppShellControlsProps = {
  onOpenSpotlight: () => void;
};

export function AppShellControls({ onOpenSpotlight }: AppShellControlsProps) {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

  return (
    <div className="flex items-center gap-2 sm:gap-3">

      <button
        type="button"
        onClick={onOpenSpotlight}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-input bg-accent text-primary sm:hidden"
        aria-label="Open jump menu"
      >
        <Search className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={onOpenSpotlight}
        className="group relative hidden h-10 min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-input bg-accent pl-3 pr-2 text-sm font-medium text-foreground transition hover:border-border hover:bg-accent sm:flex"
        aria-label="Open jump menu"
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="hidden max-w-[180px] truncate sm:inline">Search your workspace</span>
        <kbd className="ml-1 hidden rounded border border-input bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-primary lg:inline">
          {isMac ? '⌘' : 'Ctrl'}+K
        </kbd>
      </button>
    </div>
  );
}
