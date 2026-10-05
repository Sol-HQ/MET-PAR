export const ADMIN_WALLETS = [
  "pa1Tt6RjP5YLbxjqDtKhFCmwRdtQvscxPrwfopWX18u",
  "mejmPbxqeMgnKqZeF4du3TkBncRAfLmnof7LnGnnpNf",
] as const;

export const PLATFORM_FEE_CLAIMER = ADMIN_WALLETS[0];

export function isAdminWallet(address: string | null | undefined): boolean {
  return !!address && (ADMIN_WALLETS as readonly string[]).includes(address);
}
