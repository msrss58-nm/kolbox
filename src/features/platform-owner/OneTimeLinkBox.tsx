import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { LtrValue } from "./MultiEntityLtrValue";

const text = PLATFORM_OWNER_TEXT.oneTimeLink;

/**
 * A one-time link, shown in full (selectable) with a copy button. The value is
 * a credential: it lives only in the caller's component state and is never
 * persisted, cached or logged here. A denied clipboard is never a silent
 * failure - the operator is told to copy by hand.
 */
export function OneTimeLinkBox({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <LtrValue value={link} className="text-xs text-slate-800" />
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
    </div>
  );
}
