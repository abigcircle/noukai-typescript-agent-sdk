/**
 * ToolLabelFormatter — Converts tool names into user-facing progress labels.
 *
 * Splits tool names on underscores, maps the leading verb to a random
 * label from a pool of synonyms, and joins the rest as a readable phrase.
 *
 * Each verb maps to an array of labels — one is picked at random each time
 * so the UI feels varied and playful.
 *
 * @example
 *   const formatter = new ToolLabelFormatter({
 *     get: ["Peeking at", "Reading", "Checking out"],
 *     create: ["Conjuring", "Crafting", "Whipping up"],
 *     delete: ["Banishing", "Zapping"],
 *   });
 *   formatter.formatOne("get_block_details");
 *   // => "Peeking at block details"  (randomly chosen)
 *
 *   formatter.format([{ id: "1", name: "get_block_details", arguments: {} }]);
 *   // => ["*Peeking at block details*"]
 */

import type { ToolCall } from "./types.js";

/** Resolves a tool call to an optional display context (e.g. block name) */
export type ToolCallContextResolver = (call: ToolCall) => string | undefined;

/** Each verb maps to one or more label variants */
export type VerbLabels = Record<string, string | string[]>;

const DEFAULT_VERB_LABELS: Record<string, string[]> = {
  get: ["Reading"],
  create: ["Creating"],
  write: ["Writing"],
  update: ["Updating"],
  delete: ["Deleting"],
  set: ["Setting"],
  add: ["Adding"],
  remove: ["Removing"],
  run: ["Running"],
  execute: ["Executing"],
  validate: ["Validating"],
};

/** Normalize a single string or string[] into string[] */
function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** Pick a random element from a non-empty array */
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export class ToolLabelFormatter {
  private verbs: Record<string, string[]>;

  constructor(overrides?: VerbLabels) {
    const base = structuredClone(DEFAULT_VERB_LABELS);
    if (overrides) {
      for (const [verb, labels] of Object.entries(overrides)) {
        base[verb.toLowerCase()] = toArray(labels);
      }
    }
    this.verbs = base;
  }

  /** Set or override labels for a single verb */
  setVerb(verb: string, labels: string | string[]): this {
    this.verbs[verb.toLowerCase()] = toArray(labels);
    return this;
  }

  /** Replace all verb labels at once */
  setVerbs(verbs: VerbLabels): this {
    this.verbs = {};
    for (const [verb, labels] of Object.entries(verbs)) {
      this.verbs[verb.toLowerCase()] = toArray(labels);
    }
    return this;
  }

  /** Format a single tool name into a readable label */
  formatOne(name: string): string {
    const parts = name.split("_");
    const verb = parts[0]?.toLowerCase() ?? "";
    const labels = this.verbs[verb];

    const readable = labels?.length
      ? `${pickRandom(labels)} ${parts.slice(1).join(" ")}`
      : name.replace(/_/g, " ");

    return readable.replace(/^\w/, (c) => c.toUpperCase());
  }

  /**
   * Format a single tool name with optional context inserted between
   * the verb and the object noun.
   *
   * @example
   *   formatWithContext("get_block_details", "Grader")
   *   // => "Peeking at Grader block details"
   */
  formatWithContext(name: string, context?: string): string {
    const parts = name.split("_");
    const verb = parts[0]?.toLowerCase() ?? "";
    const labels = this.verbs[verb];

    const object = parts.slice(1).join(" ");
    const readable = labels?.length
      ? `${pickRandom(labels)} ${context ? `${context} ` : ""}${object}`
      : `${name.replace(/_/g, " ")}${context ? ` (${context})` : ""}`;

    return readable.replace(/^\w/, (c) => c.toUpperCase());
  }

  /**
   * Format tool calls into individual display labels.
   * Returns one label per tool call, each wrapped in markdown italics.
   */
  format(
    calls: ToolCall[],
    contextResolver?: ToolCallContextResolver,
  ): string[] {
    return calls.map((call) => {
      const context = contextResolver?.(call);
      return `*${this.formatWithContext(call.name, context)}*`;
    });
  }
}
