import { sessionName } from '@/webview/ActiveSession';
import { useSelector } from '@/webview/StoreContext';

/** The strip above the transcript naming the active session and its working directory, with a spinner while a turn runs. */
export function SessionBanner() {
  const session = useSelector((state) => state.activeSession);

  return (
    <div className={session ? 'session-banner visible' : 'session-banner'} id="sessionBanner">
      <span className="dot" />
      <div className="info">
        <div className="agent" id="bannerAgent">
          {session && sessionName(session)}
        </div>
        <div className="cwd" id="bannerCwd">
          {session?.cwd}
        </div>
      </div>
      <span className="status" id="status">
        {session?.turnRunning && <span className="spinner" />}
      </span>
    </div>
  );
}
