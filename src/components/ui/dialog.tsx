"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Title announced to assistive tech and used as the dialog label. */
  title: string;
  children: ReactNode;
  /** Max-width utility, e.g. "max-w-lg". */
  size?: "sm" | "md" | "lg";
  /** Hide the close button (e.g. when the dialog cannot be dismissed). */
  hideClose?: boolean;
}

const sizes: Record<NonNullable<DialogProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-3xl",
};

/**
 * Accessible modal dialog: traps focus, closes on Escape or backdrop click,
 * locks body scroll while open, and labels itself via `aria-labelledby`.
 */
export function Dialog({ open, onClose, title, children, size = "md", hideClose = false }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the first focusable element inside the panel, else the panel.
    const focusables = panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables?.[0];
    (first ?? panel)?.focus();

    const handleFocus = (event: FocusEvent) => {
      if (panel && !panel.contains(event.target as Node)) {
        (first ?? panel)?.focus();
      }
    };
    document.addEventListener("focusin", handleFocus);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", handleFocus);
      previouslyFocused?.focus();
    };
  }, [open, onKeyDown]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-fade-in"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !hideClose) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-border bg-surface shadow-overlay animate-scale-in",
          sizes[size],
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          {!hideClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="focus-ring -m-1 flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground"
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
