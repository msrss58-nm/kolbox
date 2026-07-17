import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Logo, LogoMark } from "../../components/Logo";
import { ROUTES } from "../../constants/routes";
import { AUTH_TEXT, BRAND_HIGHLIGHTS } from "./auth.constants";
import { useAuth } from "./authStore";
import { EmailAuthPanel } from "./EmailAuthPanel";

export function LoginPage() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();

  // Redirects the moment a session lands (code verified, or a redirect
  // back into an already-open tab) - a genuine external-state sync, the
  // canonical case an effect is for.
  useEffect(() => {
    if (user) void navigate(ROUTES.dashboard, { replace: true });
  }, [user, navigate]);

  return (
    <div className="flex min-h-dvh">
      {/* Brand panel - desktop only */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-bl from-primary-950 via-primary-900 to-violet-950 p-10 lg:flex">
        <div className="absolute -start-32 -top-32 size-96 rounded-full bg-primary-500/20 blur-3xl" />
        <div className="absolute -bottom-40 -end-24 size-[28rem] rounded-full bg-violet-500/20 blur-3xl" />
        <Logo light className="relative" />
        <div className="relative space-y-6">
          <h1 className="max-w-md text-4xl font-black leading-tight text-white">
            {AUTH_TEXT.brandHeadline}
            <br />
            <span className="bg-gradient-to-l from-primary-300 to-violet-300 bg-clip-text text-transparent">
              {AUTH_TEXT.brandSubheadline}
            </span>
          </h1>
          <p className="max-w-sm text-primary-200/80">{AUTH_TEXT.brandBody}</p>
          <ul className="space-y-3 text-sm text-primary-100/90">
            {BRAND_HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-lg bg-white/10">
                  <Icon className="size-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-primary-300/60">
          © {new Date().getFullYear()} קולבוקס
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-surface p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex justify-center lg:hidden">
            <LogoMark className="size-14" />
          </div>

          <EmailAuthPanel />
        </div>
      </div>
    </div>
  );
}
