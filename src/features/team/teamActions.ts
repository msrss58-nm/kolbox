import { supabase } from "../../services/supabase/client";
import { invokeFunction } from "../../services/supabase/invokeFunction";
import type { UserRole } from "../../types";

export interface CreateMemberInput {
  email: string;
  name: string;
  phone?: string;
  area?: string;
  role: UserRole;
}

/** Creates a new team member's account (manager-only, via `create-user`). */
export async function createTeamMember(input: CreateMemberInput): Promise<string> {
  const { userId } = await invokeFunction<{ userId: string }>("create-user", input);
  return userId;
}

/** Permanently removes a team member's account (manager-only, via `remove-user`). */
export async function removeTeamMember(userId: string): Promise<true> {
  await invokeFunction<{ success: true }>("remove-user", { userId });
  return true; // distinguishes success from useAsyncAction's `undefined`-on-error
}

export interface UpdateMemberPatch {
  name?: string;
  phone?: string | null;
  area?: string | null;
  role?: UserRole;
}

/** Edits name/phone/area/role directly - RLS already lets a manager update any profile. */
export async function updateTeamMember(userId: string, patch: UpdateMemberPatch): Promise<void> {
  const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (error) throw new Error(error.message);
}

/** How many managers currently exist - used to block removing the last one. */
export async function countManagers(): Promise<number> {
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "manager");
  if (error) throw new Error(error.message);
  return count ?? 0;
}
