// src/components/PaymentScreen.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { PAYMENT, USDT, NETWORK } from "@/config";
import { connectTronLink, getContract, assertNetwork, shortAddr } from "@/lib/tron";
import { toTokenUnits } from "@/lib/units";
import { waitForTxResult } from "@/lib/tronHttp";
// import { updateOrderStatus } from "@/lib/backend";

function isBytes32Hex(v) {
  return typeof v === "string" && v.startsWith("0x") && v.length === 66;
}



/**
 * Map backend API response => UI order shape expected by this screen.
 * Update keys here if your API response differs.
 */
function mapApiOrderToUI(api) {
  console.log({api})
  const { data } = api
  return {
    merchantName: data.merchant_name || "",
    merchantId: data.merchant_id || "",
    merchantAddress: data.merchant_address || "",

    orderId: data.order_id || "",
    invoiceId: data.invoice_id || "",
    price: String(data.amount ?? data.price ?? ""),

    // token address (base58, starts with "T") returned by backend
    tokenAddress: data.token || USDT.address,
    tokenSymbol: (data.token_symbol || "USDT").toUpperCase(),
    deadline: data.deadline || 0,
    signature: data.signature || "",
  };
}

export default function PaymentScreen() {
  const { orderId } = useParams(); // route: /:orderId

  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL; 

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [wallet, setWallet] = useState(null);
  const [order, setOrder] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState("IDLE");
  const [loadingOrder, setLoadingOrder] = useState(true);

  function logMsg(msg) {
    setLog((l) => (l ? l + "\n" + msg : msg));
  }

  // 1) Load order details from backend using :orderId
  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setLoadingOrder(true);
        setPaymentStatus("IDLE");
        setLog("");

        if (!orderId) {
          setOrder(null);
          logMsg("❌ Missing orderId in route");
          return;
        }

        if (!API_BASE_URL) {
          throw new Error("VITE_API_BASE_URL is not defined in .env");
        }

        const url = `${API_BASE_URL}/${orderId}`;
        logMsg(`Fetching order: ${orderId}`);
        logMsg(`POST ${url}`);

        const res = await fetch(url, {
          method: "POST",
          headers: { accept: "application/json" },
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Order fetch failed (${res.status}): ${text || res.statusText}`
          );
        }

        const apiData = await res.json();
        const mapped = mapApiOrderToUI(apiData);

        if (!alive) return;

        setOrder(mapped);
        logMsg("✅ Order loaded");
        logMsg(JSON.stringify(mapped, null, 2));
      } catch (err) {
        if (!alive) return;
        setOrder(null);
        logMsg(`❌ Failed to load order: ${err?.message || String(err)}`);
      } finally {
        if (alive) setLoadingOrder(false);
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [orderId, API_BASE_URL]);

  const validationError = useMemo(() => {
    if (loadingOrder) return "Loading...";
    if (!order) return "Order not found / failed to load";

    if (!order.price || Number(order.price) <= 0) return "Invalid amount";

    if (!order.deadline || Number(order.deadline) <= 0) return "Missing/invalid deadline";
    if (!order.signature || !order.signature.startsWith("0x")) return "Missing/invalid signature";


    if (!isBytes32Hex(order.merchantId)) return "Missing/invalid merchant_id (bytes32)";
    if (!isBytes32Hex(order.orderId)) return "Missing/invalid order_id (bytes32)";
    if (!isBytes32Hex(order.invoiceId)) return "Missing/invalid invoice_id (bytes32)";

    if (!order.tokenAddress || typeof order.tokenAddress !== "string") {
      return "Missing token address";
    }

    return "";
  }, [order, loadingOrder]);

  async function handlePayWithCrypto() {
    if (!order) return;

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

      // ---- Token setup (token address from backend) ----
      // NOTE: using USDT.abi for TRC20 basic calls (decimals/allowance/approve)
      const token = await getContract(tronWeb, USDT.abi, order.tokenAddress);
      const decimals = Number(await token.decimals().call());
      const amountRaw = toTokenUnits(order.price, decimals);

      logMsg(`Token: ${order.tokenSymbol || "TOKEN"} (${order.tokenAddress})`);
      logMsg(`Amount: ${order.price}`);
      logMsg(`Amount (raw): ${amountRaw}`);

      // ---- Allowance check ----
      const allowance = await token.allowance(address, PAYMENT.address).call();
      logMsg(`Current allowance: ${allowance}`);

      if (BigInt(allowance) < BigInt(amountRaw)) {
        logMsg("Approval required. Sending approve()...");
        const approveTxid = await token.approve(PAYMENT.address, amountRaw).send();
        logMsg(`✅ Approve tx: ${approveTxid}`);
      } else {
        logMsg("✅ Sufficient allowance. Skipping approve.");
      }

      // ---- Payment call: payTx(bytes32,bytes32,bytes32,address,uint256) ----
      const payment = await getContract(tronWeb, PAYMENT.abi, PAYMENT.address);

      logMsg("Calling payTx()...");

      const txBuilder = payment.payTx(
            order.merchantId,
            order.orderId,
            order.invoiceId,
            order.tokenAddress,
            amountRaw,
            order.deadline,
            order.signature
        );

      const txid = await txBuilder.send(); // token payment => msg.value=0

      logMsg(`✅ Payment txid: ${txid}`);
      logMsg("Waiting for chain confirmation...");

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
    //   const updated = await updateOrderStatus({
    //     txid,
    //     status: finalStatus, // SUCCESS / FAILED
    //     order_id: order.orderId,
    //     invoice_id: order.invoiceId,
    //   });

      console.log({finalStatus})

      if (finalStatus === "SUCCESS") {
        setPaymentStatus("SUCCESS");
        logMsg("🎉 Payment successful!");
      } else {
        setPaymentStatus("FAILED");
      }

    //   logMsg("✅ Backend updated:");
    //   logMsg(JSON.stringify(updated, null, 2));
    } catch (err) {
      console.error(err);
      setPaymentStatus("FAILED");
      logMsg(`❌ Error: ${err?.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: 24 }}>
      <h2>Payment</h2>

      {/* Order Details */}
      <div style={{ border: "1px solid #ddd", padding: 16, borderRadius: 10 }}>
        <h3>Order Details</h3>

        <p>
          <b>Order ID (route):</b> {orderId || "-"}
        </p>

        {order ? (
          <>

            <p>
              <b>Amount:</b> {order.price} {order.tokenSymbol || ""}
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
              <b>Token Address:</b> {order.tokenAddress}
            </p>

            <p style={{ wordBreak: "break-all" }}>
              <b>Signature:</b> {order.signature}
            </p>

            {wallet && (
              <p>
                <b>Wallet:</b> {shortAddr(wallet)}
              </p>
            )}
          </>
        ) : (
          <p style={{ color: "#555" }}>
            {loadingOrder ? "Loading order details..." : "No order loaded."}
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
          disabled={busy || !!validationError || paymentStatus === "SUCCESS"}
          style={{
            background: paymentStatus === "SUCCESS" ? "#16a34a" : "#111",
            color: "#fff",
            padding: "10px 16px",
            cursor: busy || paymentStatus === "SUCCESS" ? "not-allowed" : "pointer",
            opacity: busy || validationError ? 0.6 : 1,
          }}
        >
          {paymentStatus === "SUCCESS"
            ? "Paid ✅"
            : busy
            ? "Processing..."
            : "Pay with Crypto"}
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
