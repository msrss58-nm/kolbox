/** Hand-written types for the `profiles` table and Election Day's Supabase
 * schema - mirrors the migrations in `supabase/migrations/`. */
type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
          not_voting_reason_id: string | null;
          not_voting_reason_set_at: string | null;
          not_voting_reason_set_by: string | null;
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
          not_voting_reason_id?: string | null;
          not_voting_reason_set_at?: string | null;
          not_voting_reason_set_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["election_day_voters"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "election_day_voters_not_voting_reason_id_fkey";
            columns: ["not_voting_reason_id"];
            isOneToOne: false;
            referencedRelation: "election_day_not_voting_reasons";
            referencedColumns: ["id"];
          },
        ];
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
       * included here only for completeness. Phase 3: the legacy `role` text
       * column is gone - `role_id` is the only identity a row carries. */
      election_day_permission_users: {
        Row: {
          id: string;
          name: string;
          password_hash: string;
          role_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          password_hash: string;
          role_id: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_permission_users"]["Insert"]
        >;
        Relationships: [];
      };

      /** Dynamic Roles & Permissions (Phase 0). RLS-enabled, zero policies -
       * never queried directly by the client. All access goes through the
       * `election_day_list_roles` RPC below (Phase 1) - this Row type is
       * included only for completeness/future role-management RPCs. Phase 3:
       * the `legacy_role_key` migration-bookkeeping column is gone. */
      election_day_roles: {
        Row: {
          id: string;
          name: string;
          description: string;
          permissions: string[];
          scope_type: string;
          scope_value: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string;
          permissions?: string[];
          scope_type?: string;
          scope_value?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["election_day_roles"]["Insert"]>;
        Relationships: [];
      };

      /** Dynamic Non-Voting Reasons (Phase 0). RLS-enabled, zero policies -
       * never queried directly by the client. All access goes through the
       * `election_day_list_non_voting_reasons`/create/update/set_active/
       * delete/reorder RPCs below - this Row type is included only for
       * completeness. */
      election_day_not_voting_reasons: {
        Row: {
          id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          requires_follow_up: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string;
          is_active?: boolean;
          sort_order?: number;
          requires_follow_up?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_not_voting_reasons"]["Insert"]
        >;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      election_day_login: {
        Args: { p_name: string; p_password: string };
        Returns: { id: string; name: string; role_id: string }[];
      };
      /** Dynamic Roles & Permissions Phase 3: creates a PermissionUser
       * against an arbitrary role_id - the only creation path now that the
       * legacy 3-checkbox RPC has been dropped. */
      election_day_create_permission_user: {
        Args: { p_name: string; p_password: string; p_role_id: string };
        Returns: { id: string; name: string; role_id: string }[];
      };
      election_day_list_permission_users: {
        Args: Record<string, never>;
        Returns: { id: string; name: string; role_id: string }[];
      };
      election_day_delete_permission_user: {
        Args: { p_id: string };
        Returns: undefined;
      };
      /** Dynamic Roles & Permissions, Phase 2. Unlike Phase 0's migration-only
       * seed insert, this RPC accepts arbitrary caller-supplied permission
       * arrays - validated DB-side by `election_day_is_valid_permission`
       * (mirrors `ALL_PERMISSIONS`), rejecting (not silently dropping) an
       * unrecognized permission string. */
      election_day_create_role: {
        Args: {
          p_name: string;
          p_description: string | null;
          p_permissions: string[];
          p_scope_type: string;
        };
        Returns: {
          id: string;
          name: string;
          description: string;
          permissions: string[];
          scope_type: string;
          scope_value: Json | null;
        }[];
      };
      /** Dynamic Roles & Permissions, Phase 2. Raises `CANNOT_REMOVE_LAST_PERMISSION_HOLDER`
       * if removing `electionDay.manageRolesAndPermissions` from this role
       * would leave zero actually-assigned users anywhere holding it. */
      election_day_update_role: {
        Args: {
          p_role_id: string;
          p_name: string;
          p_description: string | null;
          p_permissions: string[];
          p_scope_type: string;
        };
        Returns: {
          id: string;
          name: string;
          description: string;
          permissions: string[];
          scope_type: string;
          scope_value: Json | null;
        }[];
      };
      /** Dynamic Roles & Permissions, Phase 2. Raises `ROLE_HAS_ASSIGNED_USERS`
       * if any user is currently assigned to this role, or
       * `CANNOT_REMOVE_LAST_PERMISSION_HOLDER` per the same guard as
       * `election_day_update_role`. */
      election_day_delete_role: {
        Args: { p_role_id: string };
        Returns: undefined;
      };
      election_day_clone_role: {
        Args: { p_role_id: string; p_new_name: string };
        Returns: {
          id: string;
          name: string;
          description: string;
          permissions: string[];
          scope_type: string;
          scope_value: Json | null;
        }[];
      };
      /** Dynamic Roles & Permissions, Phase 1. Returns raw, untrusted rows -
       * `SupabaseElectionDayApi.listElectionDayRoles()` runs every row
       * through `normalizeRoleRecord` before the app ever sees it (see
       * `permissions/roleRecordMapper.ts`), so `permissions`/`scope_type`
       * are intentionally left as loose `string[]`/`string` here rather
       * than the app's validated `Permission`/`RoleScopeType` types. */
      election_day_list_roles: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          name: string;
          description: string;
          permissions: string[];
          scope_type: string;
          scope_value: Json | null;
        }[];
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
      /** Dynamic Non-Voting Reasons: lists the full catalog (active and
       * inactive) ordered by sort_order. */
      election_day_list_non_voting_reasons: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          requires_follow_up: boolean;
        }[];
      };
      election_day_create_non_voting_reason: {
        Args: {
          p_name: string;
          p_description: string | null;
          p_requires_follow_up: boolean;
        };
        Returns: {
          id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          requires_follow_up: boolean;
        }[];
      };
      election_day_update_non_voting_reason: {
        Args: {
          p_id: string;
          p_name: string;
          p_description: string | null;
          p_requires_follow_up: boolean;
        };
        Returns: {
          id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          requires_follow_up: boolean;
        }[];
      };
      election_day_set_non_voting_reason_active: {
        Args: { p_id: string; p_is_active: boolean };
        Returns: {
          id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
        }[];
      };
      /** Raises `REASON_IN_USE` if any voter still references this reason. */
      election_day_delete_non_voting_reason: {
        Args: { p_id: string };
        Returns: undefined;
      };
      /** Raises `REORDER_ID_MISMATCH` unless given every existing reason id
       * exactly once. */
      election_day_reorder_non_voting_reasons: {
        Args: { p_ordered_ids: string[] };
        Returns: {
          id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
