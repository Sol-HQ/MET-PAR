-- Private rows stay with the service role. Public tables stay readable, and those roles cannot write them.
-- A later turn-off of row security must not open mail, notes, or webhook ids.

revoke all on table
  public.handoff_mail,
  public.handoff_reach,
  public.handoff_hold,
  public.handoff_note,
  public.handoff_letter,
  public.helius_hooks,
  public.jobs
from anon, authenticated;

revoke insert, update, delete, truncate, references, trigger on table
  public.items,
  public.pools,
  public.events,
  public.pictures,
  public.settings
from anon, authenticated;
