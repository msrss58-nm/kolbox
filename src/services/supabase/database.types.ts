/** Hand-written types for the `profiles` table and Election Day's Supabase
 * schema - mirrors the migrations in `supabase/migrations/`. */
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

      election_day_voters: {
        Row: {
          id: string;
          masad: string;
          first_name: string;
          last_name: string;
          street: string;
          house_number: number;
          city: string;
          phone: string | null;
          coordinator: string;
          notes: string;
          ride_requested: boolean;
          ride_requested_at: string | null;
          ride_arranged: boolean;
          ride_arranged_at: string | null;
          ride_completed: boolean;
          ride_completed_at: string | null;
          reminder_at: string | null;
          voted: boolean;
          voted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          masad?: string;
          first_name: string;
          last_name: string;
          street?: string;
          house_number?: number;
          city?: string;
          phone?: string | null;
          coordinator: string;
          notes?: string;
          ride_requested?: boolean;
          ride_requested_at?: string | null;
          ride_arranged?: boolean;
          ride_arranged_at?: string | null;
          ride_completed?: boolean;
          ride_completed_at?: string | null;
          reminder_at?: string | null;
          voted?: boolean;
          voted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["election_day_voters"]["Insert"]>;
        Relationships: [];
      };

      election_day_ride_status_events: {
        Row: {
          id: string;
          contact_id: string | null;
          contact_name: string;
          coordinator: string;
          from_arranged: boolean;
          to_arranged: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          contact_id?: string | null;
          contact_name: string;
          coordinator: string;
          from_arranged: boolean;
          to_arranged: boolean;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_ride_status_events"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "election_day_ride_status_events_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "election_day_voters";
            referencedColumns: ["id"];
          },
        ];
      };

      election_day_ride_coordinators: {
        Row: {
          id: string;
          name: string;
          phone: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          phone: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_ride_coordinators"]["Insert"]
        >;
        Relationships: [];
      };

      election_day_settings: {
        Row: {
          id: boolean;
          deadline: string | null;
          updated_at: string;
        };
        Insert: {
          id?: boolean;
          deadline?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["election_day_settings"]["Insert"]>;
        Relationships: [];
      };

      /** RLS-enabled, zero policies - never queried directly by the client.
       * All access goes through the election_day_login /
       * election_day_create_permission_user / election_day_list_permission_users /
       * election_day_delete_permission_user RPC functions below. Row type
       * included here only for completeness. */
      election_day_permission_users: {
        Row: {
          id: string;
          name: string;
          password_hash: string;
          role: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          password_hash: string;
          role: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_permission_users"]["Insert"]
        >;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      election_day_login: {
        Args: { p_name: string; p_password: string };
        Returns: { id: string; name: string; role: string }[];
      };
      election_day_create_permission_user: {
        Args: { p_name: string; p_password: string; p_role: string };
        Returns: { id: string; name: string; role: string }[];
      };
      election_day_list_permission_users: {
        Args: Record<string, never>;
        Returns: { id: string; name: string; role: string }[];
      };
      election_day_delete_permission_user: {
        Args: { p_id: string };
        Returns: undefined;
      };
      election_day_import_voters: {
        Args: {
          p_voters: {
            masad: string;
            first_name: string;
            last_name: string;
            street: string;
            house_number: number;
            city: string;
            phone: string | null;
            coordinator: string;
          }[];
        };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
