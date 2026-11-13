import { useState, type FormEvent } from "react";
import { Copy, KeyRound, Plus } from "lucide-react";
import {
  createLinkShare,
  updateLinkShare,
  revokeLinkShare,
  isAxiosError,
  type DrawingLinkShareRow,
  type LinkShareSettings,
} from "../../api";
import {
  calculateExpiresAt,
  EXPIRY_OPTIONS,
  formatAutoDisableText,
  toDatetimeLocalFromIso,
} from "./shareUtils";

type Props = {
  drawingId: string;
  shares: DrawingLinkShareRow[];
  onSharesChange: (shares: DrawingLinkShareRow[]) => void;
  disabled: boolean;
};

const guestLinkUrl = (drawingId: string, share: DrawingLinkShareRow) =>
  `${window.location.origin}/shared/${encodeURIComponent(drawingId)}/${encodeURIComponent(share.id)}#${share.token}`;

const generatePassphrase = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

const LinkSettingsForm = ({
  share,
  onSubmit,
  onCancel,
  disabled,
}: {
  share: DrawingLinkShareRow | null;
  onSubmit: (settings: Partial<LinkShareSettings>) => void;
  onCancel: () => void;
  disabled: boolean;
}) => {
  const [permission, setPermission] = useState(share?.permission ?? "view");
  const [expiry, setExpiry] = useState(share ? "existing" : "default");
  const [customExpiry, setCustomExpiry] = useState(
    toDatetimeLocalFromIso(share?.expiresAt ?? null),
  );
  const [protectedLink, setProtectedLink] = useState(
    share?.passwordProtected ?? false,
  );
  const [passphrase, setPassphrase] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [passwordCopied, setPasswordCopied] = useState(false);

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(passphrase);
      setPasswordCopied(true);
    } catch {
      setPasswordVisible(true);
      setError("Select and copy the password before saving.");
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expiresAt =
      expiry === "existing" || expiry === "default"
        ? undefined
        : calculateExpiresAt(expiry, customExpiry);
    if (
      expiry !== "existing" &&
      expiry !== "default" &&
      expiresAt === undefined
    ) {
      setError("Enter an expiration time at least one minute in the future.");
      return;
    }
    if (protectedLink && !share?.passwordProtected && !passphrase.trim()) {
      setError("Enter or generate a password for the link.");
      return;
    }
    setError("");
    onSubmit({
      ...(permission !== share?.permission && { permission }),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(protectedLink && passphrase && { passphrase }),
      ...(!protectedLink && share?.passwordProtected && { passphrase: null }),
    });
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-neutral-700"
    >
      <fieldset disabled={disabled} className="space-y-3">
        <label className="block space-y-1 text-xs font-semibold">
          <span>Permission</span>
          <select
            className={inputClass}
            value={permission}
            onChange={(event) =>
              setPermission(event.target.value as "view" | "edit")
            }
          >
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </select>
        </label>
        <label className="block space-y-1 text-xs font-semibold">
          <span>Expiration</span>
          <select
            className={inputClass}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          >
            {share ? (
              <option value="existing">Keep current expiration</option>
            ) : (
              <option value="default">Default expiration</option>
            )}
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {expiry === "custom" && (
          <label className="block space-y-1 text-xs font-semibold">
            <span>Expiration date and time</span>
            <input
              className={inputClass}
              type="datetime-local"
              value={customExpiry}
              onChange={(event) => setCustomExpiry(event.target.value)}
              required
            />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={protectedLink}
            onChange={(event) => setProtectedLink(event.target.checked)}
          />
          Require a password
        </label>
        {protectedLink && (
          <div className="space-y-1">
            <label className="block space-y-1 text-xs font-semibold">
              <span>
                {share?.passwordProtected
                  ? "New password (optional)"
                  : "Password"}
              </span>
              <input
                className={inputClass}
                type={passwordVisible ? "text" : "password"}
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => {
                  setPassphrase(event.target.value);
                  setPasswordCopied(false);
                }}
                required={!share?.passwordProtected}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                className="ui-button-secondary px-2 py-1 text-xs"
                type="button"
                onClick={() => {
                  setPassphrase(generatePassphrase());
                  setPasswordCopied(false);
                  setPasswordVisible(true);
                }}
              >
                Generate password
              </button>
              <button
                className="ui-button-secondary px-2 py-1 text-xs"
                type="button"
                onClick={() => setPasswordVisible(!passwordVisible)}
              >
                {passwordVisible ? "Hide password" : "Show password"}
              </button>
              {passphrase && (
                <button
                  className="ui-button-secondary px-2 py-1 text-xs"
                  type="button"
                  onClick={() => void copyPassword()}
                >
                  {passwordCopied ? "Password copied" : "Copy password"}
                </button>
              )}
            </div>
            {passphrase && (
              <p className="text-xs text-slate-500 dark:text-neutral-400">
                Save the password before closing this form.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="ui-button-primary px-3 py-1.5 text-xs"
            type="submit"
          >
            {share ? "Save changes" : "Create link"}
          </button>
          <button
            className="ui-button-secondary px-3 py-1.5 text-xs"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
};

export const GeneralAccessSection = ({
  drawingId,
  shares,
  onSharesChange,
  disabled,
}: Props) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [visibleLink, setVisibleLink] = useState<string | null>(null);

  const save = async (
    settings: Partial<LinkShareSettings>,
    share?: DrawingLinkShareRow,
  ) => {
    if (share && Object.keys(settings).length === 0) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = share
        ? await updateLinkShare(drawingId, share.id, settings)
        : await createLinkShare(drawingId, {
            ...settings,
            permission: settings.permission ?? "view",
          });
      onSharesChange(
        share
          ? shares.map((item) => (item.id === share.id ? result.share : item))
          : [result.share, ...shares],
      );
      setEditing(null);
      setCreating(false);
    } catch (cause) {
      const message = isAxiosError(cause)
        ? cause.response?.data?.message
        : null;
      setError(
        typeof message === "string"
          ? message
          : "Could not save the guest link.",
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (share: DrawingLinkShareRow) => {
    if (
      !window.confirm(
        "Revoke this guest link? Guests using it will lose access.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await revokeLinkShare(drawingId, share.id);
      onSharesChange(
        shares.map((item) =>
          item.id === share.id
            ? { ...item, revokedAt: new Date().toISOString(), token: null }
            : item,
        ),
      );
      setVisibleLink(null);
      setEditing(null);
    } catch {
      setError("Could not revoke the guest link.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (share: DrawingLinkShareRow) => {
    if (!share.token) return;
    const url = guestLinkUrl(drawingId, share);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(share.id);
      setVisibleLink(null);
    } catch {
      setVisibleLink(share.id);
    }
  };

  return (
    <section className="space-y-3 border-t-2 border-slate-100 pt-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Guest links</h3>
        <button
          className="ui-button-secondary px-2 py-1.5 text-xs"
          type="button"
          disabled={disabled || busy || creating}
          onClick={() => {
            setCreating(true);
            setEditing(null);
            setError("");
          }}
        >
          <Plus size={14} /> New guest link
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      {creating && (
        <LinkSettingsForm
          share={null}
          disabled={disabled || busy}
          onSubmit={(settings) => void save(settings)}
          onCancel={() => setCreating(false)}
        />
      )}
      {!shares.length && !creating && (
        <p className="text-sm text-slate-500 dark:text-neutral-400">
          No guest links yet.
        </p>
      )}
      {shares.length > 0 && (
        <ul className="space-y-2">
          {shares.map((share) => {
            const expired =
              share.expiresAt !== null &&
              Date.parse(share.expiresAt) <= Date.now();
            const canCopy = Boolean(
              share.token && !share.revokedAt && !expired,
            );
            return (
              <li
                className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-neutral-700"
                key={share.id}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <span>
                    {share.permission === "edit" ? "Can edit" : "Can view"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs font-normal text-slate-500 dark:text-neutral-400">
                    {share.passwordProtected && <KeyRound size={12} />}
                    {share.passwordProtected
                      ? "Password required"
                      : "Anyone with the link"}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-neutral-400">
                  {share.revokedAt
                    ? "Revoked"
                    : expired
                      ? "Expired"
                      : formatAutoDisableText(share.expiresAt)}
                </p>
                {visibleLink === share.id && canCopy && (
                  <input
                    className={inputClass}
                    aria-label="Guest link"
                    readOnly
                    value={guestLinkUrl(drawingId, share)}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                )}
                {!share.revokedAt && (
                  <div className="flex flex-wrap gap-2">
                    {canCopy && (
                      <button
                        className="ui-button-secondary px-2 py-1 text-xs"
                        type="button"
                        onClick={() => void copy(share)}
                      >
                        <Copy size={12} />{" "}
                        {copied === share.id ? "Copied" : "Copy link"}
                      </button>
                    )}
                    <button
                      className="ui-button-secondary px-2 py-1 text-xs"
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => {
                        setEditing(share.id);
                        setCreating(false);
                        setError("");
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="ui-button-secondary px-2 py-1 text-xs"
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => void revoke(share)}
                    >
                      Revoke
                    </button>
                  </div>
                )}
                {editing === share.id && (
                  <LinkSettingsForm
                    key={share.id}
                    share={share}
                    disabled={disabled || busy}
                    onSubmit={(settings) => void save(settings, share)}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
