/** Hand-written types for the `profiles` table - mirrors the migration in Supabase. */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: "manager" | "activist" | "observer" | null;
          name: string;
          email: string;
          phone: string | null;
          area: string | null;
          tag_count: number;
          joined_at: string;
          last_active_at: string;
        };
        Insert: {
          id: string;
          role?: "manager" | "activist" | "observer" | null;
          name: string;
          email?: string;
          phone?: string | null;
          area?: string | null;
          tag_count?: number;
          joined_at?: string;
          last_active_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
