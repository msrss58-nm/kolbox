import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { LtrValue } from "./MultiEntityLtrValue";
import type { PasswordLinkState } from "./useMultiEntityManagement";

const text = PLATFORM_OWNER_TEXT.multiEntity.passwordLink;

/**
 * The one-time password-setting link, shown once, immediately after a
 * successful provision or replacement.
 *
 * D-14: this is a PASSWORD-SETTING link, never an "activation link". In Stage
 * 4B it does exactly one thing - lets the new holder choose a password - and
 * the copy says outright that runtime access to the workspaces is not active
 * yet. Calling it "activation" would promise access that Stage 5 has not built.
 *
 * The value lives in component memory for as long as this panel is mounted and
 * is never persisted, cached, logged, or put in the URL. Once dismissed it is
 * genuinely unrecoverable, and the hint says so rather than letting an
 * operator discover it by closing the panel.
 */
export function MultiEntityPasswordLinkPanel({
  value,
  onDismiss,
}: {
  value: PasswordLinkState;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    if (!value.link) return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(value.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Never a silent failure: the link stays visible and selectable, and the
      // operator is told to copy it by hand.
      setCopyFailed(true);
    }
  };

  return (
    <Card className="space-y-3 ring-1 ring-primary-200">
      <div className="flex items-center gap-2">
        <KeyRound className="size-5 text-primary-600" />
        <CardTitle>{text.title}</CardTitle>
      </div>

      {value.replaced && (
        <p className="text-sm font-semibold text-slate-700">{text.replacedNote}</p>
      )}

      {value.link ? (
        <>
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <LtrValue value={value.link} className="text-xs text-slate-800" />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void copy()}
            className="w-full sm:w-auto"
          >
            <Copy className="me-1 size-4" aria-hidden />
            {copied ? text.copied : text.copy}
          </Button>
          {copyFailed && (
            <p role="alert" className="text-sm font-medium text-opponent">
              {text.copyFailed}
            </p>
          )}
          <p className="text-xs text-slate-500">{text.hint}</p>
          <p className="text-xs font-semibold text-slate-600">{text.accessNote}</p>
        </>
      ) : (
        <p role="alert" className="text-sm text-opponent">
          {text.missing}
        </p>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
        {text.dismiss}
      </Button>
    </Card>
  );
}
