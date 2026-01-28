// src/components/PaymentScreen.jsx
import { useEffect, useMemo, useState } from "react";
import { PAYMENT, USDT, NETWORK } from "@/config";
import { connectTronLink, getContract, assertNetwork, shortAddr } from "@/lib/tron";
import { toTokenUnits } from "@/lib/units";
import { waitForTxResult } from "@/lib/tronHttp";

function isBytes32Hex(v) {
  return typeof v === "string" && v.startsWith("0x") && v.length === 66;
}

function isBytesHex(v) {
  return typeof v === "string" && v.startsWith("0x") && v.length >= 4 && v.length % 2 === 0;
}

function safeTrim(v) {
  return typeof v === "string" ? v.trim() : "";
}

export default function PaymentScreen() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [wallet, setWallet] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState("IDLE"); // IDLE | PROCESSING | SUCCESS | FAILED | PENDING

  // Inputs
  const [merchantId, setMerchantId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState(""); // "15.00"
  const [deadline, setDeadline] = useState("0"); // uint256 as string
  const [signature, setSignature] = useState(""); // 0x...

  function logMsg(msg) {
    setLog((l) => (l ? l + "\n" + msg : msg));
  }

  // Optional: prefill some defaults for quick testing
  useEffect(() => {
    // setMerchantId("0x...");
    // setOrderId("0x...");
    // setInvoiceId("0x...");
    // setAmount("15.00");
    // setDeadline("0");
    // setSignature("0x...");
  }, []);

  const validationError = useMemo(() => {
    if (!amount || Number(amount) <= 0) return "Invalid amount";
    if (!isBytes32Hex(merchantId)) return "Invalid merchantId (bytes32 hex 0x + 64 chars)";
    if (!isBytes32Hex(orderId)) return "Invalid orderId (bytes32 hex 0x + 64 chars)";
    if (!isBytes32Hex(invoiceId)) return "Invalid invoiceId (bytes32 hex 0x + 64 chars)";

    // deadline can be 0 or a positive integer string
    try {
      if (deadline === "" || deadline == null) return "Deadline is required (use 0 to disable)";
      const d = BigInt(deadline);
      if (d < 0n) return "Deadline must be >= 0";
    } catch {
      return "Invalid deadline (must be integer)";
    }

    if (!signature) return "Signature is required";
    if (!isBytesHex(signature)) return "Invalid signature (must be 0x hex bytes)";

    return "";
  }, [merchantId, orderId, invoiceId, amount, deadline, signature]);

  async function handlePayWithCrypto() {
    try {
      setBusy(true);
      setPaymentStatus("PROCESSING");
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
      const amountRaw = toTokenUnits(amount, decimals);

      logMsg(`Token: USDT`);
      logMsg(`Amount: ${amount} USDT`);
      logMsg(`Amount (raw): ${amountRaw}`);
      logMsg(`Deadline: ${deadline}`);
      logMsg(`Signature: ${signature.slice(0, 14)}...`);

      // ---- Allowance check ----
      const allowance = await usdt.allowance(address, PAYMENT.address).call();
      logMsg(`Current allowance: ${allowance}`);

      if (BigInt(allowance) < BigInt(amountRaw)) {
        logMsg("Approval required. Sending approve()...");
        const approveTxid = await usdt.approve(PAYMENT.address, amountRaw).send();
        logMsg(`✅ Approve tx: ${approveTxid}`);
      } else {
        logMsg("✅ Sufficient allowance. Skipping approve.");
      }

      // ---- Payment call ----
      const payment = await getContract(tronWeb, PAYMENT.abi, PAYMENT.address);

      logMsg("Calling payTx()...");

      // payTx(bytes32,bytes32,bytes32,address,uint256,uint256,bytes)
      const txid = await payment
        .payTx(merchantId, orderId, invoiceId, USDT.address, amountRaw, deadline, signature)
        .send(); // token payment => msg.value=0

      logMsg(`✅ Payment txid: ${txid}`);
      logMsg("Waiting for chain confirmation...");

      // ---- Confirm on-chain status ----
      const finalStatus = await waitForTxResult(txid, {
        timeoutMs: 90_000,
        intervalMs: 3_000,
      });

      logMsg(`Chain status: ${finalStatus}`);

      if (finalStatus === "SUCCESS") {
        setPaymentStatus("SUCCESS");
        logMsg("🎉 Payment successful on-chain!");
      } else if (finalStatus === "FAILED") {
        setPaymentStatus("FAILED");
        logMsg("❌ Payment failed on-chain.");
      } else {
        // PENDING or unknown status
        setPaymentStatus("PENDING");
        logMsg("⚠️ Transaction still pending. Please refresh later to confirm.");
      }

      // ---- Optional: persist locally (frontend-only) ----
      try {
        localStorage.setItem(
          `payment:${txid}`,
          JSON.stringify({
            merchantId,
            orderId,
            invoiceId,
            amount,
            amountRaw: String(amountRaw),
            status: finalStatus,
            wallet: address,
            ts: Date.now(),
          })
        );
      } catch {
        // ignore storage errors
      }
    } catch (err) {
      console.error(err);
      // Don't blindly mark FAILED unless you want to treat any error as failed UX.
      setPaymentStatus("FAILED");
      logMsg(`❌ Error: ${err?.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <h2>Payment</h2>

      {/* Inputs */}
      <div style={{ border: "1px solid #ddd", padding: 16, borderRadius: 10 }}>
        <h3>Enter Payment Data</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
          <label>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Merchant ID (bytes32)</div>
            <input
              value={merchantId}
              onChange={(e) => setMerchantId(safeTrim(e.target.value))}
              placeholder="0x..."
              style={{ width: "100%", padding: 10 }}
            />
          </label>

          <label>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Order ID (bytes32)</div>
            <input
              value={orderId}
              onChange={(e) => setOrderId(safeTrim(e.target.value))}
              placeholder="0x..."
              style={{ width: "100%", padding: 10 }}
            />
          </label>

          <label>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Invoice ID (bytes32)</div>
            <input
              value={invoiceId}
              onChange={(e) => setInvoiceId(safeTrim(e.target.value))}
              placeholder="0x..."
              style={{ width: "100%", padding: 10 }}
            />
          </label>

          <label>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Amount (USDT)</div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="15.00"
              inputMode="decimal"
              style={{ width: "100%", padding: 10 }}
            />
          </label>

          <label>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Deadline (uint256)</div>
            <input
              value={deadline}
              onChange={(e) => setDeadline(safeTrim(e.target.value))}
              placeholder="0"
              inputMode="numeric"
              style={{ width: "100%", padding: 10 }}
            />
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              Use <b>0</b> to disable deadline, or pass a unix timestamp (seconds).
            </div>
          </label>

          <label>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Signature (bytes)</div>
            <textarea
              value={signature}
              onChange={(e) => setSignature(safeTrim(e.target.value))}
              placeholder="0x..."
              rows={3}
              style={{ width: "100%", padding: 10, fontFamily: "monospace" }}
            />
          </label>

          {wallet && (
            <div>
              <b>Wallet:</b> {shortAddr(wallet)}
            </div>
          )}

          {validationError ? (
            <p style={{ marginTop: 10, color: "crimson" }}>⚠️ {validationError}</p>
          ) : null}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button disabled style={{ opacity: 0.5 }}>
          Pay with Card
        </button>

        <button
          onClick={handlePayWithCrypto}
          disabled={busy || !!validationError || paymentStatus === "SUCCESS"}
          style={{
            background: paymentStatus === "SUCCESS" ? "#16a34a" : "#111",
            color: "#fff",
            padding: "10px 16px",
            cursor: busy || paymentStatus === "SUCCESS" ? "not-allowed" : "pointer",
            opacity: busy || validationError ? 0.6 : 1,
          }}
        >
          {paymentStatus === "SUCCESS" ? "Paid ✅" : busy ? "Processing..." : "Pay with Crypto"}
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
