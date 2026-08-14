import { describe, expect, it } from "vitest";
import { loginSchema, signupSchema } from "@/lib/auth/validation";

const PASSWORD = "correct-horse-battery-staple";

describe("loginSchema", () => {
  it("accepts a valid username and password", () => {
    const result = loginSchema.safeParse({
      username: "alice_01",
      password: PASSWORD,
    });
    expect(result.success).toBe(true);
  });

  it("rejects usernames with invalid characters", () => {
    const result = loginSchema.safeParse({
      username: "Alice!",
      password: PASSWORD,
    });
    expect(result.success).toBe(false);
  });

  it("rejects usernames that are too short", () => {
    const result = loginSchema.safeParse({ username: "ab", password: PASSWORD });
    expect(result.success).toBe(false);
  });

  it("rejects a missing password", () => {
    const result = loginSchema.safeParse({ username: "alice_01", password: "" });
    expect(result.success).toBe(false);
  });
});

describe("signupSchema", () => {
  it("accepts a valid signup", () => {
    const result = signupSchema.safeParse({
      username: "alice_01",
      displayName: "Alice",
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    expect(result.success).toBe(true);
  });

  it("rejects mismatched passwords", () => {
    const result = signupSchema.safeParse({
      username: "alice_01",
      displayName: "Alice",
      password: PASSWORD,
      confirmPassword: "different-password",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.confirmPassword).toBeDefined();
    }
  });

  it("rejects an empty display name", () => {
    const result = signupSchema.safeParse({
      username: "alice_01",
      displayName: "   ",
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a too-short password", () => {
    const result = signupSchema.safeParse({
      username: "alice_01",
      displayName: "Alice",
      password: "short",
      confirmPassword: "short",
    });
    expect(result.success).toBe(false);
  });
});
