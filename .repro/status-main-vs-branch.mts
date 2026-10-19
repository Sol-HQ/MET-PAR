// Read-only: the live mainnet title's status, computed by main's code and this branch's code.
import * as branch from "../src/lib/title";
// @ts-ignore
import * as main from "/tmp/main-src/src/lib/title";
import { isDeepStrictEqual } from "node:util";
const RPC = "https://api.mainnet-beta.solana.com";
const recordAddr = "48ge2tCKiccmikqVRYtDRJQoiLtGhcHDgPaghUSE6cQv";
const rec = await branch.readTitle(RPC, recordAddr);
const record = { address: recordAddr, attributes: rec.attributes };
console.log("record attributes:", JSON.stringify(rec.attributes));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const a = await (main as any).titleStatus(RPC, "mainnet-beta", record);
await sleep(1500);
const b = await branch.titleStatus(RPC, "mainnet-beta", record);
const clean = (s: any) => JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
console.log("main:  ", JSON.stringify(clean(a)));
console.log("branch:", JSON.stringify(clean(b)));
console.log("identical:", isDeepStrictEqual(clean(a), clean(b)));
