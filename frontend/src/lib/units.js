// Exact token-unit handling. Financial values are bigint base units end to end; strings are
// parsed with ethers.parseUnits and only formatted for display. No floating point.
import { formatUnits, parseUnits } from "ethers";

export const DECIMALS = 18;
export const TOKENS_PER_ETH = 100n;
export const TOTAL_SUPPLY = 1_000_000n * 10n ** 18n;
export const FEE_BPS = 100n;
export const BPS = 10_000n;
export const MIN_DURATION = 60n;
export const MAX_DURATION = 365n * 24n * 60n * 60n;
export const MAX_NAME_BYTES = 64;
export const MAX_DESCRIPTION_BYTES = 500;

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;

/**
 * Parse a user-entered decimal amount into base units.
 * Accepts only plain decimals (no sign, exponent, spaces or separators).
 * @returns {{ value: bigint } | { error: string }}
 */
export function parseAmount(raw, { decimals = DECIMALS, allowZero = false } = {}) {
  const s = String(raw ?? "").trim();
  if (s === "") return { error: "Enter an amount." };
  const m = DECIMAL.exec(s);
  if (!m) return { error: "Use digits with an optional decimal point (no signs, exponents or separators)." };
  if (m[1] && m[1].length > decimals) return { error: `Use at most ${decimals} decimal places.` };
  const value = parseUnits(s, decimals);
  if (!allowZero && value === 0n) return { error: "The amount must be greater than zero." };
  return { value };
}

function trimZeros(s) {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Format base units for display without losing precision. */
export function formatUnitsExact(value, decimals = DECIMALS) {
  return trimZeros(formatUnits(value, decimals));
}

export const formatKT = (value) => `${formatUnitsExact(value)} KT`;
export const formatEth = (value) => `${formatUnitsExact(value)} ETH`;

/** KT base units bought for a given wei amount (exact). */
export const ktForWei = (wei) => wei * TOKENS_PER_ETH;

/** Platform fee and creator share for a successful total (mirrors the contract, exact). */
export function settlementSplit(total) {
  const fee = (total * FEE_BPS) / BPS;
  return { fee, creator: total - fee };
}

/** UTF-8 byte length (the unit the contract enforces for names and descriptions). */
export const utf8Length = (s) => new TextEncoder().encode(String(s)).length;

/**
 * Total duration in seconds from day/hour/minute fields (non-negative integers).
 * @returns {{ value: bigint } | { error: string }}
 */
export function parseDuration({ days = "0", hours = "0", minutes = "0" }) {
  const parts = { days, hours, minutes };
  for (const [k, v] of Object.entries(parts)) {
    if (!INTEGER.test(String(v).trim())) return { error: `${k} must be a whole number.` };
  }
  const value =
    BigInt(String(days).trim()) * 86_400n + BigInt(String(hours).trim()) * 3_600n + BigInt(String(minutes).trim()) * 60n;
  if (value < MIN_DURATION) return { error: "The duration must be at least 60 seconds (1 minute)." };
  if (value > MAX_DURATION) return { error: "The duration must be at most 365 days." };
  return { value };
}

export function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

/** Chain timestamps are seconds (bigint or number); display in the viewer's locale. */
export function formatTimestamp(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString();
}

export function formatRemaining(deadline, now) {
  const left = BigInt(deadline) - BigInt(now);
  if (left <= 0n) return "Deadline reached";
  const d = left / 86_400n;
  const h = (left % 86_400n) / 3_600n;
  const m = (left % 3_600n) / 60n;
  const s = left % 60n;
  if (d > 0n) return `${d}d ${h}h left`;
  if (h > 0n) return `${h}h ${m}m left`;
  return `${m}m ${s}s left`;
}
