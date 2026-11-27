/**
 * Strict loopback RPC URL check shared by the deploy tooling and the development-only
 * time-advance helper (mirrors the frontend manifest rule).
 *
 * Accepted: exactly "http://127.0.0.1:<port>" or "http://localhost:<port>", port 1-65535,
 * with no path, query, fragment or credentials. Everything else is refused, including
 * HTTPS, other hosts, IPv6, shorthand or encoded IPv4 forms ("127.1", "2130706433"),
 * trailing dots, and look-alikes such as "127.0.0.1.example.com" or "localhost@example.com".
 * Being strict keeps the rule easy to review; it costs nothing for a local-only project.
 */
const LOOPBACK_RPC = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})$/;

function isLoopbackRpcUrl(url) {
  if (typeof url !== "string") return false;
  const m = LOOPBACK_RPC.exec(url);
  if (!m) return false;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== m[1]) return false;
  // Defence in depth: the WHATWG parser must agree on host and port, with no credentials.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === m[1] &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

module.exports = { isLoopbackRpcUrl };
