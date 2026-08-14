"use client";

import { useActionState, useState } from "react";
import { joinRoomAction, type RoomActionState } from "@/actions/rooms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROOM_CODE_PATTERN, formatRoomCodeInput } from "@/lib/rooms/code";
import { cn } from "@/lib/utils";

/**
 * Join-by-code form with progressive auto-formatting (uppercase + dash
 * grouping as you type), paste normalization and inline validation, so a
 * malformed code is rejected before it ever reaches the server action.
 */
export function JoinRoomForm() {
  const [state, formAction, isPending] = useActionState<
    RoomActionState,
    FormData
  >(joinRoomAction, {});
  const [value, setValue] = useState("");

  const serverError = state.fieldErrors?.code?.[0] ?? state.error;
  const formatted = formatRoomCodeInput(value);
  const hasTyped = value.length > 0;
  const complete = ROOM_CODE_PATTERN.test(formatted);
  const lengthError =
    hasTyped && formatted.length > 0 && !complete
      ? "Enter all 12 characters of the code."
      : null;
  const error = lengthError ?? serverError;

  return (
    <form action={formAction} className="space-y-2" noValidate>
      <div className="flex gap-2">
        <Input
          name="code"
          value={formatted}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = event.clipboardData.getData("text");
            setValue(formatRoomCodeInput(pasted));
          }}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          maxLength={14}
          className={cn("font-mono uppercase tracking-widest")}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "join-code-error" : undefined}
        />
        <Button
          type="submit"
          disabled={isPending || (hasTyped && !complete)}
          className="shrink-0"
          loading={isPending}
        >
          {isPending ? "Joining…" : "Join"}
        </Button>
      </div>
      {error ? (
        <p id="join-code-error" role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
