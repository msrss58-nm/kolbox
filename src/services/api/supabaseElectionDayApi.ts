import { supabase } from "../supabase/client";
import type {
  ElectionDayVoter,
  PermissionRole,
  PermissionUser,
  RideCoordinator,
  RideStatusEvent,
} from "../../types";
import type { NewElectionDayVoter, NewPermissionUser, NewRideCoordinator } from "./types";

/** A UUID that `gen_random_uuid()` will never produce - the standard
 * Supabase-community idiom for an unconditional "delete every row" via the
 * client (the JS client requires at least one filter on delete/update). */
const NEVER_MATCHES_ID = "00000000-0000-0000-0000-000000000000";

/** Throws on a Supabase error - use for delete/insert/void-RPC calls where
 * the response body isn't needed. Supabase returns `data: null` by default
 * for these when there's no `.select()` chained on - that's the normal
 * success shape, NOT a "not found" condition, so this deliberately never
 * looks at `data` at all. */
function checkError(result: { error: { message: string } | null }): void {
  if (result.error) throw new Error(result.error.message);
}

/** Unwraps a Supabase array-returning response (a plain `.select()` or an
 * RPC that returns a table) - throws on error, otherwise casts `data`
 * as-is. An empty result is a valid `[]`, not `null`, so no null-check is
 * needed here. `T` must be given explicitly at each call site. */
