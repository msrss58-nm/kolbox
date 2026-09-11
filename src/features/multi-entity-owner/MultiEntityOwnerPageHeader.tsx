import { LogOut } from "lucide-react";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

const text = MULTI_ENTITY_OWNER_TEXT.home;

/** Platform Stage 7: the shared top bar of the authenticated Multi-Entity
 * pages - the server-verified identity and the (global) logout. */
export function MultiEntityOwnerPageHeader() {
  const context = useMultiEntityOwnerSession((s) => s.context);
  const logout = useMultiEntityOwnerSession((s) => s.logout);
  const loggingOut = useMultiEntityOwnerSession((s) => s.loggingOut);
  if (!context) return null;
  return (
    <header className="border-b border-slate-100 bg-white">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 md:px-6">
        <LogoMark className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-slate-800">
            {text.signedInAs(context.name)}
          </p>
          <p dir="ltr" className="truncate text-end text-xs text-slate-500">
            {context.email}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void logout()}
          loading={loggingOut}
          className="shrink-0"
          aria-label={text.logout}
        >
          <LogOut className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{text.logout}</span>
        </Button>
      </div>
    </header>
  );
}
