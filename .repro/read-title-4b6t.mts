import { readTitle } from "../src/lib/title";
const r = await readTitle("https://solana-devnet.api.onfinality.io/public", "4B6tK3fGhYMAqixrYRArj1T1DABjAr3Hs8DZrjC5MWPi");
console.log(JSON.stringify(r).slice(0, 400));
