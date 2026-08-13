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
          coordinator: string | null;
          notes: string;
          ride_requested: boolean;
          ride_requested_at: string | null;
          ride_arranged: boolean;
          ride_arranged_at: string | null;
          ride_completed: boolean;
          ride_completed_at: string | null;
          reminder_at: string | null;
          reminder_closed_at: string | null;
          reminder_closed_reason: string | null;
          reminder_closed_by: string | null;
          voted: boolean;
          voted_at: string | null;
          not_voting_reason_id: string | null;
          not_voting_reason_set_at: string | null;
          not_voting_reason_set_by: string | null;
          call_attempts: number;
          call_attempts_threshold: number;
          last_call_attempt_at: string | null;
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
          coordinator?: string | null;
          notes?: string;
          ride_requested?: boolean;
          ride_requested_at?: string | null;
          ride_arranged?: boolean;
          ride_arranged_at?: string | null;
          ride_completed?: boolean;
          ride_completed_at?: string | null;
          reminder_at?: string | null;
          reminder_closed_at?: string | null;
          reminder_closed_reason?: string | null;
          reminder_closed_by?: string | null;
          voted?: boolean;
          voted_at?: string | null;
          not_voting_reason_id?: string | null;
          not_voting_reason_set_at?: string | null;
          not_voting_reason_set_by?: string | null;
          call_attempts?: number;
          call_attempts_threshold?: number;
          last_call_attempt_at?: string | null;
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

      /** Reminder Lifecycle v1: audit log of every reminder create/close/
       * cancel/reschedule on an `election_day_voters` row - written only by
       * the `election_day_set_reminder`/`close_reminder`/`cancel_reminder`/
       * `set_voted`/`set_non_voting_reason` RPCs below, never by a direct
       * client insert. Denormalizes contact_name/coordinator like
       * `election_day_ride_status_events` so the log reads correctly even if
       * the contact is later removed by a re-import. */
      election_day_reminder_events: {
        Row: {
          id: string;
          contact_id: string | null;
          contact_name: string;
          coordinator: string;
          event_type: string;
          reminder_at: string | null;
          reason: string | null;
          actor_name: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          contact_id?: string | null;
          contact_name: string;
          coordinator: string;
          event_type: string;
          reminder_at?: string | null;
          reason?: string | null;
          actor_name?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_reminder_events"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "election_day_reminder_events_contact_id_fkey";
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

      /** Coordinator Allocation Management (Phase 1). RLS-enabled with a
       * public SELECT policy (unlike election_day_permission_users/
       * election_day_roles) - a coordinator row carries no secret, so a
       * direct client SELECT is allowed; INSERT/UPDATE/DELETE have zero
       * client policies, all writes go through the SECURITY DEFINER RPCs
       * below (Phase 3). No FK from election_day_voters.coordinator to this
       * table's id, by design - linked_assignment_name is an explicit-only
       * manual bridge, never auto-matched. */
      election_day_coordinators: {
        Row: {
          id: string;
          display_name: string;
          status: string;
          linked_assignment_name: string | null;
          created_at: string;
          ended_at: string | null;
        };
        Insert: {
          id?: string;
          display_name: string;
          status?: string;
          linked_assignment_name?: string | null;
          created_at?: string;
          ended_at?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["election_day_coordinators"]["Insert"]
        >;
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
      /** Resets an existing PermissionUser's (p_target_user_id) password_hash
       * in place (id/name/role_id untouched) - but only after genuinely
       * re-authenticating the ACTING manager server-side: p_actor_password
       * is bcrypt-verified against the actor's (p_actor_id) own
       * password_hash, and the actor's role must hold
       * electionDay.manageUsers. Raises UNAUTHORIZED / FORBIDDEN /
       * USER_NOT_FOUND / INVALID_PASSWORD, in that priority order. Never
       * returns password_hash. Self-reset: pass p_target_user_id =
       * p_actor_id. */
      election_day_reset_permission_user_password: {
        Args: {
          p_actor_id: string;
          p_actor_password: string;
          p_target_user_id: string;
          p_new_password: string;
        };
        Returns: { id: string; name: string; role_id: string }[];
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
            coordinator: string | null;
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
      /** Call Attempts Counter: atomically increments call_attempts by 1 and
       * stamps last_call_attempt_at, but only while call_attempts <
       * call_attempts_threshold (server-side quota guard) - fired on every
       * call-button click. Returns the row unchanged (no error) once the
       * quota is already reached. */
      election_day_increment_call_attempts: {
        Args: { p_id: string };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Call Attempts Counter: atomically advances call_attempts_threshold
       * by 3, but only while call_attempts = call_attempts_threshold
       * (server-side guard against duplicate/concurrent extension). Fired
       * when the user chooses "keep trying" from the no-answer decision
       * dialog. Returns the row unchanged (no error) once already extended. */
      election_day_extend_call_attempts_threshold: {
        Args: { p_id: string };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Reminder Lifecycle v1: creates or reschedules a reminder. Atomic - if
       * one was already open, logs a 'rescheduled' event for it before
       * creating the new one. */
      election_day_set_reminder: {
        Args: { p_id: string; p_reminder_at: string; p_actor_name: string };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Reminder Lifecycle v1: explicit "mark handled" (reason='handled').
       * Idempotent no-op if no reminder is currently open. */
      election_day_close_reminder: {
        Args: { p_id: string; p_actor_name: string };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Reminder Lifecycle v1: explicit cancel (reason='cancelled').
       * Idempotent no-op if no reminder is currently open. */
      election_day_cancel_reminder: {
        Args: { p_id: string; p_actor_name: string };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Reminder Lifecycle v1: replaces the old plain-PATCH `setVoted`. Sets
       * voted/voted_at, and atomically closes any open reminder
       * (reason='voted') only when p_voted = true - un-voting never touches
       * reminder state. */
      election_day_set_voted: {
        Args: { p_id: string; p_voted: boolean; p_actor_name: string };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Reminder Lifecycle v1: replaces the old plain-PATCH
       * `setNonVotingReason`. Sets the reason fields, and atomically closes
       * any open reminder (reason='case_closed') only if the reason's
       * requires_follow_up = false; otherwise the reminder is untouched.
       * p_reason_id may be null (clears the reason); p_actor_name may be
       * null (no signed-in session), mirroring `not_voting_reason_set_by`'s
       * existing nullability. */
      election_day_set_non_voting_reason: {
        Args: { p_id: string; p_reason_id: string | null; p_actor_name: string | null };
        Returns: Database["public"]["Tables"]["election_day_voters"]["Row"][];
      };
      /** Coordinator Allocation Management, Phase 3. Atomic batch of
       * add/edit/remove/link/unlink/relink actions - re-authenticates the
       * actor (bcrypt) and requires electionDay.manageCoordinatorAllocation,
       * mirroring election_day_reset_permission_user_password's pattern.
       * p_actions is a jsonb array of
       * {action, coordinator_id?, display_name?, linked_assignment_name?}
       * (see the migration for the exact per-action shape). Returns the full
       * current coordinator roster. Raises UNAUTHORIZED / FORBIDDEN /
       * NO_ACTIONS / INVALID_COORDINATOR_NAME / COORDINATOR_NOT_FOUND /
       * DISPLAY_NAME_LOCKED / COORDINATOR_LOCKED /
       * COORDINATOR_NAME_COLLISION / INVALID_LINK /
       * ASSIGNMENT_ALREADY_LINKED / INVALID_ACTION. */
      election_day_manage_coordinators: {
        Args: { p_actor_id: string; p_actor_password: string; p_actions: Json };
        Returns: Database["public"]["Tables"]["election_day_coordinators"]["Row"][];
      };
      /** Coordinator Allocation Management, Phase 3. One-time distribution of
       * every currently-unassigned voter (coordinator IS NULL) across the
       * given active coordinators, by quantity only - the server chooses
       * which voters (created_at/id ascending), never the client.
       * p_assignments is a jsonb array of {coordinator_id, quantity}. Raises
       * UNAUTHORIZED / FORBIDDEN / INVALID_ASSIGNMENT_SHAPE /
       * NEGATIVE_QUANTITY / DUPLICATE_COORDINATOR_IN_ASSIGNMENTS /
       * NO_MEANINGFUL_ASSIGNMENT / COORDINATOR_NOT_FOUND /
       * COORDINATOR_NOT_ACTIVE / NO_UNASSIGNED_VOTERS /
       * ALLOCATION_COUNT_MISMATCH. remaining_unassigned_count in the return
       * row is always 0 by construction (every locked unassigned voter is
       * allocated on success). */
      election_day_apply_initial_allocation: {
        Args: { p_actor_id: string; p_actor_password: string; p_assignments: Json };
        Returns: {
          operation_id: string;
          allocated_count: number;
          remaining_unassigned_count: number;
        }[];
      };
      /** Coordinator Allocation Management, Phase 3. Mid-day transfer of
       * "remaining" voters (election_day_voter_is_remaining - mirrors
       * resolveFollowUpStatus's "remaining" branch) from source coordinators
       * to destination coordinators, by quantity only. p_sources/
       * p_destinations are jsonb arrays of {coordinator_id, quantity}.
       * SUM(sources) must equal SUM(destinations); a coordinator cannot be
       * both a source and a destination in the same call. Raises
       * UNAUTHORIZED / FORBIDDEN / INVALID_ASSIGNMENT_SHAPE /
       * NON_POSITIVE_QUANTITY / DUPLICATE_COORDINATOR_IN_SOURCES /
       * DUPLICATE_COORDINATOR_IN_DESTINATIONS / SOURCE_DESTINATION_OVERLAP /
       * REBALANCE_SUM_MISMATCH / COORDINATOR_NOT_FOUND /
       * COORDINATOR_NOT_ACTIVE / REBALANCE_SOURCE_INSUFFICIENT. */
      election_day_rebalance_assignments: {
        Args: {
          p_actor_id: string;
          p_actor_password: string;
          p_sources: Json;
          p_destinations: Json;
        };
        Returns: { operation_id: string; transferred_count: number }[];
      };
      /** Coordinator Allocation Management, Phase 3. Ends one active
       * coordinator's activity - mode='transfer' moves every "remaining"
       * voter to one required active non-self p_target_coordinator_id;
       * mode='equal_split' splits them evenly across every other active
       * coordinator (p_target_coordinator_id ignored). Always marks the
       * source status='ended' on success (never deleted) and always writes
       * an operation row naming it as subject, even with 0 items moved.
       * Raises UNAUTHORIZED / FORBIDDEN / INVALID_MODE / INVALID_TARGET /
       * COORDINATOR_NOT_FOUND / COORDINATOR_NOT_ACTIVE / TARGET_NOT_FOUND /
       * TARGET_NOT_ACTIVE / LAST_ACTIVE_COORDINATOR. */
      election_day_end_coordinator_activity: {
        Args: {
          p_actor_id: string;
          p_actor_password: string;
          p_coordinator_id: string;
          p_mode: string;
          p_target_coordinator_id: string | null;
        };
        Returns: {
          operation_id: string;
          transferred_count: number;
          ended_coordinator_id: string;
          ended_coordinator_display_name: string;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
