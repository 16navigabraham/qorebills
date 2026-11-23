// Shared by the signing pages: talk to the QoreX wallet (window.qorex.native) and the agent's API.
window.QoreXSign = (() => {
  // QoreX injects its provider after the page loads, so wait for it a little.
  async function wallet() {
    for (let i = 0; i < 20 && !window.qorex?.native; i++) await new Promise((r) => setTimeout(r, 150));
    const q = window.qorex?.native;
    if (!q) throw new Error("QoreX not found. Open this link in the QoreX app's browser (testnet mode).");
    if (Array.isArray(q.capabilities) && !q.capabilities.includes("signArbitrary")) {
      throw new Error("This QoreX version cannot sign messages. Update QoreX.");
    }
    return q;
  }

  async function address(chainId) {
    const q = await wallet();
    await q.enable(chainId);
    const { bech32Address } = await q.getKey(chainId);
    return bech32Address;
  }

  /** Sign `message` (QoreSign message signing v1) with the account QoreX has open. */
  async function sign(chainId, message, expected, say = () => {}) {
    const q = await wallet();
    say("Waiting for QoreX…");
    await q.enable(chainId);
    const { bech32Address } = await q.getKey(chainId);
    if (expected && bech32Address !== expected) {
      throw new Error(`QoreX is on ${bech32Address}, but this account belongs to ${expected}. Switch account in QoreX and try again.`);
    }
    const signature = await q.signArbitrary(chainId, bech32Address, message);
    return { signature, bech32Address };
  }

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || "That did not work.");
    return out;
  }

  return { wallet, address, sign, post };
})();
