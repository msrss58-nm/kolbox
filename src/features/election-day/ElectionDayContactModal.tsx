import { Phone } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { telHref, whatsAppHref } from "../../lib/phone";
import { cn } from "../../lib/utils";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347z" />
      <path d="M12.05 21.75c-1.987 0-3.936-.535-5.639-1.548l-.404-.24-4.194 1.1 1.12-4.09-.264-.42a9.71 9.71 0 01-1.49-5.19c0-5.37 4.377-9.75 9.755-9.75 2.606 0 5.055 1.017 6.898 2.863a9.679 9.679 0 012.856 6.888c0 5.372-4.376 9.75-9.755 9.75zm0-20.75C5.955 1 1 5.943 1 12.01c0 2.02.545 3.912 1.49 5.55L1 23l5.6-1.467a11.01 11.01 0 005.45 1.417h.005c6.046 0 11-4.943 11-11.01C23.055 5.943 18.1 1 12.05 1z" />
    </svg>
  );
}

export function ElectionDayContactModal({
  contact,
  onClose,
  onToggleRideArranged,
}: {
  contact: ElectionDayVoter | null;
  onClose: () => void;
  onToggleRideArranged: (contact: ElectionDayVoter, arranged: boolean) => void;
}) {
  const fullName = contact ? `${contact.firstName} ${contact.lastName}` : "";
  const address = contact
    ? [contact.street, contact.houseNumber || ""].filter(Boolean).join(" ")
    : "";

  return (
    <Modal open={contact !== null} onClose={onClose} title={fullName}>
      {contact && (
        <div className="space-y-5">
          {(contact.city || address) && (
            <div>
              <p className="text-xs font-semibold text-slate-400">
                {ELECTION_DAY_TEXT.list.columns.address}
              </p>
              <p className="text-sm font-semibold text-slate-700">
                {[contact.city, address].filter(Boolean).join(" · ")}
              </p>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-slate-400">
              {ELECTION_DAY_TEXT.coordinatorFilter.label}
            </p>
            <p className="text-sm font-semibold text-slate-700">{contact.coordinator}</p>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-400">
              {ELECTION_DAY_TEXT.list.columns.phone}
            </p>
            <p className="text-sm font-semibold tabular-nums text-slate-700" dir="ltr">
              {contact.phone}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Button
              className="w-full"
              variant="primary"
              onClick={() => {
                window.location.href = telHref(contact.phone);
              }}
            >
              <Phone className="size-4" />
              {ELECTION_DAY_TEXT.modal.call}
            </Button>
            <Button
              className="w-full bg-[#25D366] text-white hover:bg-[#1ebe57] active:bg-[#1aa64d]"
              onClick={() => {
                window.open(
                  whatsAppHref(
                    contact.phone,
                    ELECTION_DAY_TEXT.modal.whatsappMessage(fullName),
                  ),
                  "_blank",
                  "noreferrer",
                );
              }}
            >
              <WhatsAppIcon className="size-4" />
              {ELECTION_DAY_TEXT.modal.whatsapp}
            </Button>
          </div>

          <Button
            variant={contact.rideArranged ? "secondary" : "primary"}
            className={cn("w-full", contact.rideArranged && "text-slate-600")}
            onClick={() => onToggleRideArranged(contact, !contact.rideArranged)}
          >
            {contact.rideArranged
              ? ELECTION_DAY_TEXT.modal.markNotArranged
              : ELECTION_DAY_TEXT.modal.markArranged}
          </Button>
        </div>
      )}
    </Modal>
  );
}
