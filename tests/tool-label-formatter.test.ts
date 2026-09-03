import { describe, it, expect, vi } from "vitest";
import { ToolLabelFormatter } from "../src/tool-label-formatter";

describe("ToolLabelFormatter", () => {
  // ── formatOne ──────────────────────────────────────────────

  describe("formatOne", () => {
    it("maps a known verb to its label", () => {
      const f = new ToolLabelFormatter();
      expect(f.formatOne("get_user_profile")).toBe("Reading user profile");
    });

    it("capitalizes the first letter", () => {
      const f = new ToolLabelFormatter();
      expect(f.formatOne("delete_old_records")).toBe("Deleting old records");
    });

    it("handles all default verbs", () => {
      const f = new ToolLabelFormatter();
      const cases: [string, string][] = [
        ["get_data", "Reading data"],
        ["create_node", "Creating node"],
        ["write_file", "Writing file"],
        ["update_config", "Updating config"],
        ["delete_item", "Deleting item"],
        ["set_value", "Setting value"],
        ["add_edge", "Adding edge"],
        ["remove_block", "Removing block"],
        ["run_pipeline", "Running pipeline"],
        ["execute_task", "Executing task"],
        ["validate_input", "Validating input"],
      ];
      for (const [input, expected] of cases) {
        expect(f.formatOne(input)).toBe(expected);
      }
    });

    it("falls back to replacing underscores for unknown verbs", () => {
      const f = new ToolLabelFormatter();
      expect(f.formatOne("fetch_all_records")).toBe("Fetch all records");
    });

    it("handles single-word tool names with unknown verb", () => {
      const f = new ToolLabelFormatter();
      expect(f.formatOne("snapshot")).toBe("Snapshot");
    });

    it("handles single-word tool names with known verb", () => {
      const f = new ToolLabelFormatter();
      // "get" with no remaining parts → "Reading "
      expect(f.formatOne("get")).toBe("Reading ");
    });
  });

  // ── format (multiple) ─────────────────────────────────────

  describe("format", () => {
    const tc = (name: string): { id: string; name: string; arguments: Record<string, unknown> } => ({
      id: `tc-${name}`,
      name,
      arguments: {},
    });

    it("returns one italicized label per tool call", () => {
      const f = new ToolLabelFormatter();
      const result = f.format([tc("get_data"), tc("update_config")]);
      expect(result).toEqual(["*Reading data*", "*Updating config*"]);
    });

    it("returns a single wrapped label for one tool", () => {
      const f = new ToolLabelFormatter();
      expect(f.format([tc("create_node")])).toEqual(["*Creating node*"]);
    });

    it("returns empty array for empty input", () => {
      const f = new ToolLabelFormatter();
      expect(f.format([])).toEqual([]);
    });

    it("inserts context from resolver between verb and object", () => {
      const f = new ToolLabelFormatter();
      const resolver = () => "Grader";
      const result = f.format([tc("get_block_details")], resolver);
      expect(result).toEqual(["*Reading Grader block details*"]);
    });
  });

  // ── constructor overrides ─────────────────────────────────

  describe("constructor overrides", () => {
    it("overrides a default verb", () => {
      const f = new ToolLabelFormatter({ get: "Fetching" });
      expect(f.formatOne("get_data")).toBe("Fetching data");
    });

    it("adds a new verb", () => {
      const f = new ToolLabelFormatter({ analyze: "Analyzing" });
      expect(f.formatOne("analyze_results")).toBe("Analyzing results");
    });

    it("accepts array of labels for a verb", () => {
      const f = new ToolLabelFormatter({ get: ["Peeking at", "Reading"] });
      const result = f.formatOne("get_data");
      expect(["Peeking at data", "Reading data"]).toContain(result);
    });

    it("normalizes verb keys to lowercase", () => {
      const f = new ToolLabelFormatter({ GET: "Grabbing" });
      expect(f.formatOne("get_items")).toBe("Grabbing items");
    });

    it("preserves default verbs not overridden", () => {
      const f = new ToolLabelFormatter({ get: "Fetching" });
      expect(f.formatOne("create_node")).toBe("Creating node");
    });
  });

  // ── setVerb ───────────────────────────────────────────────

  describe("setVerb", () => {
    it("overrides an existing verb", () => {
      const f = new ToolLabelFormatter();
      f.setVerb("get", "Looking up");
      expect(f.formatOne("get_user")).toBe("Looking up user");
    });

    it("adds a new verb", () => {
      const f = new ToolLabelFormatter();
      f.setVerb("parse", "Parsing");
      expect(f.formatOne("parse_input")).toBe("Parsing input");
    });

    it("normalizes to lowercase", () => {
      const f = new ToolLabelFormatter();
      f.setVerb("GET", "Grabbing");
      expect(f.formatOne("get_stuff")).toBe("Grabbing stuff");
    });

    it("returns this for chaining", () => {
      const f = new ToolLabelFormatter();
      const result = f.setVerb("get", "A").setVerb("set", "B");
      expect(result).toBe(f);
    });
  });

  // ── setVerbs ──────────────────────────────────────────────

  describe("setVerbs", () => {
    it("replaces all verbs entirely", () => {
      const f = new ToolLabelFormatter();
      f.setVerbs({ fetch: "Fetching" });

      // New verb works
      expect(f.formatOne("fetch_data")).toBe("Fetching data");
      // Old defaults are gone — falls back to underscore replacement
      expect(f.formatOne("get_data")).toBe("Get data");
    });

    it("normalizes keys to lowercase", () => {
      const f = new ToolLabelFormatter();
      f.setVerbs({ LOAD: "Loading" });
      expect(f.formatOne("load_page")).toBe("Loading page");
    });

    it("returns this for chaining", () => {
      const f = new ToolLabelFormatter();
      expect(f.setVerbs({ a: "A" })).toBe(f);
    });
  });

  // ── random selection ──────────────────────────────────────

  describe("random label selection", () => {
    it("picks from multiple labels using Math.random", () => {
      const f = new ToolLabelFormatter({ get: ["Alpha", "Beta", "Gamma"] });

      vi.spyOn(Math, "random").mockReturnValue(0); // index 0
      expect(f.formatOne("get_data")).toBe("Alpha data");

      vi.mocked(Math.random).mockReturnValue(0.34); // index 1
      expect(f.formatOne("get_data")).toBe("Beta data");

      vi.mocked(Math.random).mockReturnValue(0.67); // index 2
      expect(f.formatOne("get_data")).toBe("Gamma data");

      vi.restoreAllMocks();
    });
  });
});
