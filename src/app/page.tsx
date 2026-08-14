import Link from "next/link";
import { appConfig } from "@/config";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";

const FEATURES = [
  {
    icon: "shield" as const,
    title: "End-to-end encrypted",
    description:
      "Messages and images are sealed in your browser. Even the server never sees plaintext.",
  },
  {
    icon: "clock" as const,
    title: "Gone in 24 hours",
    description:
      "Every room is permanently destroyed a day after it is created. Nothing lingers.",
  },
  {
    icon: "key" as const,
    title: "No email, no recovery",
    description:
      "Username and password only. No email, no phone number, no password reset.",
  },
  {
    icon: "users" as const,
    title: "One conversation",
    description:
      "Temporary 1-to-1 rooms. Share the code, talk, then let it disappear.",
  },
] as const;

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <div className="mb-6">
        <Brand />
      </div>

      <div className="flex max-w-2xl flex-col items-center gap-4 text-center">
        <Badge tone="accent" icon={<Icon name="lock" className="h-3 w-3" />}>
          End-to-end encrypted
        </Badge>
        <h1 className="text-4xl font-semibold tracking-tight">
          Conversations that disappear.
        </h1>
        <p className="text-sm leading-relaxed text-muted">{appConfig.description}</p>
        <div className="mt-2 flex items-center gap-3">
          <Link href="/signup">
            <Button size="lg">Create an account</Button>
          </Link>
          <Link href="/login">
            <Button size="lg" variant="secondary">
              Sign in
            </Button>
          </Link>
        </div>
      </div>

      <ul className="mt-12 grid w-full max-w-3xl gap-3 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Icon name={feature.icon} className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-medium text-foreground">{feature.title}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {feature.description}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
