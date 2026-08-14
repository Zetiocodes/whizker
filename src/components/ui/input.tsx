import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    const invalid = props["aria-invalid"] === true;
    return (
      <input
        ref={ref}
        className={cn(
          "h-10 w-full rounded-lg border bg-surface px-3 text-sm text-foreground",
          "placeholder:text-muted",
          invalid
            ? "border-danger/60 focus:border-danger focus:outline-none focus:ring-2 focus:ring-danger/30"
            : "border-border focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30",
          "disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
