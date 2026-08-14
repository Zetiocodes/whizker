import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getMyRoomSummaries } from "@/lib/rooms/summaries";
import { AppShell } from "@/components/app-shell";
import { CreateRoomButton } from "@/components/rooms/create-room-button";
import { JoinRoomForm } from "@/components/rooms/join-room-form";
import { RoomListRow } from "@/components/rooms/room-list-row";
import { Icon } from "@/components/ui/icon";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  const supabase = await createClient();
  const rooms = await getMyRoomSummaries(supabase, user.id);

  return (
    <AppShell
      user={user}
      rooms={rooms}
    >
      <div className="h-full overflow-y-auto">
        <header className="flex h-14 shrink-0 items-center border-b border-border px-4 lg:px-8">
          <h1 className="text-sm font-semibold">Home</h1>
        </header>

        <section className="p-4 lg:p-8">
          <div className="mx-auto max-w-3xl space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
                  <Icon name="plus" className="h-4 w-4" />
                </span>
                <h2 className="mt-3 text-sm font-semibold">Create a room</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Get a code to share with one person. The room disappears 24
                  hours after it is created.
                </p>
                <div className="mt-4">
                  <CreateRoomButton />
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
                  <Icon name="link" className="h-4 w-4" />
                </span>
                <h2 className="mt-3 text-sm font-semibold">Join a room</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Enter the code you received to open the room.
                </p>
                <div className="mt-4">
                  <JoinRoomForm />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface">
              <div className="border-b border-border px-5 py-3">
                <h2 className="text-sm font-semibold">Your rooms</h2>
              </div>
              {rooms.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-muted">
                    <Icon name="chat" className="h-4 w-4" />
                  </span>
                  <p className="text-sm text-muted">
                    No rooms yet. Create one or join a room with a code to get
                    started.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {rooms.map((room) => (
                    <RoomListRow key={room.id} room={room} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
