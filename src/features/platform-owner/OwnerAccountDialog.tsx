import { useCallback, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAsyncData } from "../../hooks/useAsyncData";
import { KOLBOX_ORIGIN_URLS } from "../../app/origins";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import {
  PLATFORM_OWNER_TEXT,
  platformOwnerAccountError,
} from "./platform-owner.constants";
import { LtrValue } from "./MultiEntityLtrValue";
import {
  fetchOwnerAccount,
  setOwnerPassword,
  setOwnerProfile,
  setOwnerUsername,
  type OwnerAccount,
} from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.ownerAccount;

/** THE address an Election Owner signs in at. Taken from the hard-coded origin
 * map, never derived from a link or the address bar, and never a new route:
 * this is the same shared login every other principal uses. */
const OWNER_LOGIN_URL = KOLBOX_ORIGIN_URLS.sharedLogin;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
      <h3 className="text-xs font-bold text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * ONE Election Owner's account, opened from their system's details.
 *
 * It edits the OWNER, never the system: no workspace field, no module, no
 * assignment and no ownership change is reachable from here. Which Owner is
 * decided by the workspace id alone - there is exactly one per workspace - and
 * the server re-resolves them on every call, so nothing about the identity
 * being acted on comes from this component.
 *
 * Name, e-mail and phone are edited through `platform_update_election_owner`,
 * which writes those three columns and no others - ownership, the workspace
 * and its modules are not reachable from this dialog at all. Every change it
 * makes, and every username or password change below, is recorded.
 *
 * The password field only ever SETS a new password. An existing one is not
 * retrievable - the auth provider stores a hash - so there is nothing here to
 * reveal, and the field starts empty on every open.
 */
