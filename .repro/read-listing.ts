import { Connection, PublicKey } from "@solana/web3.js";
import { readRecord } from "@/lib/record";
import { readTitle, titleStatus } from "@/lib/title";
const RPC = "https://solana-devnet.api.onfinality.io/public";
const TITLE = "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi";
(async () => {
  const title = await readTitle(RPC, TITLE);
  console.log("title", { exists: title.exists, owner: title.owner, name: title.name, collection: title.collection, attrs: title.attributes });
  const record = await readRecord(RPC, title.attributes.record);
  const status = await titleStatus(RPC, "devnet", { address: title.attributes.record, attributes: record.attributes });
  console.log("status", JSON.stringify(status, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
})();
