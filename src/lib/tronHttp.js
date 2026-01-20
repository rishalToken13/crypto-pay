// src/lib/tronHttp.js

const TRONGRID = import.meta.env.VITE_TRONGRID_URL || "https://nile.trongrid.io";

export async function getTxInfo(txid) {
  const res = await fetch(`${TRONGRID}/wallet/gettransactioninfobyid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: txid }),
  });

  if (!res.ok) {
    throw new Error(`TronGrid error (${res.status})`);
  }

  return res.json();
}

// Returns: "PENDING" | "SUCCESS" | "FAILED"
export async function waitForTxResult(txid, { timeoutMs = 60_000, intervalMs = 2500 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const info = await getTxInfo(txid);

    // If not found / not indexed yet, TronGrid often returns empty object
    const result = info?.receipt?.result;

    if (result === "SUCCESS") return "SUCCESS";
    if (result && result !== "SUCCESS") return "FAILED";

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return "PENDING";
}
