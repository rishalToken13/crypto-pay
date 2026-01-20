// src/components/PaymentScreen.jsx
import { useEffect, useMemo, useState } from "react";
import { PAYMENT, USDT, NETWORK } from "@/config";
import {
  connectTronLink,
  getContract,
  assertNetwork,
  shortAddr,
} from "@/lib/tron";
import { toTokenUnits } from "@/lib/units";
import { waitForTxResult } from "@/lib/tronHttp";
import { updateOrderStatus } from "@/lib/backend";

function readPaymentParams() {
  const params = new URLSearchParams(window.location.search);

  return {
    merchantName: params.get("merchant_name") || "",
    merchantId: params.get("merchant_id") || "", // bytes32 (0x...)
    merchantAddress: params.get("merchant_address") || "",

    orderId: params.get("order_id") || "", // bytes32 (0x...)
    invoiceId: params.get("invoice_id") || "", // bytes32 (0x...)

    price: params.get("amount") || "", // "15.00"
    token: (params.get("token") || "USDT").toUpperCase(),
  };
}

function isBytes32Hex(v) {
  return typeof v === "string" && v.startsWith("0x") && v.length === 66;
}

export default function PaymentScreen() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [wallet, setWallet] = useState(null);
  const [order, setOrder] = useState(null);

  function logMsg(msg) {
    setLog((l) => (l ? l + "\n" + msg : msg));
  }

  useEffect(() => {
    const o = readPaymentParams();
    setOrder(o);
  }, []);

  const validationError = useMemo(() => {
    if (!order) return "Loading...";

    if (!order.price || Number(order.price) <= 0) return "Invalid amount";
    if (!order.merchantAddress) return "Missing merchant_address in URL";

    // Contract expects bytes32 (already provided by backend)
    if (!isBytes32Hex(order.merchantId))
      return "Missing/invalid merchant_id (bytes32) in URL";
    if (!isBytes32Hex(order.orderId))
      return "Missing/invalid order_id (bytes32) in URL";
    if (!isBytes32Hex(order.invoiceId))
      return "Missing/invalid invoice_id (bytes32) in URL";

    // Token (demo: USDT only)
    if (order.token !== "USDT") return `Unsupported token in demo: ${order.token}`;

    return "";
  }, [order]);

  async function handlePayWithCrypto() {
    if (!order) return;

    try {
      setBusy(true);
      setLog("");

      if (validationError) {
        logMsg(`❌ ${validationError}`);
        return;
      }

      logMsg("Connecting to TronLink...");
      const { tronWeb, address } = await connectTronLink();
      setWallet(address);

      assertNetwork(tronWeb, NETWORK);
      logMsg(`Wallet connected: ${address}`);

      // ---- Token setup (USDT) ----
      const usdt = await getContract(tronWeb, USDT.abi, USDT.address);
      const decimals = Number(await usdt.decimals().call());
      const amountRaw = toTokenUnits(order.price, decimals);

      logMsg(`Amount: ${order.price} ${order.token}`);
      logMsg(`Amount (raw): ${amountRaw}`);

      // ---- Allowance check ----
      const allowance = await usdt.allowance(address, PAYMENT.address).call();
      logMsg(`Current allowance: ${allowance}`);

      if (BigInt(allowance) < BigInt(amountRaw)) {
        logMsg("Approval required. Sending approve()...");
        const approveTxid = await usdt
          .approve(PAYMENT.address, amountRaw)
          .send();
        logMsg(`✅ Approve tx: ${approveTxid}`);
      } else {
        logMsg("✅ Sufficient allowance. Skipping approve.");
      }

      // ---- Payment call: payTx(bytes32,bytes32,bytes32,address,uint256) ----
      const payment = await getContract(tronWeb, PAYMENT.abi, PAYMENT.address);

      logMsg("Calling payTx()...");

      const txid = await payment
        .payTx(order.merchantId, order.orderId, order.invoiceId, USDT.address, amountRaw)
        .send(); // token payment => msg.value=0

      logMsg(`✅ Payment txid: ${txid}`);
      logMsg("Waiting for chain confirmation...");

      // ---- Confirm on-chain status from FE ----
      const finalStatus = await waitForTxResult(txid, {
        timeoutMs: 90_000,
        intervalMs: 3_000,
      });

      logMsg(`Chain status: ${finalStatus}`);

      if (finalStatus === "PENDING") {
        logMsg("⚠️ Still pending. Please refresh later to confirm.");
        return;
      }

      // ---- Update backend DB ----
      logMsg("Updating backend DB...");
      const updated = await updateOrderStatus({
        txid,
        status: finalStatus, // SUCCESS / FAILED
        order_id: order.orderId,
        invoice_id: order.invoiceId,
      });

      logMsg("✅ Backend updated:");
      logMsg(JSON.stringify(updated, null, 2));
    } catch (err) {
      console.error(err);
      logMsg(`❌ Error: ${err?.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!order) {
    return (
      <div style={{ maxWidth: 700, margin: "0 auto", padding: 24 }}>
        <h2>Payment</h2>
        <p>Loading payment details...</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: 24 }}>
      <h2>Payment</h2>

      {/* Order Details */}
      <div style={{ border: "1px solid #ddd", padding: 16, borderRadius: 10 }}>
        <h3>Order Details</h3>

        <p>
          <b>Merchant:</b>{" "}
          {order.merchantName || shortAddr(order.merchantAddress)}
        </p>
        <p>
          <b>Amount:</b> {order.price} {order.token}
        </p>

        <p style={{ wordBreak: "break-all" }}>
          <b>Merchant ID:</b> {order.merchantId}
        </p>
        <p style={{ wordBreak: "break-all" }}>
          <b>Order ID:</b> {order.orderId}
        </p>
        <p style={{ wordBreak: "break-all" }}>
          <b>Invoice ID:</b> {order.invoiceId}
        </p>
        <p style={{ wordBreak: "break-all" }}>
          <b>Merchant Address:</b> {order.merchantAddress}
        </p>

        {wallet && (
          <p>
            <b>Wallet:</b> {shortAddr(wallet)}
          </p>
        )}

        {validationError ? (
          <p style={{ marginTop: 10, color: "crimson" }}>⚠️ {validationError}</p>
        ) : null}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button disabled style={{ opacity: 0.5 }}>
          Pay with Card
        </button>

        <button
          onClick={handlePayWithCrypto}
          disabled={busy || !!validationError}
          style={{
            background: "#111",
            color: "#fff",
            padding: "10px 16px",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy || validationError ? 0.6 : 1,
          }}
        >
          {busy ? "Processing..." : "Pay with Crypto"}
        </button>
      </div>

      {/* Log */}
      <pre
        style={{
          marginTop: 20,
          padding: 16,
          background: "#f7f7f7",
          borderRadius: 8,
          minHeight: 120,
          whiteSpace: "pre-wrap",
        }}
      >
        {log || "Logs will appear here..."}
      </pre>
    </div>
  );
}
