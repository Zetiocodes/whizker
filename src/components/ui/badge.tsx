import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeTone = "muted" | "success" | "warning" | "danger" | "accent";

const toneClasses: Record<BadgeTone, string> = {
  muted: "border-border bg-surface-raised text-muted",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  accent: "border-accent/40 bg-accent/10 text-accent",
};

interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  /** Optional icon rendered before the label. */
  icon?: ReactNode;
  title?: string;
}

export function Badge({ tone = "muted", className, children, icon, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export type { BadgeTone };
