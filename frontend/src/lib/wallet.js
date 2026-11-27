// EIP-1193 wallet discovery: EIP-6963 announcements first, then window.ethereum as a fallback.
// The app never requests or stores seed phrases or private keys.

export function discoverWallets({ timeoutMs = 250, win = globalThis.window } = {}) {
  return new Promise((resolve) => {
    if (!win) return resolve([]);
    const found = new Map();
    const onAnnounce = (event) => {
      const { info, provider } = event.detail ?? {};
      if (info?.uuid && provider?.request) found.set(info.uuid, { info, provider });
    };
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      win.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()];
      if (list.length === 0 && win.ethereum?.request) {
        list.push({ info: { uuid: "injected", name: "Browser wallet", rdns: "injected" }, provider: win.ethereum });
      }
      resolve(list);
    }, timeoutMs);
  });
}
