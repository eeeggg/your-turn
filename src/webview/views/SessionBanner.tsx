import { sessionName } from '@/webview/state/ActiveSession';
import { useSelector } from '@/webview/views/StoreContext';

/** The strip above the transcript naming the active session and its working directory, with a spinner while a turn runs. */
export function SessionBanner() {
  const session = useSelector((state) => state.activeSession);

  return (
    <div
      className={`session-banner ${session ? 'visible flex' : 'hidden'} items-center gap-2 border-b border-border bg-muted px-3 py-2.5 text-md`}
      id="sessionBanner"
    >
      <span className="dot size-2 flex-none rounded-full bg-success" />
      <div className="info flex-1">
        <div className="agent font-semibold" id="bannerAgent">
          {session && sessionName(session)}
        </div>
        <div className="cwd mt-px text-sm text-muted-foreground" id="bannerCwd">
          {session?.cwd}
        </div>
      </div>
      <span className="status flex-none text-sm opacity-70" id="status">
        {session?.turnRunning && (
          <span className="spinner inline-block size-3.5 animate-spin rounded-full border-2 border-foreground border-t-transparent opacity-60" />
        )}
      </span>
    </div>
  );
}
