import { describe, expect, it } from "vitest";
import { schemaToZodSchema } from "./zodSchema.js";

// zod v3 and v4 are both supported (see the "zod" range in package.json), so
// these assertions only rely on behaviour that is identical across the two.
describe("schemaToZodSchema", () => {
  it("maps json types onto their zod counterparts", () => {
    const schema = schemaToZodSchema({
      type: "object",
      properties: {
        name: { type: "string", description: "the name" },
        count: { type: "integer" },
        ratio: { type: "number" },
        enabled: { type: "boolean" },
        tags: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
        nested: { type: "object", properties: { id: { type: "string" } } },
      },
      required: ["name", "count"],
    });

    const parsed = schema.parse({
      name: "tool",
      count: 2,
      ratio: 0.5,
      enabled: true,
      tags: [{ id: "a" }],
      nested: { id: "x" },
    });

    expect(parsed).toEqual({
      name: "tool",
      count: 2,
      ratio: 0.5,
      enabled: true,
      tags: [{ id: "a" }],
      nested: { id: "x" },
    });
  });

  it("keeps non-required properties optional", () => {
    const schema = schemaToZodSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        optional: { type: "string" },
      },
      required: ["name"],
    });

    expect(schema.parse({ name: "tool" })).toEqual({ name: "tool" });
    expect(() => schema.parse({ optional: "value" })).toThrow();
  });

  it("turns a list of types into a union", () => {
    const schema = schemaToZodSchema({
      type: "object",
      properties: {
        value: { type: ["null", "boolean"] },
      },
      required: ["value"],
    });

    expect(schema.parse({ value: null })).toEqual({ value: null });
    expect(schema.parse({ value: false })).toEqual({ value: false });
    expect(() => schema.parse({ value: "nope" })).toThrow();
  });

  it("falls back to a string for unknown or missing types", () => {
    const schema = schemaToZodSchema({
      type: "object",
      properties: { value: {} },
      required: ["value"],
    });

    expect(schema.parse({ value: "anything" })).toEqual({ value: "anything" });
    expect(() => schema.parse({ value: 1 })).toThrow();
  });
});
