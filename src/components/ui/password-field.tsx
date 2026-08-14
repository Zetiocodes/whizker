"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  error?: string;
  hint?: string;
}

/**
 * Labelled password input with a show/hide visibility toggle. The toggle is
 * described by `aria-describedby` and labelled "Show password" / "Hide
 * password" so it is fully accessible.
 */
export function PasswordField({ label, error, hint, id, className, ...props }: PasswordFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const errorId = `${fieldId}-error`;
  const toggleId = `${fieldId}-toggle`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={fieldId}
          type={visible ? "text" : "password"}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? undefined : undefined}
          className={cn(
            "h-10 w-full rounded-lg border bg-surface pl-3 pr-10 text-sm text-foreground",
            "placeholder:text-muted",
            error
              ? "border-danger/60 focus:border-danger focus:outline-none focus:ring-2 focus:ring-danger/30"
              : "border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30",
            className,
          )}
          {...props}
        />
        <button
          type="button"
          id={toggleId}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-describedby={fieldId}
          onClick={() => setVisible((value) => !value)}
          className="focus-ring absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-surface-raised hover:text-foreground"
        >
          <Icon name={visible ? "eye-off" : "eye"} className="h-4 w-4" />
        </button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
