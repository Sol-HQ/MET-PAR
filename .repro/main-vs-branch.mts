// Same inputs, main's title.ts vs this branch's: default outputs must be identical.
import * as branch from "../src/lib/title";
// @ts-ignore
import * as main from "/tmp/main-src/src/lib/title";
import { isDeepStrictEqual } from "node:util";
let n = 0, diff = 0;
const mint = "So11111111111111111111111111111111111111112";
for (const rail of ["creator", "escrow"] as const)
  for (const sale of [undefined, "fixed", "auction"] as const)
    for (const burnPercent of [0, 25])
      for (const delayDays of [0, 7])
        for (const attached of [undefined, true, false])
          for (const shortClock of [undefined, true])
            for (const paySymbol of [undefined, "USDC"]) {
              const p = { rail, sale, burnPercent, delayDays, handoffDays: "30", attached, shortClock, paySymbol };
              const a = JSON.stringify((main as any).creatorPromises(p)), b = JSON.stringify(branch.creatorPromises(p));
              n++; if (a !== b) { diff++; console.log("PROMISES DIFF", JSON.stringify(p), "\nmain:", a, "\nbranch:", b); }
              for (const noCoin of [undefined, true]) {
                const f = { record: "R".repeat(43), mint, pool: "P".repeat(43), creator: "C".repeat(43), rail, sale, burnPercent, delayDays, shortClock, noCoin, venue: "https://x/t", sheet: "https://x/s", program: rail === "escrow" ? "E".repeat(43) : undefined } as any;
                const ma = (main as any).titleAttributes(f), ba = branch.titleAttributes(f);
                n++; if (!isDeepStrictEqual(ma, ba)) { diff++; console.log("ATTR DIFF", JSON.stringify(f), JSON.stringify(ma), JSON.stringify(ba)); }
              }
            }
console.log(`compared ${n} cases, ${diff} differ`);
