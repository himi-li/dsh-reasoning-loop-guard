/**
 * reasoning-loop-guard — end-to-end fake provider (TEST ONLY).
 *
 * Registers a real LLM adapter on the real `llm` service so that a real agent
 * loop drives a real provider stream. The stream it serves is a degenerate
 * reasoning blob from `test/fixtures/degenerate.json` (the entry that trips the
 * guard soonest), followed by a short text block so the unguarded run can still
 * finish normally.
 *
 * The point of the exercise: prove that `dsh-reasoning-loop-guard`, mounted
 * through its own shipped `cordis.patch.yml`, cuts this stream inside a live
 * agent loop — and that the identical stream completes untouched when the guard
 * is off.
 *
 * Env:
 *   TG_FAKE_FIXTURES directory holding degenerate.json (default: the repo copy)
 *   TG_FAKE_FIXTURE  index into degenerate.json (default: the fastest-firing one)
 *   TG_FAKE_CHUNK    reasoning-delta size in characters (default 40)
 *   TG_FAKE_TEXT     text block emitted after the reasoning (default "TG-FAKE-OK")
 */
import { readFileSync } from "node:fs";

export const name = "tg-fake-provider";
export const inject = ["llm"];

const PROVIDER = "tg-fake";
const MODEL = "tg-fake-model";

/**
 * Fixture that trips the guard soonest, measured with `e2e/pick-fixture.mjs`
 * (index 5: 7659 characters, fires at 3072 with `periodic-run units=6 period=64`).
 */
const FIXTURE_INDEX = Number(process.env.TG_FAKE_FIXTURE ?? 5);

function fixture() {
  // The package is copied into a profile's node_modules, so the fixture
  // directory is addressed explicitly (env override first, then the repo path).
  const dir =
    process.env.TG_FAKE_FIXTURES ?? new URL("../../test/fixtures/", import.meta.url).pathname.replace(/^\//u, "");
  const rows = JSON.parse(readFileSync(`${dir}/degenerate.json`, "utf8"));
  const row = rows[FIXTURE_INDEX];
  if (row === undefined) throw new Error(`tg-fake: no fixture at index ${FIXTURE_INDEX}`);
  return { row, rows: rows.length };
}

const adapter = {
  providerInfo(provider) {
    return { id: provider, name: "Reasoning Loop Guard E2E Fake" };
  },

  /** The runtime calls this unconditionally, so it must exist even as undefined. */
  providerRetryPolicy(_provider) {
    return undefined;
  },

  /** Likewise: called for pricing bookkeeping. */
  imageRequestPricing(_provider, _model) {
    return undefined;
  },

  listModels(_provider) {
    return Promise.resolve([modelInfo(PROVIDER, MODEL)]);
  },

  resolveModel(provider, model) {
    return Promise.resolve(modelInfo(provider, model));
  },

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    };
  },

  /**
   * Serve the degenerate reasoning, then a short text block. Both the guard
   * (which breaks out early) and the loop itself rely on `return()` being
   * honoured, so the body is a plain async generator.
   */
  async *stream(options) {
    const { row, rows } = fixture();
    const chunkSize = Number(process.env.TG_FAKE_CHUNK ?? 40);
    const text = process.env.TG_FAKE_TEXT ?? "TG-FAKE-OK";
    let served = 0;
    let completed = false;
    process.stderr.write(
      `tg-fake: serving degenerate fixture index=${FIXTURE_INDEX} (of ${rows}) len=${row.text.length} seq=${row.seq} turn=${row.turn} step=${row.step} chunk=${chunkSize}\n`,
    );
    try {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      for (let at = 0; at < row.text.length; at += chunkSize) {
        if (options.signal?.aborted === true) return;
        const piece = row.text.slice(at, at + chunkSize);
        served += piece.length;
        yield { type: "reasoning-delta", index: 0, text: piece };
      }
      yield { type: "block-end", index: 0, block: { type: "reasoning", text: row.text } };

      yield { type: "block-start", index: 1, blockType: "text" };
      yield { type: "text-delta", index: 1, text };
      yield { type: "block-end", index: 1, block: { type: "text", text } };

      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: "finish", reason: { kind: "stop" } };
      completed = true;
    } finally {
      // The number that decides the experiment: a guard that fires stops the
      // upstream generator early, so `served` stays far below the fixture size.
      process.stderr.write(
        `tg-fake: SERVED=${served}/${row.text.length} completed=${completed} aborted=${options.signal?.aborted === true}\n`,
      );
    }
  },
};

/** Model descriptor shared by `listModels` and `resolveModel`. */
function modelInfo(provider, model) {
  return {
    provider,
    id: model,
    name: "TG Fake Model",
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 8192,
    reasoning: {
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
        { id: "max", name: "Max" },
      ],
      defaultEffort: "high",
    },
  };
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], adapter);
}
