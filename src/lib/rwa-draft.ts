const DRAFT_KEY = "par.rwa.draft";

export function rwaDraftKey(): string {
  return DRAFT_KEY;
}

/** Drop the saved real-world-asset form. The record already exists. */
export function clearRwaDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* The draft stays in memory for this visit. */
  }
}
