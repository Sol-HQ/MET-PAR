import { Connection, PublicKey } from "@solana/web3.js";
import { deserializeAssetV1 } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
const RPC = process.env.RPC || "https://solana-devnet.api.onfinality.io/public";
const c = new Connection(RPC, "confirmed");
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1);
(async () => {
  for (const [label, key] of [["title", "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi"], ["record", "9vSeor8BrXwMC4KUTEeFzRmqgA8GQLadV61KRijWkf75"]]) {
    const info = await c.getAccountInfo(new PublicKey(key));
    if (!info) { console.log(label, "missing"); continue; }
    const a = deserializeAssetV1({ publicKey: publicKey(key), executable: false, owner: publicKey(info.owner.toBase58()), lamports: { basisPoints: BigInt(info.lamports), identifier: "SOL", decimals: 9 } as never, data: info.data, exists: true } as never);
    const { attributes, ...rest } = a as unknown as Record<string, unknown>;
    console.log(label, "owner program", info.owner.toBase58(), show({ owner: (a as never as { owner: string }).owner, updateAuthority: (a as never as { updateAuthority: unknown }).updateAuthority, pluginKeys: Object.keys(rest).filter((k) => !["publicKey", "header", "key", "owner", "updateAuthority", "name", "uri", "seq"].includes(k)) }));
    for (const k of Object.keys(rest)) if (!["publicKey", "header", "uri", "name"].includes(k)) console.log("  ", k, show((rest as Record<string, unknown>)[k]).slice(0, 400));
  }
  const prog = await c.getAccountInfo(new PublicKey("FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF"));
  console.log("escrow program", prog ? { owner: prog.owner.toBase58(), executable: prog.executable, len: prog.data.length } : "MISSING");
  if (prog && prog.data.length >= 36) {
    const pd = new PublicKey(prog.data.subarray(4, 36));
    const pdi = await c.getAccountInfo(pd);
    console.log("programdata", pd.toBase58(), pdi ? { len: pdi.data.length, slot: pdi.data.readBigUInt64LE(4).toString(), authorityOpt: pdi.data[12], authority: pdi.data[12] ? new PublicKey(pdi.data.subarray(13, 45)).toBase58() : null } : "missing");
  }
  const [listing] = PublicKey.findProgramAddressSync([Buffer.from("listing"), new PublicKey("4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi").toBuffer()], new PublicKey("FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF"));
  console.log("escrow listing PDA", listing.toBase58(), (await c.getAccountInfo(listing)) ? "EXISTS" : "absent");
})();
