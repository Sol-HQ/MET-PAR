import { readRecord } from "@/lib/record";
const RPC = "https://solana-devnet.api.onfinality.io/public";
(async () => {
  const { readTitle } = await import("@/lib/title");
  const t = await readTitle(RPC, "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi");
  console.log("TITLE ATTRS", t.attributes);
  const r = await readRecord(RPC, t.attributes.record);
  console.log("RECORD", r.uri, r.attributes);
})();
