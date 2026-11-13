import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  isAxiosError,
  unlockGuestLink,
  type GuestLinkSession,
} from "../../api";

const storageKey = (shareId: string) => `excalidash-guest-link:${shareId}`;

const readSession = (
  shareId: string,
  drawingId: string,
): GuestLinkSession | null => {
  try {
    const stored = JSON.parse(
      localStorage.getItem(storageKey(shareId)) || "null",
    ) as GuestLinkSession | null;
    if (
      stored?.drawingId === drawingId &&
      typeof stored.session === "string" &&
      Date.parse(stored.expiresAt) > Date.now()
    )
      return stored;
  } catch {
    // A blocked storage API still allows using the link in this tab.
  }
  return null;
};

export const GuestLinkGate = ({
  drawingId,
  shareId,
  token,
  children,
}: {
  drawingId: string;
  shareId: string;
  token: string;
  children: (session: string, onAccessEnded: () => void) => ReactNode;
}) => {
  const [session, setSession] = useState(() => readSession(shareId, drawingId));
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [accessEnded, setAccessEnded] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  const open = useCallback(
    async (password?: string, isCancelled: () => boolean = () => false) => {
      if (!token) {
        setError("Open the original guest link to access this drawing.");
        return;
      }
      setError("");
      setAccessEnded(false);
      setIsPending(true);
      try {
        const result = await unlockGuestLink(shareId, token, password);
        if (isCancelled()) return;
        if (result.drawingId !== drawingId) {
          setError("This guest link is unavailable.");
          return;
        }
        try {
          localStorage.setItem(storageKey(shareId), JSON.stringify(result));
        } catch {
          // In private browsing the session can still be used in memory.
        }
        setPassphrase("");
        setPasswordRequired(false);
        setSession(result);
      } catch (cause) {
        if (isCancelled()) return;
        const response = isAxiosError(cause) ? cause.response : undefined;
        const code = response?.data?.code;
        if (
          code === "GUEST_PASSWORD_REQUIRED" ||
          code === "GUEST_PASSWORD_INVALID"
        ) {
          setPasswordRequired(true);
          if (code === "GUEST_PASSWORD_INVALID")
            setError("Incorrect password.");
        } else if (response?.status === 429) {
          setError("Too many attempts. Wait a moment and try again.");
        } else if (response?.status === 404) {
          setPasswordRequired(false);
          setError("This guest link has expired, been revoked, or is invalid.");
        } else {
          setError("Could not open the guest link. Try again.");
        }
      } finally {
        if (!isCancelled()) setIsPending(false);
      }
    },
    [drawingId, shareId, token],
  );

  const endAccess = useCallback(() => {
    try {
      const key = storageKey(shareId);
      // A different tab may already have renewed this session.
      if (localStorage.getItem(key) === JSON.stringify(session)) {
        localStorage.removeItem(key);
      }
    } catch {
      // No stored session to clear.
    }
    setSession(null);
    setAccessEnded(true);
    setPasswordRequired(false);
    setError("Your access to this drawing has ended.");
  }, [session, shareId]);

  useEffect(() => {
    if (session || accessEnded) return;
    let cancelled = false;
    const pending = window.setTimeout(
      () => void open(undefined, () => cancelled),
      0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(pending);
    };
  }, [accessEnded, open, session]);

  useEffect(() => {
    if (!session) return;
    let timer: number;
    const checkExpiry = () => {
      const remaining = Date.parse(session.expiresAt) - Date.now();
      if (remaining <= 0) endAccess();
      else
        timer = window.setTimeout(
          checkExpiry,
          Math.min(remaining, 2_147_483_647),
        );
    };
    checkExpiry();
    return () => window.clearTimeout(timer);
  }, [endAccess, session]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void open(passphrase);
  };

  if (session) return children(session.session, endAccess);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-4 dark:bg-neutral-950">
      <section className="ui-popover w-full max-w-sm space-y-4 p-6">
        <h1 className="text-lg font-semibold">
          {passwordRequired ? "Password required" : "Open guest link"}
        </h1>
        {error && (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}
        {passwordRequired ? (
          <form className="space-y-3" onSubmit={submit}>
            <label className="block space-y-1 text-sm">
              <span>Guest link password</span>
              <input
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
                autoComplete="off"
                type="password"
                required
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="ui-button-primary px-3 py-2"
              disabled={isPending}
            >
              Open drawing
            </button>
          </form>
        ) : isPending || !error ? (
          <p role="status" className="text-sm">
            Opening drawing…
          </p>
        ) : token ? (
          <button
            type="button"
            className="ui-button-secondary px-3 py-2"
            onClick={() => void open()}
          >
            {accessEnded ? "Reopen guest link" : "Try again"}
          </button>
        ) : null}
      </section>
    </main>
  );
};
