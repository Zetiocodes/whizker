import { z } from "zod";
import { appConfig } from "@/config";

const { limits } = appConfig;

/**
 * Usernames are normalized to lowercase+trimmed, restricted to a safe
 * character set, and used to derive the synthetic auth identifier
 * `<username>@whisper.invalid`.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(
    limits.usernameMinLength,
    `Username must be at least ${limits.usernameMinLength} characters.`,
  )
  .max(
    limits.usernameMaxLength,
    `Username must be at most ${limits.usernameMaxLength} characters.`,
  )
  .regex(
    limits.usernamePattern,
    "Username may only contain lowercase letters, numbers and underscores.",
  );

export const displayNameSchema = z
  .string()
  .trim()
  .min(
    limits.displayNameMinLength,
    "Display name must not be empty.",
  )
  .max(
    limits.displayNameMaxLength,
    `Display name must be at most ${limits.displayNameMaxLength} characters.`,
  );

export const passwordSchema = z
  .string()
  .min(
    limits.passwordMinLength,
    `Password must be at least ${limits.passwordMinLength} characters.`,
  )
  .max(
    limits.passwordMaxLength,
    `Password must be at most ${limits.passwordMaxLength} characters.`,
  );

export const signupSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, "Password is required."),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
