// JSON errors and request parsing. Every error is `{ error: { code, message } }`, and no
// message ever quotes what the request sent.
import type { ErrorResponse } from "@budgee/core";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as v from "valibot";

/** Largest body of every endpoint except push (device names, codes, secrets). */
export const SMALL_BODY_MAX = 16 * 1024;

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = () => new ApiError(404, "not_found", "Not found");

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json<ErrorResponse>({ error: { code, message } }, status);
}

/** Answers 413 above `maxSize` bytes, before the body is parsed. */
export function limitBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      errorResponse(c, 413, "payload_too_large", `Request body is larger than ${maxSize} bytes`),
  });
}

/**
 * Where the first issue is and what kind it is. Keys the client invented are shown as `?`:
 * they are request data, like the values, which are never shown.
 */
function describeIssue(issue: v.BaseIssue<unknown> | undefined): string {
  if (!issue) return "Invalid request";
  const path = (issue.path ?? [])
    .map((item) => (item.origin === "key" ? "?" : String(item.key)))
    .join(".");
  const what = issue.kind === "schema" ? `expected ${issue.expected}` : `failed ${issue.type}`;
  return `Invalid request${path ? ` at ${path}` : ""}: ${what}`;
}

export function parseInput<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, input);
  if (!result.success) throw new ApiError(400, "invalid_request", describeIssue(result.issues[0]));
  return result.output;
}

/** Parses and validates the JSON body. With `optional`, an empty body reads as `{}`. */
export async function readBody<S extends v.GenericSchema>(
  c: Context,
  schema: S,
  { optional = false } = {},
): Promise<v.InferOutput<S>> {
  const text = await c.req.text();
  let data: unknown = {};
  if (text !== "" || !optional) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
    }
  }
  return parseInput(schema, data);
}
