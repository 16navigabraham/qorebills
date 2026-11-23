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

  /**
   * Links tapped in Telegram open in Telegram's own browser, which has no wallet. When QoreX
   * doesn't appear, show how to open this page in QoreX, with a button that copies the link.
   */
  async function guide() {
    for (let i = 0; i < 20 && !window.qorex?.native; i++) await new Promise((r) => setTimeout(r, 150));
    if (window.qorex?.native) return true;
    const card = document.createElement("div");
    card.className = "card";
    card.style.borderColor = "var(--accent)";
    card.innerHTML = `
      <strong>Open this page in QoreX</strong>
      <p class="sub" style="margin:6px 0 12px">You need the QoreX wallet to sign. This browser doesn't have it.</p>
      <ol style="margin:0 0 12px;padding-left:20px;line-height:1.6">
        <li>Tap <b>Copy link</b>.</li>
        <li>Open the <b>QoreX</b> app (testnet) and go to its <b>Browser</b>.</li>
        <li>Paste the link and open it.</li>
      </ol>
      <button type="button" id="copyLink">Copy link</button>
      <input type="text" readonly id="linkText" aria-label="Page link" style="width:100%;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--muted);font:13px ui-monospace,monospace">`;
    const main = document.querySelector("main");
    main.insertBefore(card, main.children[2] || null);
    const text = card.querySelector("#linkText");
    text.value = location.href;
    card.querySelector("#copyLink").onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.href);
      } catch {
        text.select();
        document.execCommand?.("copy");
      }
      card.querySelector("#copyLink").textContent = "Copied: now paste it in QoreX";
    };
    return false;
  }

  return { wallet, address, sign, post, guide };
})();
