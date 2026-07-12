// Shared HTTP error classes. Kept in lib/ (not invoice/) so the ledger layer
// can use them without importing from the invoice layer (which would cycle).

export class ValidationError extends Error {
  status = 400;
}
export class NotFoundError extends Error {
  status = 404;
}
export class ConflictError extends Error {
  status = 409;
}

/** Map a raw Postgres error to a friendly HTTP error where possible. */
export function mapDbError(err: unknown, friendly: string): Error {
  if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
    return new ConflictError(friendly);
  }
  return err instanceof Error ? err : new Error(String(err));
}
