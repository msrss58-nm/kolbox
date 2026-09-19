import type { ReactNode } from "react";
import { Logo, LogoMark } from "./Logo";
import { BRAND_HIGHLIGHTS, BRAND_PANEL_TEXT } from "../constants/brand";

/**
 * The KOLBOX sign-in shell: the split-screen layout with the branded
 * purple/violet panel beside a white form area.
 *
 * Extracted verbatim from the original main-app login page so that the
 * dedicated Auth / IdP origin's entry screen and that page render ONE
 * implementation of this design rather than two approximations of it. The
 * caller supplies only the form; every branded element - gradient, blur
 * ornaments, wordmark, headline, highlights, footer - lives here.
 *
 * Responsive behaviour is the approved original's: below `lg` the brand panel
 * is dropped entirely and the form area carries a centred logo mark instead,
 * so a phone gets a full-width form with no clipped gradient. RTL is inherited
 * from `<html dir="rtl">` and expressed only through logical properties
 * (`-start-*` / `-end-*`), never physical ones.
 *
 * CSP-safe by construction: no inline `style`, no background-image URL, no
 * webfont, no remote asset. `LogoMark` is an inline <svg>, and every colour and
 * gradient is a Tailwind utility compiled into the stylesheet - so this renders
 * unchanged under the Auth origin's `default-src 'none'` policy.
 */
export function AuthBrandLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      {/* Brand panel - desktop only */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-bl from-primary-950 via-primary-900 to-violet-950 p-10 lg:flex">
        <div className="absolute -start-32 -top-32 size-96 rounded-full bg-primary-500/20 blur-3xl" />
        <div className="absolute -bottom-40 -end-24 size-[28rem] rounded-full bg-violet-500/20 blur-3xl" />
        <Logo light className="relative" />
        <div className="relative space-y-6">
          <h1 className="max-w-md text-4xl font-black leading-tight text-white">
            {BRAND_PANEL_TEXT.headline}
            <br />
            <span className="bg-gradient-to-l from-primary-300 to-violet-300 bg-clip-text text-transparent">
              {BRAND_PANEL_TEXT.subheadline}
            </span>
          </h1>
          <p className="max-w-sm text-primary-200/80">{BRAND_PANEL_TEXT.body}</p>
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

          {children}
        </div>
      </div>
    </div>
  );
}