export function OwnerAccountDialog({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const token = useCallback(async () => {
    const { data } = await platformOwnerAuthClient.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const load = useCallback(async (): Promise<OwnerAccount | null> => {
    const t = await token();
    if (!t) return null;
    const res = await fetchOwnerAccount(t, workspaceId);
    if (res.status !== "ok")
      throw new Error(
        platformOwnerAccountError(res.status === "error" ? res.code : "UNAUTHORIZED"),
      );
    return res.data;
  }, [token, workspaceId]);

  const account = useAsyncData(load);

  const [profile, setProfile] = useState({ name: "", email: "", phone: "" });
  const [profileBase, setProfileBase] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const [username, setUsername] = useState("");
  const [usernameBase, setUsernameBase] = useState<string | null>(null);
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSaved, setUsernameSaved] = useState(false);

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  const [copied, setCopied] = useState(false);

  // Render-phase compare, not an effect (CLAUDE.md): seed the field once from
  // whatever the server said, and re-seed if the underlying value changes.
  const loaded = account.data?.username ?? null;
  if (account.data && usernameBase !== loaded) {
    setUsernameBase(loaded);
    setUsername(loaded ?? "");
  }
  const loadedProfile = account.data
    ? JSON.stringify([account.data.name, account.data.email, account.data.phone])
    : null;
  if (account.data && profileBase !== loadedProfile) {
    setProfileBase(loadedProfile);
    setProfile({
      name: account.data.name,
      email: account.data.email,
      phone: account.data.phone ?? "",
    });
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (profileBusy) return;
    setProfileBusy(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      const t = await token();
      if (!t) {
        setProfileError(platformOwnerAccountError("UNAUTHORIZED"));
        return;
      }
      const res = await setOwnerProfile(t, workspaceId, profile);
      if (res.status !== "ok") {
        setProfileError(
          platformOwnerAccountError(res.status === "error" ? res.code : "UNAUTHORIZED"),
        );
        return;
      }
      // The server hands back what it STORED, normalization included, so the
      // form shows that without a second read. Re-seeding from a refetch that
      // lands later would also overwrite whatever the operator typed in the
      // meantime - which is how a rejected edit could appear to have worked.
      const stored = {
        name: res.data.name,
        email: res.data.email,
        phone: res.data.phone ?? "",
      };
      setProfile(stored);
      setProfileBase(JSON.stringify([stored.name, stored.email, res.data.phone]));
      setProfileSaved(true);
    } finally {
      setProfileBusy(false);
    }
  };

  const saveUsername = async (event: FormEvent) => {
    event.preventDefault();
    const value = username.trim();
    if (usernameBusy || value === "") return;
    setUsernameBusy(true);
    setUsernameError(null);
    setUsernameSaved(false);
    try {
      const t = await token();
      if (!t) {
        setUsernameError(platformOwnerAccountError("UNAUTHORIZED"));
        return;
      }
      const res = await setOwnerUsername(t, workspaceId, value);
      if (res.status !== "ok") {
        setUsernameError(
          platformOwnerAccountError(res.status === "error" ? res.code : "UNAUTHORIZED"),
        );
        return;
      }
      setUsernameSaved(true);
      // Authoritative refetch - the saved value is whatever the server stored,
      // including its own trimming and normalization.
      await account.reload();
    } finally {
      setUsernameBusy(false);
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    setPasswordError(null);
    setPasswordSaved(false);
    // KOLBOX imposes no password policy: only "something was typed" is
    // checked here, and the auth provider decides the rest.
    if (password === "") {
      setPasswordError(text.passwordEmpty);
      return;
    }
    setPasswordBusy(true);
    try {
      const t = await token();
      if (!t) {
        setPasswordError(platformOwnerAccountError("UNAUTHORIZED"));
        return;
      }
      const res = await setOwnerPassword(t, workspaceId, password);
      if (res.status !== "ok") {
        setPasswordError(
          platformOwnerAccountError(res.status === "error" ? res.code : "UNAUTHORIZED"),
        );
        return;
      }
      // Cleared immediately: it has served its only purpose, and a password
      // left sitting in a field is a password on screen.
      setPassword("");
      setShowPassword(false);
      setPasswordSaved(true);
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={text.title(workspaceName)}>
      <div className="space-y-4" data-testid="owner-account-dialog">
        {account.loading && !account.data && (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="w-2/3" />
            <Skeleton className="w-1/2" />
          </div>
        )}
        {account.error && (
          <p role="alert" className="text-sm font-medium text-opponent">
            {text.loadError}
          </p>
        )}

        {account.data && (
          <>
            <Section title={text.detailsTitle}>
              <form onSubmit={(e) => void saveProfile(e)} className="space-y-2">
                <Field label={text.nameLabel}>
                  <Input
                    value={profile.name}
                    onChange={(e) => {
                      setProfile((p) => ({ ...p, name: e.target.value }));
                      setProfileError(null);
                      setProfileSaved(false);
                    }}
                    name="owner-account-name"
                    autoComplete="off"
                  />
                </Field>
                <Field label={text.emailLabel}>
                  <Input
                    type="email"
                    dir="ltr"
                    value={profile.email}
                    onChange={(e) => {
                      setProfile((p) => ({ ...p, email: e.target.value }));
                      setProfileError(null);
                      setProfileSaved(false);
                    }}
                    name="owner-account-email"
                    autoComplete="off"
                  />
                </Field>
                <Field label={text.phoneLabel} error={profileError ?? undefined}>
                  <Input
                    dir="ltr"
                    value={profile.phone}
                    onChange={(e) => {
                      setProfile((p) => ({ ...p, phone: e.target.value }));
                      setProfileError(null);
                      setProfileSaved(false);
                    }}
                    name="owner-account-phone"
                    autoComplete="off"
                    placeholder={text.noPhone}
                    invalid={!!profileError}
                  />
                  <p className="mt-1 text-xs text-slate-400">{text.phoneHint}</p>
                </Field>
                {profileSaved && (
                  <p role="status" className="text-sm font-medium text-emerald-700">
                    {text.detailsSaved}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  loading={profileBusy}
                  disabled={profile.name.trim() === "" || profile.email.trim() === ""}
                  data-testid="owner-profile-save"
                >
                  {text.detailsSave}
                </Button>
              </form>
              <p className="text-xs text-slate-500">{text.detailsHint}</p>
            </Section>

            <Section title={text.usernameTitle}>
              <form onSubmit={(e) => void saveUsername(e)} className="space-y-2">
                <Field label={text.usernameLabel} error={usernameError ?? undefined}>
                  <Input
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setUsernameError(null);
                      setUsernameSaved(false);
                    }}
                    name="owner-account-username"
                    autoComplete="off"
                    placeholder={text.usernameUnset}
                    invalid={!!usernameError}
                  />
                  <p className="mt-1 text-xs text-slate-400">{text.usernameHint}</p>
                </Field>
                {usernameSaved && (
                  <p role="status" className="text-sm font-medium text-emerald-700">
                    {text.usernameSaved}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  loading={usernameBusy}
                  disabled={username.trim() === ""}
                  data-testid="owner-username-save"
                >
                  {text.usernameSave}
                </Button>
              </form>
            </Section>

            <Section title={text.passwordTitle}>
              <form onSubmit={(e) => void savePassword(e)} className="space-y-2">
                <Field label={text.passwordLabel} error={passwordError ?? undefined}>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setPasswordError(null);
                        setPasswordSaved(false);
                      }}
                      name="owner-account-new-password"
                      autoComplete="new-password"
                      invalid={!!passwordError}
                      className="pe-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? text.passwordHide : text.passwordShow}
                      className="touch-target absolute inset-y-0 end-1 grid place-items-center rounded-lg px-2 text-slate-400 hover:text-slate-600"
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" aria-hidden />
                      ) : (
                        <Eye className="size-4" aria-hidden />
                      )}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{text.passwordHint}</p>
                </Field>
                {passwordSaved && (
                  <p role="status" className="text-sm font-medium text-emerald-700">
                    {text.passwordSaved}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  loading={passwordBusy}
                  disabled={password === ""}
                  data-testid="owner-password-save"
                >
                  {text.passwordSave}
                </Button>
              </form>
            </Section>

            <Section title={text.loginTitle}>
              <LtrValue
                value={OWNER_LOGIN_URL}
                className="block rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200"
              />
              <p className="text-xs text-slate-500">{text.loginHint}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="owner-login-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(OWNER_LOGIN_URL);
                  setCopied(true);
                }}
              >
                {copied ? text.loginCopied : text.loginCopy}
              </Button>
            </Section>
          </>
        )}

        <div className="flex justify-end border-t border-slate-100 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {text.close}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
