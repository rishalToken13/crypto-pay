// src/lib/tron.js

export function isTronLinkReady() {
  return typeof window !== "undefined" && !!window.tronWeb && !!window.tronLink;
}

/**
 * Prompts TronLink to connect (shows popup if needed)
 * Returns { tronWeb, address }
 */
export async function connectTronLink() {
  if (!isTronLinkReady()) {
    throw new Error("TronLink not detected. Install TronLink extension / app.");
  }

  // Triggers connect prompt if not connected
  await window.tronLink.request({ method: "tron_requestAccounts" });

  const tronWeb = window.tronWeb;
  const address = tronWeb?.defaultAddress?.base58;

  if (!address) throw new Error("Wallet not connected/unlocked.");

  return { tronWeb, address };
}

/**
 * Creates a tronWeb contract instance
 */
export async function getContract(tronWeb, abi, address) {
  return tronWeb.contract(abi, address);
}

/**
 * Convert a string to bytes32 (0x...64 hex chars), padded right with zeros.
 * Use ONLY if your contract expects bytes32 for orderId/invoiceId.
 */
export function toBytes32(tronWeb, str) {
  const hex = tronWeb.toHex(String(str)); // "0x..."
  const no0x = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = (no0x + "0".repeat(64)).slice(0, 64);
  return "0x" + padded;
}

/**
 * Optional: basic network check using node host
 * Pass expected NETWORK like "nile" / "mainnet" if you want.
 */
export function assertNetwork(tronWeb, expectedNetwork) {
  if (!expectedNetwork) return;

  const host = tronWeb?.fullNode?.host || "";

  if (expectedNetwork === "nile" && !host.toLowerCase().includes("nile")) {
    throw new Error("Wrong network. Please switch to Nile Testnet in TronLink.");
  }

  // Mainnet nodes vary, but many use trongrid.
  if (expectedNetwork === "mainnet" && !host.toLowerCase().includes("trongrid")) {
    throw new Error("Wrong network. Please switch to Tron Mainnet in TronLink.");
  }
}

/**
 * UI helper
 */
export function shortAddr(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}
