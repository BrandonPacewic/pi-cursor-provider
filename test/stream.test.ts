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
  console.log(process.env.TEST_MODELS ?? "auto - Auto");
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

type RequestOptions = {
  modelId?: string;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

type ProviderModelWithThinkingLevelMap = {
  id: string;
  thinkingLevelMap?: { xhigh?: string; max?: string };
};

const LUNA_MODELS = [
  "gpt-5.6-luna-none - GPT-5.6 Luna None",
  "gpt-5.6-luna-low - GPT-5.6 Luna Low",
  "gpt-5.6-luna-medium - GPT-5.6 Luna Medium",
  "gpt-5.6-luna-high - GPT-5.6 Luna High",
  "gpt-5.6-luna-xhigh - GPT-5.6 Luna Extra High",
  "gpt-5.6-luna-max - GPT-5.6 Luna Max",
].join("\n");

let pendingRun = Promise.resolve();

async function run(
  flags: Record<string, string | undefined> = {},
  context: unknown = { messages: [] },
  nextContext?: unknown,
  request: RequestOptions = {},
) {
  const previousRun = pendingRun;
  let release: (() => void) | undefined;
  pendingRun = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previousRun;
  try {
    return await runUnsafe(flags, context, nextContext, request);
  } finally {
    release?.();
  }
}

async function runUnsafe(
  flags: Record<string, string | undefined> = {},
  context: unknown = { messages: [] },
  nextContext?: unknown,
  request: RequestOptions = {},
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
    id: request.modelId ?? "auto",
  } as Parameters<typeof provider.streamSimple>[0];
  const collect = async (value: unknown) => {
    const streamOptions = request.reasoning
      ? ({ reasoning: request.reasoning } as unknown as Parameters<
          typeof streamSimple
        >[2])
      : undefined;
    const events = [];
    const stream = streamSimple(
      model,
      value as Parameters<typeof streamSimple>[1],
      streamOptions,
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
  return {
    args,
    events,
    prompt,
    models: (provider.models ?? []) as ProviderModelWithThinkingLevelMap[],
  };
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
  const path = prompt.match(/[^\s]*pi-cursor-provider-[^\s]+/u)?.[0];
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

test("advertises Cursor's discovered extended thinking levels", async () => {
  const { models } = await run({ TEST_MODELS: LUNA_MODELS, TEST_SUCCESS: "1" });
  const luna = models.find((model) => model.id === "gpt-5.6-luna");
  assert.ok(luna);
  assert.deepEqual(luna.thinkingLevelMap, {
    xhigh: "xhigh",
    max: "max",
  });
});

test("maps Luna's extended and off thinking levels to Cursor variants", async () => {
  const flags = { TEST_MODELS: LUNA_MODELS, TEST_SUCCESS: "1" };
  const modelId = "gpt-5.6-luna";

  const xhigh = await run(flags, undefined, undefined, {
    modelId,
    reasoning: "xhigh",
  });
  assert.equal(
    xhigh.args[xhigh.args.indexOf("--model") + 1],
    "gpt-5.6-luna-xhigh",
  );

  const max = await run(flags, undefined, undefined, {
    modelId,
    reasoning: "max",
  });
  assert.equal(max.args[max.args.indexOf("--model") + 1], "gpt-5.6-luna-max");

  const off = await run(flags, undefined, undefined, { modelId });
  assert.equal(off.args[off.args.indexOf("--model") + 1], "gpt-5.6-luna-none");
});
