/**
 * Structured output: `request.schema` is either a plain JSON Schema or any
 * Standard Schema (Zod, Valibot, ArkType, ...). The JSON form, when one can
 * be had, goes to providers that take a schema on the wire; the answer is
 * parsed and, for a Standard Schema, validated before it lands on
 * `response.object`.
 */
import type { AIRequest, StandardSchemaV1 } from '../types/index.js';

export type Schema = StandardSchemaV1 | Record<string, unknown>;

export function isStandardSchema(s: unknown): s is StandardSchemaV1 {
  return typeof s === 'object' && s !== null && '~standard' in s && typeof (s as StandardSchemaV1)['~standard']?.validate === 'function';
}

/** The JSON Schema to send, or undefined when the library offers none (the provider then gets plain JSON mode). */
export function jsonSchemaOf(schema: Schema | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  if (!isStandardSchema(schema)) return schema;
  const std = schema['~standard'];
  try {
    return std.jsonSchema?.input?.({ target: 'draft-2020-12' }) ?? undefined;
  } catch {
    return undefined;
  }
}

/** JSON mode is on for `jsonMode` and whenever a schema is given. */
export function wantsJson(request: AIRequest): boolean {
  return !!request.jsonMode || request.schema !== undefined;
}

/** Parses a JSON answer, tolerating the ```json fence a model adds despite being told not to. */
export function parseJson(text: string): { value: unknown } | { error: string } {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { value: JSON.parse(body) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface Issue {
  message: string;
  path?: string;
}

/** Runs the Standard Schema; a plain JSON Schema has no validator here, so its value passes through. */
export async function validate(schema: Schema, value: unknown): Promise<{ value: unknown } | { issues: Issue[] }> {
  if (!isStandardSchema(schema)) return { value };
  const result = await schema['~standard'].validate(value);
  if (!result.issues) return { value: result.value };
  return {
    issues: result.issues.map((i) => ({
      message: i.message,
      path: i.path?.map((p) => (typeof p === 'object' && p !== null && 'key' in p ? String(p.key) : String(p))).join('.') || undefined,
    })),
  };
}
