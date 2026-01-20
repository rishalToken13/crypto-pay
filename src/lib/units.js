// src/lib/units.js

/**
 * Convert human-readable token amount → raw integer units
 * Example:
 *   toTokenUnits("10.25", 6) => "10250000"
 */
export function toTokenUnits(amount, decimals) {
  if (amount === null || amount === undefined) {
    throw new Error("Invalid amount");
  }

  const value = String(amount);

  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid numeric amount: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  const paddedFraction = (fraction + "0".repeat(decimals)).slice(0, decimals);

  const raw = whole + paddedFraction;
  return raw.replace(/^0+(?=\d)/, "") || "0";
}

/**
 * Convert raw units → human-readable string
 * Example:
 *   fromTokenUnits("10250000", 6) => "10.25"
 */
export function fromTokenUnits(raw, decimals) {
  const rawStr = String(raw).replace(/^0+/, "") || "0";

  if (decimals === 0) return rawStr;

  const padded = rawStr.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}
