// src/lib/confirm.js
export async function confirmOrder({ txid, order_id, invoice_id }) {
  const res = await fetch("http://localhost:3000/api/orders/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txid, order_id, invoice_id }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `Confirm failed (${res.status})`);
  }
  return json.data;
}
