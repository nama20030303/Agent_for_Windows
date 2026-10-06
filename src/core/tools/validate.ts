import type { JSONSchema } from '../shared/types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  value: Record<string, unknown>;
}

/**
 * Strict validator for the small JSON-Schema subset used by tool definitions.
 * Unknown properties are rejected so a model cannot smuggle extra arguments.
 */
export function validateArgs(sch: JSONSchema, args: unknown): ValidationResult {
  const errors: string[] = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, errors: ['Arguments must be a JSON object.'], value: {} };
  }
  const input = args as Record<string, unknown>;
  const value: Record<string, unknown> = {};

  for (const key of sch.required ?? []) {
    if (input[key] === undefined || input[key] === null) errors.push(`Missing required argument "${key}".`);
  }

  for (const [key, raw] of Object.entries(input)) {
    const spec = sch.properties[key] as
      | { type?: string; enum?: unknown[]; items?: { type?: string } }
      | undefined;
    if (!spec) {
      if (sch.additionalProperties === false) errors.push(`Unknown argument "${key}".`);
      continue;
    }
    if (raw === undefined || raw === null) continue;
    const t = spec.type;
    if (t === 'string' && typeof raw !== 'string') errors.push(`Argument "${key}" must be a string.`);
    else if (t === 'number' && typeof raw !== 'number') errors.push(`Argument "${key}" must be a number.`);
    else if (t === 'boolean' && typeof raw !== 'boolean') errors.push(`Argument "${key}" must be a boolean.`);
    else if (t === 'array' && !Array.isArray(raw)) errors.push(`Argument "${key}" must be an array.`);
    else if (t === 'object' && (typeof raw !== 'object' || Array.isArray(raw)))
      errors.push(`Argument "${key}" must be an object.`);
    if (spec.enum && !spec.enum.includes(raw)) {
      errors.push(`Argument "${key}" must be one of: ${spec.enum.join(', ')}.`);
    }
    value[key] = raw;
  }

  return { valid: errors.length === 0, errors, value };
}
