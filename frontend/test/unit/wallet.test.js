// EIP-6963 discovery: announced providers, window.ethereum fallback, none. Test-only fakes.
import { describe, expect, it } from "vitest";
import { discoverWallets } from "../../src/lib/wallet.js";

function fakeWindow({ announce = [], injected = null } = {}) {
  const target = new EventTarget();
  target.ethereum = injected;
  target.addEventListener("eip6963:requestProvider", () => {
    for (const detail of announce) target.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail }));
  });
  return target;
}
const provider = () => ({ request: async () => [] });

describe("wallet discovery", () => {
  it("returns every announced EIP-6963 provider (deduplicated by uuid) and ignores malformed ones", async () => {
    const p1 = provider();
    const win = fakeWindow({
      announce: [
        { info: { uuid: "a", name: "A" }, provider: p1 },
        { info: { uuid: "b", name: "B" }, provider: provider() },
        { info: { uuid: "a", name: "A again" }, provider: p1 },
        { info: { name: "no uuid" }, provider: provider() },
        { info: { uuid: "c", name: "no request" }, provider: {} },
      ],
      injected: provider(),
    });
    const list = await discoverWallets({ win, timeoutMs: 10 });
    expect(list.map((w) => w.info.uuid)).toEqual(["a", "b"]);
  });

  it("falls back to window.ethereum only when nothing is announced", async () => {
    const injected = provider();
    const list = await discoverWallets({ win: fakeWindow({ injected }), timeoutMs: 10 });
    expect(list).toHaveLength(1);
    expect(list[0].provider).toBe(injected);
    expect(list[0].info.uuid).toBe("injected");
  });

  it("returns an empty list without any wallet or window", async () => {
    expect(await discoverWallets({ win: fakeWindow(), timeoutMs: 10 })).toEqual([]);
    expect(await discoverWallets({ win: undefined })).toEqual([]);
  });
});