function unwrapArray<T>(result: { data: unknown; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

/** Unwraps a single-row Supabase response (a `.single()` fetch), throwing
 * if the row genuinely doesn't exist. Only use where a null row really
 * means "not found" - never for delete/insert calls without `.select()`.
 * `T` must be given explicitly at each call site. */
function unwrapRow<T>(result: { data: unknown; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("רשומה לא נמצאה");
  return result.data as T;
}

type VoterRow = {
  id: string;
  masad: string;
  first_name: string;
  last_name: string;
  street: string;
  house_number: number;
  city: string;
  phone: string;
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
};

function toVoter(row: VoterRow): ElectionDayVoter {
  return {
    id: row.id,
    masad: row.masad,
    firstName: row.first_name,
    lastName: row.last_name,
    street: row.street,
    houseNumber: row.house_number,
    city: row.city,
    phone: row.phone,
    coordinator: row.coordinator,
    notes: row.notes,
    rideRequested: row.ride_requested,
    rideRequestedAt: row.ride_requested_at,
    rideArranged: row.ride_arranged,
    rideArrangedAt: row.ride_arranged_at,
    rideCompleted: row.ride_completed,
    rideCompletedAt: row.ride_completed_at,
    reminderAt: row.reminder_at,
    voted: row.voted,
    votedAt: row.voted_at,
  };
}

type RideStatusEventRow = {
  id: string;
  contact_id: string | null;
  contact_name: string;
  coordinator: string;
  from_arranged: boolean;
  to_arranged: boolean;
  created_at: string;
};

function toRideStatusEvent(row: RideStatusEventRow): RideStatusEvent {
  return {
    id: row.id,
    contactId: row.contact_id ?? "",
    contactName: row.contact_name,
    coordinator: row.coordinator,
    from: row.from_arranged,
    to: row.to_arranged,
    at: row.created_at,
  };
}

type PermissionUserRpcRow = { id: string; name: string; role: string };

function toPermissionUser(row: PermissionUserRpcRow): PermissionUser {
  return { id: row.id, name: row.name, role: row.role as PermissionRole };
}

/**
 * Election Day's Supabase-backed data access - implements exactly the
 * election-day slice of `ApiClient` (see `src/services/api/index.ts`, which
 * composes this together with `MockApi` for the rest of the app). Schema:
 * `supabase/migrations/*_election_day_*.sql`.
 */
export class SupabaseElectionDayApi {
  async importElectionDayVoters(rows: NewElectionDayVoter[]): Promise<{ count: number }> {
    checkError(
      await supabase
        .from("election_day_ride_status_events")
        .delete()
        .neq("id", NEVER_MATCHES_ID),
    );
    checkError(
      await supabase.from("election_day_voters").delete().neq("id", NEVER_MATCHES_ID),
    );

    if (rows.length > 0) {
      checkError(
        await supabase.from("election_day_voters").insert(
          rows.map((r) => ({
            masad: r.masad,
            first_name: r.firstName,
            last_name: r.lastName,
            street: r.street,
            house_number: r.houseNumber,
            city: r.city,
            phone: r.phone,
            coordinator: r.coordinator,
          })),
        ),
      );
    }
    return { count: rows.length };
  }

  async listElectionDayVoters(): Promise<ElectionDayVoter[]> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.from("election_day_voters").select("*"),
    );
    return data.map(toVoter);
  }

  async clearElectionDayVoters(): Promise<void> {
    checkError(
      await supabase.from("election_day_voters").delete().neq("id", NEVER_MATCHES_ID),
    );
    checkError(
      await supabase
        .from("election_day_ride_status_events")
        .delete()
        .neq("id", NEVER_MATCHES_ID),
    );
  }

  private async updateVoter(
    id: string,
    patch: Partial<VoterRow>,
  ): Promise<ElectionDayVoter> {
    const data = unwrapRow<VoterRow>(
      await supabase
        .from("election_day_voters")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single(),
    );
    return toVoter(data);
  }

  async setRideRequested(id: string, requested: boolean): Promise<ElectionDayVoter> {
    return this.updateVoter(id, {
      ride_requested: requested,
      ride_requested_at: requested ? new Date().toISOString() : null,
    });
  }

  async setRideArranged(id: string, arranged: boolean): Promise<ElectionDayVoter> {
    const before = unwrapRow<{ ride_arranged: boolean }>(
      await supabase
        .from("election_day_voters")
        .select("ride_arranged")
        .eq("id", id)
        .single(),
    );

    const updated = await this.updateVoter(id, {
      ride_arranged: arranged,
      ride_arranged_at: arranged ? new Date().toISOString() : null,
    });

    checkError(
      await supabase.from("election_day_ride_status_events").insert({
        contact_id: updated.id,
        contact_name: `${updated.firstName} ${updated.lastName}`,
        coordinator: updated.coordinator,
        from_arranged: before.ride_arranged,
        to_arranged: arranged,
      }),
    );

    return updated;
  }

  async setRideCompleted(id: string, completed: boolean): Promise<ElectionDayVoter> {
    return this.updateVoter(id, {
      ride_completed: completed,
      ride_completed_at: completed ? new Date().toISOString() : null,
    });
  }

  async listRideStatusEvents(): Promise<RideStatusEvent[]> {
    const data = unwrapArray<RideStatusEventRow[]>(
      await supabase
        .from("election_day_ride_status_events")
        .select("*")
        .order("created_at", { ascending: false }),
    );
    return data.map(toRideStatusEvent);
  }

  async getElectionDayDeadline(): Promise<string | null> {
    const data = unwrapRow<{ deadline: string | null }>(
      await supabase
        .from("election_day_settings")
        .select("deadline")
        .eq("id", true)
        .single(),
    );
    return data.deadline;
  }

  async setElectionDayDeadline(deadline: string | null): Promise<string | null> {
    unwrapRow<{ deadline: string | null }>(
      await supabase
        .from("election_day_settings")
        .update({ deadline })
        .eq("id", true)
        .select("deadline")
        .single(),
    );
    return deadline;
  }

  async setReminder(
    id: string,
    minutesFromNow: number | null,
  ): Promise<ElectionDayVoter> {
    const reminderAt =
      minutesFromNow === null
        ? null
        : new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    return this.updateVoter(id, { reminder_at: reminderAt });
  }

  async setVoted(id: string, voted: boolean): Promise<ElectionDayVoter> {
    return this.updateVoter(id, {
      voted,
      voted_at: voted ? new Date().toISOString() : null,
    });
  }

  async setElectionDayNotes(id: string, notes: string): Promise<ElectionDayVoter> {
    return this.updateVoter(id, { notes });
  }

  async listRideCoordinators(): Promise<RideCoordinator[]> {
    return unwrapArray<RideCoordinator[]>(
      await supabase
        .from("election_day_ride_coordinators")
        .select("id, name, phone")
        .order("created_at", { ascending: true }),
    );
  }

  async addRideCoordinator(input: NewRideCoordinator): Promise<RideCoordinator> {
    return unwrapRow<RideCoordinator>(
      await supabase
        .from("election_day_ride_coordinators")
        .insert({ name: input.name, phone: input.phone })
        .select("id, name, phone")
        .single(),
    );
  }

  async deleteRideCoordinator(id: string): Promise<void> {
    checkError(
      await supabase.from("election_day_ride_coordinators").delete().eq("id", id),
    );
  }

  async listPermissionUsers(): Promise<PermissionUser[]> {
    const data = unwrapArray<PermissionUserRpcRow[]>(
      await supabase.rpc("election_day_list_permission_users"),
    );
    return data.map(toPermissionUser);
  }

  async addPermissionUser(input: NewPermissionUser): Promise<PermissionUser> {
    const data = unwrapArray<PermissionUserRpcRow[]>(
      await supabase.rpc("election_day_create_permission_user", {
        p_name: input.name,
        p_password: input.password,
        p_role: input.role,
      }),
    );
    return toPermissionUser(data[0]);
  }

  async deletePermissionUser(id: string): Promise<void> {
    checkError(await supabase.rpc("election_day_delete_permission_user", { p_id: id }));
  }

  async verifyPermissionUserLogin(
    name: string,
    password: string,
  ): Promise<PermissionUser | null> {
    const { data, error } = await supabase.rpc("election_day_login", {
      p_name: name.trim(),
      p_password: password,
    });
    if (error) throw new Error(error.message);
    const rows = data as PermissionUserRpcRow[];
    return rows.length > 0 ? toPermissionUser(rows[0]) : null;
  }

  /** Live cross-device sync for the two Realtime-enabled tables (see the
   * "election_day_realtime" migration). Deliberately just triggers a
   * refetch (`onChange`) rather than merging partial payloads into local
   * state - simpler and safer than hand-rolled diffing for this internal
   * tool's scale. */
  subscribeToElectionDayChanges(onChange: () => void): () => void {
    const channel = supabase
      .channel("election-day-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "election_day_voters" },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "election_day_ride_status_events" },
        onChange,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }
}
