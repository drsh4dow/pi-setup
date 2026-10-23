import type { RequestedLine } from "./orders.ts";
import { err, ok, type Result } from "./result.ts";

export type InputError = { kind: "invalid_input"; message: string };

/** Returns the lines of a `POST /orders` body, or an `invalid_input` error saying what is wrong. */
export function parseNewOrder(body: unknown): Result<{ lines: RequestedLine[] }, InputError> {
  if (!isRecord(body) || !Array.isArray(body.lines) || body.lines.length === 0) {
    return invalid("lines must be a non-empty array");
  }
  const lines: RequestedLine[] = [];
  for (const line of body.lines) {
    if (!isRecord(line)) return invalid("each line must be an object");
    if (typeof line.sku !== "string" || line.sku === "") return invalid("sku must be a non-empty string");
    if (!isPositiveInteger(line.quantity)) return invalid("quantity must be a positive integer");
    lines.push({ sku: line.sku, quantity: line.quantity });
  }
  return ok({ lines });
}

/** Returns the payment reference of a `POST /orders/:id/payment` body, or an `invalid_input` error. */
export function parsePayment(body: unknown): Result<{ paymentRef: string }, InputError> {
  if (!isRecord(body) || typeof body.paymentRef !== "string" || body.paymentRef === "") {
    return invalid("paymentRef must be a non-empty string");
  }
  return ok({ paymentRef: body.paymentRef });
}

/** Returns whether `value` is a whole number greater than zero. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Returns whether `value` is a plain object whose fields can be read by name. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Result<never, InputError> {
  return err({ kind: "invalid_input", message });
}
