import test from "node:test";
import assert from "node:assert/strict";

import { createFrankfurterClient } from "../src/fx/frankfurter.js";

test("fx: returns rate for a day with available quote", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        amount: 1,
        base: "JPY",
        date: "2025-01-13",
        rates: { MXN: 0.12345 }
      })
    };
  };

  const client = createFrankfurterClient({ fetchFn, nowFn: () => 1000 });
  const out = await client.getFxRate({ date: "2025-01-13", base: "jpy", quote: "mxn" });

  assert.deepEqual(out, {
    ok: true,
    date: "2025-01-13",
    base: "JPY",
    quote: "MXN",
    rate: 0.12345,
    provider: "frankfurter"
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /2025-01-13\?base=JPY&symbols=MXN$/);
});

test("fx: falls back to previous UTC date when rate is missing", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes("/2025-01-12?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ base: "JPY", date: "2025-01-12", rates: {} })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ base: "JPY", date: "2025-01-11", rates: { MXN: 0.12 } })
    };
  };

  const client = createFrankfurterClient({ fetchFn, nowFn: () => 2000 });
  const out = await client.getFxRate({ date: "2025-01-12", base: "JPY", quote: "MXN" });

  assert.equal(out.rate, 0.12);
  assert.equal(out.date, "2025-01-11");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /2025-01-12\?base=JPY&symbols=MXN$/);
  assert.match(calls[1], /2025-01-11\?base=JPY&symbols=MXN$/);
});

test("fx: throws and logs for network/non-2xx errors", async () => {
  const logs = [];

  const failingNetworkClient = createFrankfurterClient({
    fetchFn: async () => {
      throw new Error("network down");
    },
    logError: (event) => logs.push(event)
  });

  await assert.rejects(
    () => failingNetworkClient.getFxRate({ date: "2025-01-13", base: "JPY", quote: "MXN" }),
    /request failed: network down/
  );

  assert.equal(logs[0].type, "fx_error");
  assert.equal(logs[0].provider, "frankfurter");

  const non2xxLogs = [];
  const non2xxClient = createFrankfurterClient({
    fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    logError: (event) => non2xxLogs.push(event)
  });

  await assert.rejects(
    () => non2xxClient.getFxRate({ date: "2025-01-13", base: "JPY", quote: "MXN" }),
    /HTTP 500/
  );

  assert.equal(non2xxLogs[0].status, 500);
  assert.equal(non2xxLogs[0].date, "2025-01-13");
});

test("fx: cache hit avoids second fetch", async () => {
  let now = 10_000;
  let fetchCalls = 0;
  const client = createFrankfurterClient({
    nowFn: () => now,
    fetchFn: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ base: "JPY", date: "2025-01-13", rates: { MXN: 0.11 } })
      };
    }
  });

  const first = await client.getFxRate({ date: "2025-01-13", base: "JPY", quote: "MXN" });
  now += 60_000;
  const second = await client.getFxRate({ date: "2025-01-13", base: "JPY", quote: "MXN" });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(second, first);
});
