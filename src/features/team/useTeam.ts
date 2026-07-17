import { useCallback } from "react";
import { useAsyncData } from "../../hooks/useAsyncData";
import { supabase } from "../../services/supabase/client";
import type { UserRole } from "../../types";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole | null;
  phone: string | null;
  area: string | null;
  joinedAt: string;
}

export function useTeam() {
  const fetchTeam = useCallback(async (): Promise<TeamMember[]> => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("role", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return data.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      phone: p.phone,
      area: p.area,
      joinedAt: p.joined_at,
    }));
  }, []);

  const { data: members, reload } = useAsyncData(fetchTeam);
  return { members, reload };
}
