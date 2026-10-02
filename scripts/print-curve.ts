import { DAMM_V2_MIGRATION_FEE_ADDRESS, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC_PROGRAM_ID, PRESETS } from "../src/lib/constants";
import { assertPreset } from "../src/lib/curve";

const program = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58();
if (program !== DBC_PROGRAM_ID) {
  throw new Error(`SDK program ${program} does not match ${DBC_PROGRAM_ID}`);
}

for (const preset of Object.values(PRESETS)) {
  const check = assertPreset(preset.id);
  console.log(
    [
      preset.id,
      `points=${check.points}`,
      `start=${check.startPrice}`,
      `end=${check.endPrice}`,
      `ratio=${check.ratio}`,
      `threshold=${check.migrationQuoteThreshold}`,
      `feeMode=${check.baseFeeMode}`,
      `migrationFee=${check.migrationFeeOption}`,
      `damm=${check.dammConfig}`,
      `dammIndex0=${DAMM_V2_MIGRATION_FEE_ADDRESS[0].toBase58()}`,
    ].join(" "),
  );
}

console.log("PAR curve checks passed.");
