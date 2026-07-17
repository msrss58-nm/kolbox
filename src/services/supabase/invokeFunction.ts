import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./client";

/**
 * Calls a Supabase Edge Function and surfaces *its own* `{ error }` JSON
 * message on failure - `functions.invoke()` alone only gives a generic
 * "non-2xx status code" message, not the actual reason our functions send.
 */
export async function invokeFunction<T>(name: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body as Record<string, unknown>,
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const parsed: { error?: string } | null = await error.context
        .json()
        .catch(() => null);
      throw new Error(parsed?.error ?? error.message);
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("תגובה ריקה מהשרת");
  return data;
}
