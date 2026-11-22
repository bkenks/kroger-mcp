export class KrogerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "KrogerApiError";
  }
}

/** Thrown when a user-scoped call (cart, profile) is made without a usable login. */
export class NotAuthenticatedError extends Error {
  constructor(reason = "Not logged in to Kroger.") {
    super(
      `${reason} Call the kroger_login tool and have the user open the returned URL ` +
        "(or run `kroger-mcp auth` in a terminal), then retry.",
    );
    this.name = "NotAuthenticatedError";
  }
}

/** Pull a human-readable message out of the various Kroger error body shapes. */
export function describeErrorBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body.trim() ? body.trim().slice(0, 500) : undefined;
  }
  const b = body as Record<string, any>;
  if (typeof b.error_description === "string") return b.error_description;
  if (typeof b.error === "string") return b.error;
  if (b.errors) {
    const errs = Array.isArray(b.errors) ? b.errors : [b.errors];
    const reasons = errs
      .map((e: any) => e?.reason ?? e?.message ?? e?.code)
      .filter((r: unknown): r is string => typeof r === "string");
    if (reasons.length) return reasons.join("; ");
  }
  if (typeof b.message === "string") return b.message;
  return undefined;
}
