"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** A small curated set — original, dependency-free, and fully offline. */
const EMOJIS = [
  "😀", "😄", "😅", "😂", "😊", "😍", "😘", "😜",
  "🤔", "🙄", "😴", "😭", "😤", "👍", "👎", "👏",
  "🙏", "💪", "❤️", "💜", "✨", "🔥", "🎉", "👀",
];

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  disabled?: boolean;
}

/** Emoji button with a small popover of curated emoji. */
export function EmojiPicker({ onPick, disabled = false }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Emoji"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors",
          "hover:bg-surface-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          open && "bg-surface-raised text-foreground",
        )}
      >
        <Icon name="emoji" className="h-4 w-4" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Emoji"
          className="absolute bottom-full left-0 z-20 mb-2 grid w-56 grid-cols-6 gap-0.5 rounded-xl border border-border bg-surface-raised p-2 shadow-popover animate-scale-in"
        >
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              aria-label={emoji}
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-lg transition-colors hover:bg-surface-overlay"
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
