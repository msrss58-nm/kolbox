import { invokeFunction } from "../../services/supabase/invokeFunction";

export interface InviteActivistInput {
  email: string;
  name: string;
  phone?: string;
  area?: string;
}

/** Calls the `create-user` Edge Function to add an activist (manager-only). */
export async function inviteActivistByEmail(input: InviteActivistInput): Promise<string> {
  const { userId } = await invokeFunction<{ userId: string }>("create-user", {
    ...input,
    role: "activist",
  });
  return userId;
}
