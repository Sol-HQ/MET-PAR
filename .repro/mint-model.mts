// Read-only: decode the record, the collection (master edition) and the title (edition) on devnet and mainnet.
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplCore, fetchAssetV1, fetchCollectionV1 } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import { Connection, PublicKey } from "@solana/web3.js";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const RPC = { devnet: process.env.DEVNET_RPC || "https://solana-devnet.api.onfinality.io/public", mainnet: "https://api.mainnet-beta.solana.com" };
const TITLES = { devnet: "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi", mainnet: "FhmvuPhuayviUA6s67wnquQaJievZu6W7hrk9JrFB8gL" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i > 6) throw e; await sleep(800 * (i + 1)); } }
}
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
function plugins(a: any) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (["publicKey", "header", "key", "owner", "updateAuthority", "name", "uri", "seq", "rentEpoch", "numMinted", "currentSize"].includes(k)) continue;
    out[k] = v;
  }
  return out;
}
async function who(c: Connection, addr: string) {
  const k = new PublicKey(addr);
  const info = await retry(() => c.getAccountInfo(k));
  return `${addr} onCurve=${PublicKey.isOnCurve(k.toBytes())} accountOwner=${info?.owner.toBase58() ?? "(no account)"} lamports=${info?.lamports ?? 0} dataLen=${info?.data.length ?? 0}`;
}
for (const net of ["devnet", "mainnet"] as const) {
  const umi = createUmi(RPC[net]).use(mplCore());
  const c = new Connection(RPC[net], "confirmed");
  console.log(`\n===== ${net.toUpperCase()} =====`);
  const title = await retry(() => fetchAssetV1(umi, publicKey(TITLES[net])));
  console.log("TITLE (edition)", title.publicKey, "\n owner:", await who(c, title.owner), "\n updateAuthority:", j(title.updateAuthority), "\n name:", title.name);
  console.log(" plugins:", j(plugins(title)));
  const colAddr = title.updateAuthority.address!;
  const col = await retry(() => fetchCollectionV1(umi, colAddr));
  const [seal] = PublicKey.findProgramAddressSync([Buffer.from("par sealed"), new PublicKey(colAddr).toBuffer()], CORE);
  console.log("COLLECTION (master edition)", col.publicKey, "\n account:", await who(c, col.publicKey), "\n updateAuthority:", col.updateAuthority, "\n expected sealed PDA:", seal.toBase58(), "match:", seal.toBase58() === col.updateAuthority, "\n UA account:", await who(c, col.updateAuthority), "\n numMinted:", col.numMinted, "currentSize:", col.currentSize, "name:", col.name);
  console.log(" plugins:", j(plugins(col)));
  const rec = title.attributes?.attributeList.find((x) => x.key === "record")?.value;
  console.log(" title attributes:", j(title.attributes?.attributeList));
  if (rec) {
    const r = await retry(() => fetchAssetV1(umi, publicKey(rec)));
    console.log("RECORD ('the master' in the app's words)", r.publicKey, "\n owner:", await who(c, r.owner), "\n updateAuthority:", j(r.updateAuthority), "\n name:", r.name);
    console.log(" plugins:", j(plugins(r)));
  }
}
