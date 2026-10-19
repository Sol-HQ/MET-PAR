import { readRecord } from "@/lib/record";
import { readTitle, titleStatus } from "@/lib/title";
const RPC = "https://api.mainnet-beta.solana.com";
(async () => {
  const t = await readTitle(RPC, "FhmvuPhuayviUA6s67wnquQaJievZu6W7hrk9JrFB8gL");
  const r = await readRecord(RPC, t.attributes.record);
  const s = await titleStatus(RPC, "mainnet-beta", { address: t.attributes.record, attributes: r.attributes });
  console.log({ mint: r.attributes.mint, recordDecimals: r.attributes.decimals, raw: s?.tensor?.amount?.toString(), seller: s?.tensor?.seller, currency: s?.tensor?.currency });
})();
