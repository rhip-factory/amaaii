// Isolated login call — the ONLY module that knows how sign-in currently
// works (phone-only, POST /auth/login, no OTP). The next package swaps
// this file for a real OTP challenge; nothing else in the app should call
// /auth/login directly, so that swap stays a one-file change.

import type { ApiErrorBody, LoginResponse } from "./types";

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/** POST /auth/login — accepts the raw string the user typed (07XX… or +254…); the server normalizes it. */
export async function login(phone: string): Promise<LoginResponse> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<LoginResponse & ApiErrorBody>;
  if (!res.ok || !data.token || !data.user) {
    throw new LoginError(data.message || "Could not sign in. Check the phone number.");
  }
  return { token: data.token, user: data.user };
}
