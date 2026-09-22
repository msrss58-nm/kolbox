import { Mail, MessageCircle } from "lucide-react";
import { whatsAppHref } from "../../lib/phone";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import {
  buildOwnerLoginDetailsMessage,
  ownerLoginDetailsMailtoHref,
  type OwnerLoginDetails,
} from "./ownerLoginDetailsMessage";

const text = PLATFORM_OWNER_TEXT.approveOwner.send;

/**
 * Hands the new Owner their login details, through the operator's OWN apps.
 *
 * These are plain links, not actions: WhatsApp opens `wa.me` with the message
 * prepared, e-mail opens the local mail client with `mailto:`. The system
 * sends nothing and claims no delivery - the same rule the Budget order-form
 * hand-off already follows, and the hint says so on screen.
 *
 * Rendered only once an approval has actually produced a link, so there is
 * never a half-filled message to send.
 */
export function OwnerLoginDetailsActions({
  details,
  phone,
  email,
}: {
  details: OwnerLoginDetails;
  /** The approved contact number, already normalized. Required at approval
   * time, so it is a string here rather than a nullable. */
  phone: string;
  email: string;
}) {
  const message = buildOwnerLoginDetailsMessage(details);

  return (
    <div className="space-y-2" data-testid="owner-login-details-send">
      <p className="text-xs font-semibold text-slate-700">{text.label}</p>
      <div className="flex flex-wrap gap-2">
        {/* noreferrer: the activation link is in this href, and a Referer
            must never carry it to whatever opens next. */}
        <a
          href={whatsAppHref(phone, message)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="send-whatsapp"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-supporter px-3 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-primary-500"
        >
          <MessageCircle className="size-4" aria-hidden />
          {text.whatsapp}
        </a>
        <a
          href={ownerLoginDetailsMailtoHref(email, text.emailSubject, message)}
          data-testid="send-email"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary-700 ring-1 ring-slate-200 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-primary-500"
        >
          <Mail className="size-4" aria-hidden />
          {text.email}
        </a>
      </div>
      <p className="text-xs text-slate-500">{text.hint}</p>
    </div>
  );
}
