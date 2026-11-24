import { useEffect, useState } from "react";
import * as api from "../../api";

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("de", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export function CodexAccessSection({ drawingId }: { drawingId: string }) {
  const [access, setAccess] = useState<api.CodexBoardAccess | null>(null);
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api.getCodexBoardAccess(drawingId, controller.signal).then(
      (data) => {
        setAccess(data);
        if (data.agent && data.grant) setMode(data.grant.mode);
      },
      (err: unknown) => {
        if (
          !controller.signal.aborted &&
          (!api.isAxiosError(err) || err.response?.status !== 404)
        )
          setError("Codex-Freigabe konnte nicht geladen werden.");
      },
    );
    return () => controller.abort();
  }, [drawingId]);

  const change = async (revoke: boolean) => {
    setBusy(true);
    setError("");
    try {
      setAccess(
        await (revoke
          ? api.revokeCodexBoardAccess(drawingId)
          : api.grantCodexBoardAccess(drawingId, mode, minutes)),
      );
    } catch {
      setError("Die Codex-Freigabe konnte nicht geändert werden.");
    } finally {
      setBusy(false);
    }
  };

  if (!access?.agent)
    return error ? (
      <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
        {error}
      </p>
    ) : null;

  return (
    <section
      aria-label="Codex-Freigabe"
      className="space-y-2 border-t border-black/10 pt-4 dark:border-white/10"
    >
      <h3 className="text-sm font-semibold">{access.agent}</h3>
      <p className="text-xs text-slate-600 dark:text-slate-400" role="status">
        {access.grant
          ? `${access.grant.mode === "edit" ? "Bearbeiten" : "Lesen"} bis ${dateTime(access.grant.expiresAt)}`
          : "Keine aktive Freigabe"}
      </p>
      {access.lastEditAt && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Zuletzt bearbeitet von {access.agent} am {dateTime(access.lastEditAt)}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void change(false);
        }}
      >
        <fieldset disabled={busy} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            Zugriff
            <select
              className="ui-input text-sm"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value === "edit" ? "edit" : "read")
              }
            >
              <option value="read">Lesen</option>
              <option value="edit">Bearbeiten</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Laufzeit
            <select
              className="ui-input text-sm"
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            >
              <option value={30}>30 Minuten</option>
              <option value={60}>1 Stunde</option>
              <option value={240}>4 Stunden</option>
              <option value={1440}>24 Stunden</option>
            </select>
          </label>
          <button type="submit" className="ui-button-primary px-3 py-2 text-xs">
            {access.grant ? "Freigabe ändern" : "Für Codex freigeben"}
          </button>
          {access.grant && (
            <button
              type="button"
              className="ui-button-secondary px-3 py-2 text-xs"
              onClick={() => void change(true)}
            >
              Widerrufen
            </button>
          )}
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </section>
  );
}
