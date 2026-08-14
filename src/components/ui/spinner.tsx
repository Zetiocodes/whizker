import { cn } from "@/lib/utils";

interface SpinnerProps {
  className?: string;
  label?: string;
}

/**
 * Inline loading spinner. When `label` is provided the spinner is
 * `aria-hidden` and the label carries the live region, so assistive tech gets
 * a meaningful announcement instead of just a spinning ring.
 */
export function Spinner({ className, label }: SpinnerProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent",
          className,
        )}
      />
      {label ? <span className="text-sm text-muted">{label}</span> : null}
    </span>
  );
}
