// src/components/PaymentScreen.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { PAYMENT, NETWORK } from "@/config";
import { connectTronLink, getContract, assertNetwork, shortAddr } from "@/lib/tron";
import { toTokenUnits } from "@/lib/units";
import { waitForTxResult } from "@/lib/tronHttp";

/**
 * QR must include:
 * merchantId, orderId, invoiceId, amount, token, deadline, signature
 *
 * IMPORTANT:
 * - `token` in QR is ALWAYS the TRC20 token ADDRESS (base58, starts with "T")
 * - This page uses that address for:
 *    - reading decimals()
 *    - allowance(owner, PAYMENT.address)
 *    - approve(PAYMENT.address, amount)
 *    - payTx(..., tokenAddress, amount, deadline, signature)
 *
 * Supported QR formats:
 * 1) JSON (recommended)
 *    {
 *      "merchantId":"0x..(bytes32)",
 *      "orderId":"0x..(bytes32)",
 *      "invoiceId":"0x..(bytes32)",
 *      "amount":"15.00",
 *      "token":"T....",                // TRC20 token address (base58)
 *      "deadline":"0",                 // uint256 string (0 to disable)
 *      "signature":"0x..."             // bytes
 *    }
 *
 * 2) Querystring
 *    merchant_id=0x..&order_id=0x..&invoice_id=0x..&amount=15.00&token=T....&deadline=0&signature=0x...
 *
 * Dependency:
 *   npm i jsqr
 */

const FEE_LIMIT = 150_000_000;

// Minimal TRC20 ABI we need
const TRC20_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];

function isBytes32Hex(v) {
  return typeof v === "string" && v.startsWith("0x") && v.length === 66;
}

function isBytesHex(v) {
  return typeof v === "string" && v.startsWith("0x") && v.length >= 4 && v.length % 2 === 0;
}

// Basic base58 Tron address check (good enough for UI validation)
function isTronBase58Address(v) {
  return typeof v === "string" && v.startsWith("T") && v.length >= 34 && v.length <= 36;
}

function parseQRData(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty QR data");

  const normalize = (obj) => {
    const merchantId = obj.merchantId || obj.merchant_id || "";
    const orderId = obj.orderId || obj.order_id || "";
    const invoiceId = obj.invoiceId || obj.invoice_id || "";
    const amount = obj.amount || obj.price || "";
    const token = obj.token || ""; // IMPORTANT: address
    const deadline = obj.deadline ?? "0";
    const signature = obj.signature || "";

    return {
      merchantName: obj.merchantName || obj.merchant_name || "",
      merchantAddress: obj.merchantAddress || obj.merchant_address || "",

      merchantId: String(merchantId).trim(),
      orderId: String(orderId).trim(),
      invoiceId: String(invoiceId).trim(),
      amount: String(amount).trim(),
      token: String(token).trim(), // token address
      deadline: String(deadline).trim(),
      signature: String(signature).trim(),
    };
  };

  // JSON
  if (raw.startsWith("{") && raw.endsWith("}")) return normalize(JSON.parse(raw));

  // URL / querystring
  const qs = raw.includes("?") ? raw.split("?").slice(1).join("?") : raw;
  if (qs.includes("=")) {
    const params = new URLSearchParams(qs);
    const get = (k) => params.get(k) || params.get(k.toUpperCase()) || "";
    return normalize({
      merchant_name: get("merchant_name"),
      merchant_address: get("merchant_address"),
      merchant_id: get("merchant_id") || get("merchantId"),
      order_id: get("order_id") || get("orderId"),
      invoice_id: get("invoice_id") || get("invoiceId"),
      amount: get("amount") || get("price"),
      token: get("token"),
      deadline: get("deadline"),
      signature: get("signature"),
    });
  }

  throw new Error("Unsupported QR format. Use JSON or querystring.");
}

async function decodeQRFromImageFile(file) {
  const jsQR = (await import("jsqr")).default;

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Invalid image"));
    i.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);

  if (!code?.data) throw new Error("QR not found in image");
  return String(code.data).trim();
}

