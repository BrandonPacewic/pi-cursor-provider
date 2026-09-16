import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@mariozechner/pi-coding-agent";
import extension from "../index.js";

const cli = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("models")) {
  console.log("auto - Auto");
} else {
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
    writeFileSync(process.env.PROMPT_FILE, prompt);
    const resumeFailed = process.env.TEST_RESUME_FAIL && process.argv.includes("--resume");
    if (process.env.TEST_MALFORMED) console.log("not-json");
    else if (!process.env.TEST_EMPTY && !resumeFailed) console.log(JSON.stringify({ type: "assistant", session_id: "chat-1", timestamp_ms: 1, message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }));
    if (process.env.TEST_HANG) setInterval(() => {}, 1_000);
    else process.exitCode = process.env.TEST_SUCCESS && !resumeFailed ? 0 : 1;
  });
}
`;

async function run(
  flags: Record<string, string | undefined> = {},
  context: unknown = { messages: [] },
  nextContext?: unknown,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cursor-provider-test-"));
  const agentPath = join(dir, "agent.mjs");
  const argsPath = join(dir, "args.json");
  const promptPath = join(dir, "prompt.txt");
  await writeFile(agentPath, cli);
  await chmod(agentPath, 0o755);

  const envKeys = [
    "CURSOR_AGENT_PATH",
    "ARGS_FILE",
    "PROMPT_FILE",
    ...Object.keys(flags),
  ];
  const saved = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    CURSOR_AGENT_PATH: agentPath,
    ARGS_FILE: argsPath,
    PROMPT_FILE: promptPath,
    ...flags,
  });
  for (const [key, value] of Object.entries(flags))
    if (value === undefined) delete process.env[key];

  let provider: ProviderConfig | undefined;
  await extension({
    registerProvider: (_name: string, config: ProviderConfig) => {
      provider = config;
    },
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI);
  assert.ok(provider?.streamSimple);
  const streamSimple = provider.streamSimple;
  const model = {
    api: "cursor-cli",
    provider: "cursor",
    id: "auto",
  } as Parameters<typeof provider.streamSimple>[0];
  const collect = async (value: unknown) => {
    const events = [];
    const stream = streamSimple(
      model,
      value as Parameters<typeof streamSimple>[1],
    );
    for await (const event of stream) events.push(event);
    return events;
  };
  let events = await collect(context);
  if (nextContext) events = await collect(nextContext);

  const args = JSON.parse(await readFile(argsPath, "utf8"));
  const prompt = await readFile(promptPath, "utf8");
  await rm(dir, { recursive: true, force: true });
  Object.assign(process.env, saved);
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
  return { args, events, prompt };
}

test("safe defaults omit write and trust flags and surface a partial-output failure", async () => {
  const { args, events } = await run({
    CURSOR_AGENT_FORCE: undefined,
    CURSOR_AGENT_TRUST: undefined,
    CURSOR_API_KEY: "secret",
  });
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--trust"), false);
  assert.equal(args.includes("--approve-mcps"), false);
  assert.equal(args.includes("secret"), false);
  const lastEvent = events.at(-1);
  assert.ok(lastEvent);
  assert.equal(lastEvent.type, "error");
});

test("timed-out requests return an error", async () => {
  const started = Date.now();
  const { events } = await run({
    CURSOR_AGENT_TIMEOUT_MS: "1000",
    TEST_HANG: "1",
  });
  assert.ok(Date.now() - started < 7_000);
  const lastEvent = events.at(-1);
  assert.ok(lastEvent);
  assert.equal(lastEvent.type, "error");
});

test("inline images are removed after the CLI finishes", async () => {
  const { prompt } = await run(
    {},
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
        },
      ],
    },
  );
  const path = prompt.match(/\/tmp\/pi-cursor-provider-[^\s]+/u)?.[0];
  assert.ok(path);
  await assert.rejects(access(path));
});

test("successful turns resume the Cursor chat with only the latest user message", async () => {
  const { args, prompt } = await run(
    { TEST_SUCCESS: "1" },
    { messages: [{ role: "user", content: "first" }] },
    {
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
        },
        { role: "user", content: "second" },
      ],
    },
  );
  assert.deepEqual(args.slice(-2), ["--resume", "chat-1"]);
  assert.equal(prompt, "second");
});

test("a failed resume retries once with the full Pi context", async () => {
  const { args, events, prompt } = await run(
    { TEST_SUCCESS: "1", TEST_RESUME_FAIL: "1" },
    { messages: [{ role: "user", content: "first" }] },
    {
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
        },
        { role: "user", content: "second" },
      ],
    },
  );
  assert.equal(args.includes("--resume"), false);
  assert.match(prompt, /\[User\]\nfirst/);
  assert.match(prompt, /\[User\]\nsecond/);
  assert.equal(events.at(-1)?.type, "done");
});

test("successful empty output is reported as an error", async () => {
  const { events } = await run({ TEST_SUCCESS: "1", TEST_EMPTY: "1" });
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.match(
    last?.type === "error" ? last.error.errorMessage ?? "" : "",
    /no assistant output/,
  );
});

test("malformed output is reported as a protocol error", async () => {
  const { events } = await run({ TEST_SUCCESS: "1", TEST_MALFORMED: "1" });
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.match(
    last?.type === "error" ? last.error.errorMessage ?? "" : "",
    /malformed stream lines/,
  );
});

test("explicit flags enable write and trust", async () => {
  const { args } = await run({
    CURSOR_AGENT_FORCE: "1",
    CURSOR_AGENT_TRUST: "1",
  });
  assert.equal(args.includes("--force"), true);
  assert.equal(args.includes("--trust"), true);
  assert.equal(args.includes("--approve-mcps"), true);
});
