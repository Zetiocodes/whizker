"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { leaveRoomAction } from "@/actions/rooms";
import { deleteRoomKeys } from "@/lib/crypto/key-store";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

interface LeaveChatButtonProps {
  roomId: string;
}

/**
 * Destructive "Leave chat" entry point. The confirming dialog is blunt about
 * what happens: leaving permanently marks the room as ended, destroys every
 * key and every piece of encrypted content (messages and images) server-side,
 * and removes the room from this device too. The room's code cannot be reused.
 */
export function LeaveChatButton({ roomId }: LeaveChatButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const confirmLeave = () => {
    if (isPending) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await leaveRoomAction(roomId);
      if (result.ok) {
        await deleteRoomKeys(roomId);
        router.push("/dashboard");
        router.refresh();
        return;
      }
      setError(result.error ?? "Could not leave the chat. Please try again.");
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted hover:bg-danger/10 hover:text-danger"
        title="Leave chat"
        aria-label="Leave chat"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name="log-out" className="h-4 w-4" />
      </Button>

      <Dialog open={open} onClose={() => !isPending && setOpen(false)} title="Leave this chat?">
        <div>
          <p className="text-sm leading-relaxed text-muted">
            Leaving will permanently end this chat. Every message, every image
            and the encryption keys that protect them will be deleted, and the
            room code can never be reused. This cannot be undone.
          </p>

          {error ? (
            <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmLeave} loading={isPending}>
              Leave chat
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