export default function PaymentScreen() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [wallet, setWallet] = useState(null);

  const [data, setData] = useState(null); // populated by QR
  const [paymentStatus, setPaymentStatus] = useState("IDLE"); // IDLE | PROCESSING | SUCCESS | FAILED | PENDING

  const fileInputRef = useRef(null);

  function logMsg(msg) {
    setLog((l) => (l ? l + "\n" + msg : msg));
  }

  // Optional: URL prefill (if someone opens a link with query params)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const merchantId = params.get("merchant_id") || "";
    const orderId = params.get("order_id") || "";
    const invoiceId = params.get("invoice_id") || "";
    const amount = params.get("amount") || "";
    const token = params.get("token") || ""; // token address (base58)
    const deadline = params.get("deadline") || "0";
    const signature = params.get("signature") || "";

    if (merchantId || orderId || invoiceId || amount || token || signature) {
      setData({
        merchantName: params.get("merchant_name") || "",
        merchantAddress: params.get("merchant_address") || "",
        merchantId,
        orderId,
        invoiceId,
        amount,
        token,
        deadline,
        signature,
      });
    }
  }, []);

  const validationError = useMemo(() => {
    if (!data) return "Upload a QR to load payment data";

    if (!data.amount || Number(data.amount) <= 0) return "Invalid amount";

    if (!isBytes32Hex(data.merchantId)) return "Invalid merchantId (bytes32)";
    if (!isBytes32Hex(data.orderId)) return "Invalid orderId (bytes32)";
    if (!isBytes32Hex(data.invoiceId)) return "Invalid invoiceId (bytes32)";

    // ✅ token is address
    if (!data.token) return "Token address is required";
    if (!isTronBase58Address(data.token)) return "Invalid token address (TRON base58, starts with T)";

    // deadline can be 0 or positive integer string
    try {
      if (data.deadline === "" || data.deadline == null) return "Deadline is required (use 0 to disable)";
      const d = BigInt(data.deadline);
      if (d < 0n) return "Deadline must be >= 0";
    } catch {
      return "Invalid deadline (must be integer)";
    }

    if (!data.signature) return "Signature is required";
    if (!isBytesHex(data.signature)) return "Invalid signature (must be 0x hex bytes)";

    return "";
  }, [data]);

  async function onPickQRFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLog("");
      setPaymentStatus("IDLE");

      logMsg("Decoding QR from image...");
      const text = await decodeQRFromImageFile(file);
      logMsg("✅ QR decoded");
      logMsg(`QR text (preview): ${text.slice(0, 140)}${text.length > 140 ? "..." : ""}`);

      const parsed = parseQRData(text);
      setData(parsed);

      logMsg("✅ Payment data populated from QR");
    } catch (err) {
      console.error(err);
      logMsg(`❌ QR error: ${err?.message || String(err)}`);
      setData(null);
    } finally {
      e.target.value = "";
    }
  }

  async function handlePayWithCrypto() {
    if (!data) return;

    try {
      setBusy(true);
      setPaymentStatus("PROCESSING");
      logMsg("-----");
      logMsg("Starting payment...");

      if (validationError) {
        logMsg(`❌ ${validationError}`);
        return;
      }

      logMsg("Connecting to TronLink...");
      const { tronWeb, address } = await connectTronLink();
      setWallet(address);

      assertNetwork(tronWeb, NETWORK);
      logMsg(`Wallet connected: ${address}`);

      // ✅ Token setup: token address comes from QR
      const tokenAddr = data.token;

      // Build token contract using minimal ABI
      const token = await getContract(tronWeb, TRC20_ABI, tokenAddr);

      // decimals for correct amountRaw
      const decimals = Number(await token.decimals().call());
      const amountRaw = toTokenUnits(data.amount, decimals);
      const amountRawStr = String(amountRaw);

      logMsg(`Token address: ${tokenAddr}`);
      logMsg(`Decimals: ${decimals}`);
      logMsg(`Amount: ${data.amount}`);
      logMsg(`Amount (raw): ${amountRawStr}`);
      logMsg(`Deadline: ${data.deadline}`);
      logMsg(`Signature: ${data.signature.slice(0, 14)}...`);

      // ---- Allowance check ----
      const allowance = await token.allowance(address, PAYMENT.address).call();
      logMsg(`Current allowance: ${allowance}`);

      // ✅ Approval uses tokenAddr (from QR) and approves exact raw amount
      if (BigInt(allowance) < BigInt(amountRawStr)) {
        logMsg(`Approval required. Approving exact amount: ${amountRawStr}`);
        const approveTxid = await token
          .approve(PAYMENT.address, amountRawStr)
          .send({ feeLimit: FEE_LIMIT });

        logMsg(`✅ Approve tx: ${approveTxid}`);
      } else {
        logMsg("✅ Sufficient allowance. Skipping approve.");
      }

      // ---- Payment call uses tokenAddr (from QR) ----
      const payment = await getContract(tronWeb, PAYMENT.abi, PAYMENT.address);

      logMsg("Calling payTx()...");
      const txid = await payment
        .payTx(
          data.merchantId,
          data.orderId,
          data.invoiceId,
          tokenAddr, // ✅ token from QR
          amountRawStr,
          data.deadline,
          data.signature
        )
        .send({ feeLimit: FEE_LIMIT });

      logMsg(`✅ Payment txid: ${txid}`);
      logMsg("Waiting for chain confirmation...");

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
        setPaymentStatus("PENDING");
        logMsg("⚠️ Still pending. Please refresh later to confirm.");
      }

      // Optional: persist locally
      try {
        localStorage.setItem(
          `payment:${txid}`,
          JSON.stringify({
            ...data,
            txid,
            status: finalStatus,
            wallet: address,
            amountRaw: amountRawStr,
            ts: Date.now(),
          })
        );
      } catch {
        // ignore
      }
    } catch (err) {
      console.error(err);
      setPaymentStatus("FAILED");
      logMsg(`❌ Error: ${err?.message || String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <h2>Pay With Crypto</h2>

      {/* QR Upload */}
      <div style={{ border: "1px solid #ddd", padding: 16, borderRadius: 10 }}>
        <h3>Upload QR Image</h3>
        <p style={{ marginTop: 6, opacity: 0.8 }}>
          QR must contain: merchantId, orderId, invoiceId, amount, <b>token address</b>, deadline, signature
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onPickQRFile}
          disabled={busy}
        />

        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
          Recommended QR content: JSON string.
        </div>
      </div>

      {/* Details */}
      <div style={{ border: "1px solid #ddd", padding: 16, borderRadius: 10, marginTop: 16 }}>
        <h3>Payment Details</h3>

        {!data ? (
          <p style={{ opacity: 0.8 }}>No data loaded yet. Upload a QR to populate.</p>
        ) : (
          <>
            <p>
              <b>Amount:</b> {data.amount}
            </p>

            <p style={{ wordBreak: "break-all" }}>
              <b>Token Address:</b> {data.token}
            </p>

            <p style={{ wordBreak: "break-all" }}>
              <b>Merchant ID:</b> {data.merchantId}
            </p>
            <p style={{ wordBreak: "break-all" }}>
              <b>Order ID:</b> {data.orderId}
            </p>
            <p style={{ wordBreak: "break-all" }}>
              <b>Invoice ID:</b> {data.invoiceId}
            </p>

            <p style={{ wordBreak: "break-all" }}>
              <b>Deadline:</b> {data.deadline}
            </p>
            <p style={{ wordBreak: "break-all" }}>
              <b>Signature:</b> {data.signature}
            </p>

            {wallet ? (
              <p>
                <b>Wallet:</b> {shortAddr(wallet)}
              </p>
            ) : null}

            {validationError ? (
              <p style={{ marginTop: 10, color: "crimson" }}>⚠️ {validationError}</p>
            ) : null}
          </>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button disabled style={{ opacity: 0.5 }}>
          Pay with Card
        </button>

        <button
          onClick={handlePayWithCrypto}
          disabled={busy || !!validationError || paymentStatus === "SUCCESS" || !data}
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
          minHeight: 140,
          whiteSpace: "pre-wrap",
        }}
      >
        {log || "Logs will appear here..."}
      </pre>
    </div>
  );
}
