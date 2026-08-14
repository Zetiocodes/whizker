import { cn } from "@/lib/utils";

interface BrandProps {
  size?: "sm" | "md";
}

/** Simple wordmark. Not affiliated with Discord's branding. */
export function Brand({ size = "md" }: BrandProps) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex items-center justify-center rounded-lg bg-accent font-bold text-white",
          size === "sm" ? "h-7 w-7 text-sm" : "h-8 w-8 text-base",
        )}
        aria-hidden="true"
      >
        W
      </span>
      <span
        className={cn(
          "font-semibold tracking-tight",
          size === "sm" ? "text-base" : "text-lg",
        )}
      >
        Whisper
      </span>
    </div>
  );
}
