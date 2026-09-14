/**
 * Integration test: the @noukai/agent loop end-to-end against a REAL relay and
 * the live Noukai server (design 20260903-SDK-agent-relay).
 *
 *   runAgentLoop (this package, real fetch)
 *     → a real Express relay built from the PUBLISHED @noukai/sdk
 *       (`noukaiRelayHandler` + a live `Noukai` client, keyholder)
 *         → live Noukai server (`agent-tools` fixture), driving the tool-call
 *           yield/resume loop, and back.
 *
 * This proves the agent framework works against the *published* @noukai/sdk —
 * not just against mocked fetch — including the keyless client→relay leg and the
 * pause/resume tool loop over the wire.
 *
 * Skipped unless NOUKAI_INTEGRATION_KEY + _PROJECT + _AGENT_SLUG are set
 * (see .env.example). Run with `pnpm test:integration`.
 */

import "dotenv/config";

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Noukai } from "@noukai/sdk";
import { noukaiRelayHandler } from "@noukai/sdk/adapters/express";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import type { ToolCall, ToolDefinition, ToolResult } from "../src/types";

const KEY = process.env.NOUKAI_INTEGRATION_KEY;
const PROJECT = process.env.NOUKAI_INTEGRATION_PROJECT;
const AGENT_SLUG = process.env.NOUKAI_INTEGRATION_AGENT_SLUG;
const ENV = (process.env.NOUKAI_ENV as "dev" | "production" | undefined) ?? "production";

const ready = !!KEY && !!PROJECT && PROJECT.includes("/") && !!AGENT_SLUG;

const GET_WEATHER: ToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "City name" } },
    required: ["location"],
  },
};

describe.skipIf(!ready)("@noukai/agent runAgentLoop (integration)", () => {
  let server: Server;
  let endpoint: string;

  beforeAll(() => {
    // PROJECT / KEY / AGENT_SLUG are guaranteed non-null by describe.skipIf(!ready).
    const [org, project] = PROJECT!.split("/", 2) as [string, string];
    const client = new Noukai({ apiKey: KEY!, org, project, env: ENV });

    const app = express();
    // No express.json(): the relay reads the RAW body and bounds bytes before
    // parse; a body-parser would consume the stream and break byte-bounding.
    app.post(
      "/agent/execute",
      noukaiRelayHandler({ client, org, project, slug: AGENT_SLUG!, authorize: () => Promise.resolve() }),
    );
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${String(port)}/agent/execute`;
  });

  afterAll(() => {
    server.close();
  });

  it(
    "drives the tool-call loop over the relay and returns a final message (message path)",
    async () => {
      let toolCalls = 0;
      const resolve = (call: ToolCall): ToolResult => {
        toolCalls += 1;
        return { toolCallId: call.id, result: "Sunny, 22°C." };
      };

      const result = await runAgentLoop("What is the weather in Tokyo?", {
        endpoint,
        tools: [GET_WEATHER],
        resolveToolCall: resolve,
      });

      // The tool loop actually ran over the relay (fixture forces a get_weather call)...
      expect(toolCalls).toBeGreaterThanOrEqual(1);
      // ...and the flow completed with a real answer relayed back verbatim.
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.content.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it(
    "drives the loop with structured messages[] (chat path)",
    async () => {
      let toolCalls = 0;
      const resolve = (call: ToolCall): ToolResult => {
        toolCalls += 1;
        return { toolCallId: call.id, result: "Sunny, 22°C." };
      };

      const result = await runAgentLoop("(ignored when messages is set)", {
        endpoint,
        tools: [GET_WEATHER],
        resolveToolCall: resolve,
        messages: [{ role: "user", content: "What is the weather in Berlin?" }],
      });

      expect(toolCalls).toBeGreaterThanOrEqual(1);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.content.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
