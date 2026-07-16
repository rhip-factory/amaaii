// Isolated OTP call surface (P2-B) — the ONLY module that knows how the
// two-step OTP challenge works (POST /auth/otp/request,
// POST /auth/otp/verify). Mirrors authLogin.ts's isolation pattern:
// nothing else in the app should call these endpoints directly.

import { API_BASE } from "./api";
import type { ApiErrorBody, LoginResponse } from "./types";

export class OtpError extends Error {
  /** Server error code (e.g. "rate_limited", "wrong_code", "expired") — lets
   *  the page branch on specifics without parsing the message string. */
  code?: string;
  attemptsRemaining?: number;
  retryAfterSeconds?: number;
  constructor(
    message: string,
    opts?: { code?: string; attemptsRemaining?: number; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = "OtpError";
    this.code = opts?.code;
    this.attemptsRemaining = opts?.attemptsRemaining;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

export interface OtpRequestResult {
  sent: true;
  /** Present only when the server has no Twilio creds configured AND
   *  NODE_ENV !== 'production' — see apps/server/src/app.ts's
   *  POST /auth/otp/request. */
  devCode?: string;
}

interface OtpRequestBody extends Partial<OtpRequestResult>, ApiErrorBody {
  retryAfterSeconds?: number;
}

/** POST /auth/otp/request — sends (or dev-logs) a 6-digit code for `phone`. */
export async function requestOtp(phone: string): Promise<OtpRequestResult> {
  const res = await fetch(`${API_BASE}/auth/otp/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const data = (await res.json().catch(() => ({}))) as OtpRequestBody;
  if (!res.ok || !data.sent) {
    throw new OtpError(data.message || "Could not send a code. Check the phone number.", {
      code: data.error,
      retryAfterSeconds: data.retryAfterSeconds,
    });
  }
  return { sent: true, devCode: data.devCode };
}

interface OtpVerifyBody extends Partial<LoginResponse>, ApiErrorBody {
  attemptsRemaining?: number;
}

/** POST /auth/otp/verify — exchanges {phone, code} for the same
 *  token+user shape POST /auth/login returns. */
export async function verifyOtp(phone: string, code: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
  const data = (await res.json().catch(() => ({}))) as OtpVerifyBody;
  if (!res.ok || !data.token || !data.user) {
    throw new OtpError(data.message || "That code didn't work. Please try again.", {
      code: data.error,
      attemptsRemaining: data.attemptsRemaining,
    });
  }
  return { token: data.token, user: data.user };
}
