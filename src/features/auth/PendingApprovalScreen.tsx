import { Clock3 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Logo } from "../../components/Logo";
import { AUTH_TEXT } from "./auth.constants";
import { useAuth } from "./authStore";

/** Shown when a signed-in user has no assigned role yet (profiles.role is null). */
export function PendingApprovalScreen() {
  const signOut = useAuth((s) => s.signOut);

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6 text-center animate-fade-in-up">
        <Logo className="justify-center" />
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-amber-50">
          <Clock3 className="size-7 text-amber-500" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-extrabold text-slate-800">{AUTH_TEXT.pending.title}</h1>
          <p className="text-sm text-slate-500">{AUTH_TEXT.pending.hint}</p>
        </div>
        <Button variant="secondary" onClick={() => void signOut()}>
          {AUTH_TEXT.pending.signOut}
        </Button>
      </div>
    </div>
  );
}
