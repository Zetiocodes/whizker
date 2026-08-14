"use client";

import { useActionState } from "react";
import { createRoomAction, type RoomActionState } from "@/actions/rooms";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function CreateRoomButton() {
  const [state, formAction, isPending] = useActionState<
    RoomActionState,
    FormData
  >(createRoomAction, {});

  return (
    <form action={formAction}>
      <Button type="submit" loading={isPending} className="w-full">
        {isPending ? (
          "Creating…"
        ) : (
          <>
            <Icon name="plus" className="h-4 w-4" />
            Create a room
          </>
        )}
      </Button>
      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
