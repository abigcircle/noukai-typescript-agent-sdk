import { describe, it, expect } from "vitest";
import { toWireToolDef } from "../src/wire-adapters";
import type { ToolDefinition } from "../src/types";

describe("ToolParameterSchema widening (nouko delta)", () => {
  // Compiles only because the property-value shape now admits array `items`
  // with nested object `properties` — this is the reason for the delta.
  const def: ToolDefinition = {
    name: "set_exercise_words",
    description: "Replace the words on an exercise.",
    parameters: {
      type: "object",
      properties: {
        exerciseIndex: { type: "integer", description: "0-based index" },
        // `enum` must be admitted too — nouko-pack-ai's set_basics uses it
        // (language enum). Guarded here, not just by check-types.
        language: { type: "string", description: "target language", enum: ["ja", "ko", "zh", "en"] },
        words: {
          type: "array",
          description: "The words",
          items: {
            type: "object",
            properties: {
              word: { type: "string", description: "surface form" },
              meaning: { type: "string", description: "gloss" },
            },
            required: ["word"],
          },
        },
      },
      required: ["exerciseIndex", "words"],
    },
  };

  it("passes nested array/object/enum params through toWireToolDef unchanged", () => {
    const wire = toWireToolDef(def);
    // structural passthrough → deep-equal to the input parameters
    expect(wire.function.parameters).toEqual(def.parameters);
    // enum survives verbatim on the wire
    expect((wire.function.parameters.properties as Record<string, { enum?: unknown }>).language.enum)
      .toEqual(["ja", "ko", "zh", "en"]);
    expect(wire.type).toBe("function");
    expect(wire.function.name).toBe("set_exercise_words");
  });
});
