// src/lib/backend.js

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

export async function updateOrderStatus({ txid, status, order_id, invoice_id }) {
  const res = await fetch(`${BACKEND}/api/orders/update-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txid, status, order_id, invoice_id }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `Update failed (${res.status})`);
  }
  return json.data;
}
