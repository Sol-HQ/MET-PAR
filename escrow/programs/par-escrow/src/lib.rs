use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Burn, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};
use mpl_core::accounts::{BaseAssetV1, PluginHeaderV1};
use mpl_core::instructions::TransferV1CpiBuilder;
use mpl_core::types::{PluginAuthority, PluginType, UpdateAuthority};
use mpl_core::{DataBlob, PluginRegistryV1Safe};

/// Practice program. One day is one second. The older program on the practice network was not upgraded.
declare_id!("FASTUQ11TbpbpQL1LitzgwjLcpqRPgQrHXmuk584hypF");

pub const DBC_PROGRAM: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
const POOL_SIZE: usize = 424;
const POOL_BASE_MINT_AT: usize = 136;
const POOL_MIGRATED_AT: usize = 305;

#[cfg(not(feature = "short-days"))]
const DAY: i64 = 86_400;
#[cfg(feature = "short-days")]
const DAY: i64 = 1;
const MAX_DELAY_DAYS: u16 = 365;
pub const RECLAIM_AFTER: i64 = 365 * DAY;
pub const SALE_FIXED: u8 = 0;
pub const SALE_AUCTION: u8 = 1;
/// The bidding clock. It starts when the first bid meets the reserve, not when the sale opens.
#[cfg(not(feature = "short-days"))]
pub const AUCTION_WINDOW: i64 = 72 * 3_600;
#[cfg(feature = "short-days")]
pub const AUCTION_WINDOW: i64 = 72;
/// A bid in the last hour of the clock moves the end to one hour after that bid.
#[cfg(not(feature = "short-days"))]
pub const AUCTION_EXTEND: i64 = 3_600;
#[cfg(feature = "short-days")]
pub const AUCTION_EXTEND: i64 = 1;
/// With no bid, the title keeps sitting. The creator cannot take it back until this long after the sale opens.
pub const AUCTION_SIT: i64 = 60 * DAY;
/// Two percent of every sale price. The creator cannot change this.
pub const PROGRAM_FEE_BPS: u64 = 200;
/// Default burn, used by the app. The listing stores the burn the creator chose.
pub const DEFAULT_BURN_BPS: u16 = 2_500;
/// The burn plus the program fee cannot pass 100%.
const MAX_BURN_BPS: u16 = 9_800;
const BPS: u64 = 10_000;
/// The platform wallet. The program fee is paid to this wallet, in the sale token.
pub const TREASURY: Pubkey = pubkey!("pa1Tt6RjP5YLbxjqDtKhFCmwRdtQvscxPrwfopWX18u");

pub const LISTING_SEED: &[u8] = b"listing";

#[program]
pub mod par_escrow {
    use super::*;

    /// The creator moves the title into the escrow. It can only leave by a sale or, after a long wait, a reclaim.
    /// `burn_bps` is the share of the sale price that is burned. It is a whole percent, from 0 to 98.
    /// `sale_kind` is 0 for a fixed price or 1 for an auction. It is fixed at deposit.
    pub fn deposit(ctx: Context<Deposit>, price: u64, delay_days: u16, burn_bps: u16, sale_kind: u8) -> Result<()> {
        require!(price > 0, EscrowError::ZeroPrice);
        require!(delay_days >= 1 && delay_days <= MAX_DELAY_DAYS, EscrowError::BadDelay);
        require!(burn_bps <= MAX_BURN_BPS && burn_bps % 100 == 0, EscrowError::BadBurn);
        require!(sale_kind == SALE_FIXED || sale_kind == SALE_AUCTION, EscrowError::BadSale);
        require_keys_eq!(*ctx.accounts.record.owner, mpl_core::ID, EscrowError::BadRecord);
        check_title(&ctx.accounts.asset.to_account_info(), &ctx.accounts.creator.key())?;
        let migrated = read_pool(&ctx.accounts.pool.to_account_info(), &ctx.accounts.mint.key())?;
        let now = Clock::get()?.unix_timestamp;

        let core = ctx.accounts.core_program.to_account_info();
        let asset = ctx.accounts.asset.to_account_info();
        let creator = ctx.accounts.creator.to_account_info();
        let listing_info = ctx.accounts.listing.to_account_info();
        let system = ctx.accounts.system_program.to_account_info();
        TransferV1CpiBuilder::new(&core)
            .asset(&asset)
            .payer(&creator)
            .authority(Some(&creator))
            .new_owner(&listing_info)
            .system_program(Some(&system))
            .invoke()?;

        let listing = &mut ctx.accounts.listing;
        listing.creator = ctx.accounts.creator.key();
        listing.asset = ctx.accounts.asset.key();
        listing.record = ctx.accounts.record.key();
        listing.mint = ctx.accounts.mint.key();
        listing.pool = ctx.accounts.pool.key();
        listing.price = price;
        listing.delay = i64::from(delay_days) * DAY;
        listing.deposited_at = now;
        listing.graduated_at = if migrated { now } else { 0 };
        listing.burn_bps = burn_bps;
        listing.sale_kind = sale_kind;
        listing.bump = ctx.bumps.listing;
        listing.high_bidder = Pubkey::default();
        listing.high_bid = 0;
        listing.ends_at = 0;

        emit!(Deposited {
            asset: listing.asset,
            creator: listing.creator,
            price,
            delay_days,
            burn_bps,
            sale_kind,
        });
        Ok(())
    }

    /// Anyone can call this once the pool has migrated. The sale opens `delay` seconds after.
    pub fn mark_graduated(ctx: Context<MarkGraduated>) -> Result<()> {
        let listing = &mut ctx.accounts.listing;
        require!(listing.graduated_at == 0, EscrowError::AlreadyGraduated);
        let migrated = read_pool(&ctx.accounts.pool.to_account_info(), &listing.mint)?;
        require!(migrated, EscrowError::NotGraduated);
        let now = Clock::get()?.unix_timestamp;
        listing.graduated_at = now;
        emit!(Graduated {
            asset: listing.asset,
            graduated_at: now,
            opens_at: now + listing.delay,
        });
        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        require!(price > 0, EscrowError::ZeroPrice);
        let listing = &mut ctx.accounts.listing;
        require!(listing.high_bid == 0, EscrowError::AuctionLive);
        listing.price = price;
        emit!(PriceSet { asset: listing.asset, price });
        Ok(())
    }

    /// The buyer pays the listed coins. The burn written on the listing is destroyed, 2% goes to the
    /// program treasury, the rest goes to the creator, and the title goes to the buyer.
    pub fn buy(ctx: Context<Buy>, max_price: u64) -> Result<()> {
        let listing = &ctx.accounts.listing;
        require!(listing.sale_kind == SALE_FIXED, EscrowError::NotFixed);
        let now = Clock::get()?.unix_timestamp;
        require_open(listing, now)?;
        let price = listing.price;
        require!(price <= max_price, EscrowError::PriceMoved);

        let fee = share(price, PROGRAM_FEE_BPS)?;
        let burned = share(price, u64::from(listing.burn_bps))?;
        let paid = price.checked_sub(fee).ok_or(EscrowError::Overflow)?.checked_sub(burned).ok_or(EscrowError::Overflow)?;
        let decimals = ctx.accounts.mint.decimals;
        let token_program = ctx.accounts.token_program.to_account_info();

        pay_tokens(
            &token_program,
            &ctx.accounts.buyer_token.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.creator_token.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            paid,
            decimals,
        )?;
        pay_tokens(
            &token_program,
            &ctx.accounts.buyer_token.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.treasury_token.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            fee,
            decimals,
        )?;
        if burned > 0 {
            token_interface::burn(
                CpiContext::new(
                    token_program,
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.buyer_token.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                burned,
            )?;
        }

        let asset_key = listing.asset;
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &[listing.bump]];
        release(
            &ctx.accounts.core_program.to_account_info(),
            &ctx.accounts.asset.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            seeds,
        )?;

        emit!(Sold {
            asset: asset_key,
            buyer: ctx.accounts.buyer.key(),
            paid,
            burned,
            fee,
        });
        Ok(())
    }

    /// A bid at or above the reserve. The first one starts the 72-hour clock. The coins stay in the escrow.
    pub fn bid(ctx: Context<Bid>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bidder = ctx.accounts.bidder.key();
        let (asset_key, bump_seed, ends_at, pull, refund) = {
            let listing = &mut ctx.accounts.listing;
            require!(listing.sale_kind == SALE_AUCTION, EscrowError::NotAuction);
            require_open(listing, now)?;
            require!(amount >= listing.price, EscrowError::BelowReserve);
            require!(amount > listing.high_bid, EscrowError::BidTooLow);

            if listing.ends_at == 0 {
                listing.ends_at = now.checked_add(AUCTION_WINDOW).ok_or(EscrowError::Overflow)?;
            } else {
                require!(now < listing.ends_at, EscrowError::AuctionOver);
                let left = listing.ends_at.checked_sub(now).ok_or(EscrowError::Overflow)?;
                if left <= AUCTION_EXTEND {
                    listing.ends_at = now.checked_add(AUCTION_EXTEND).ok_or(EscrowError::Overflow)?;
                }
            }

            let raising = listing.high_bid > 0 && listing.high_bidder == bidder;
            let pull = if raising {
                amount.checked_sub(listing.high_bid).ok_or(EscrowError::Overflow)?
            } else {
                amount
            };
            let refund = if listing.high_bid > 0 && !raising {
                listing.high_bid
            } else {
                0
            };
            if refund > 0 {
                require_keys_eq!(*ctx.accounts.previous_token.owner, ctx.accounts.token_program.key(), EscrowError::WrongRefund);
                let data = ctx.accounts.previous_token.try_borrow_data()?;
                require!(data.len() >= 64, EscrowError::WrongRefund);
                require!(data[0..32] == listing.mint.to_bytes(), EscrowError::WrongRefund);
                require!(data[32..64] == listing.high_bidder.to_bytes(), EscrowError::WrongRefund);
            }
            (listing.asset, [listing.bump], listing.ends_at, pull, refund)
        };

        let decimals = ctx.accounts.mint.decimals;
        let token_program = ctx.accounts.token_program.to_account_info();
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &bump_seed];
        pay_tokens(
            &token_program,
            &ctx.accounts.bidder_token.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.bidder.to_account_info(),
            pull,
            decimals,
        )?;
        if refund > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    token_program,
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.previous_token.to_account_info(),
                        authority: ctx.accounts.listing.to_account_info(),
                    },
                    &[seeds],
                ),
                refund,
                decimals,
            )?;
        }

        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount == amount, EscrowError::BadVault);
        let listing = &mut ctx.accounts.listing;
        listing.high_bidder = bidder;
        listing.high_bid = amount;
        emit!(BidPlaced {
            asset: asset_key,
            bidder,
            amount,
            ends_at,
        });
        Ok(())
    }

    /// Pays out the high bid and sends the title. PAR's watcher sends this when the clock has ended.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let listing = &ctx.accounts.listing;
        require!(listing.sale_kind == SALE_AUCTION, EscrowError::NotAuction);
        require!(listing.ends_at > 0, EscrowError::NoBid);
        require!(listing.high_bid > 0, EscrowError::NoBid);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= listing.ends_at, EscrowError::ClockRunning);
        require_keys_eq!(ctx.accounts.winner.key(), listing.high_bidder, EscrowError::WrongWinner);
        require!(ctx.accounts.vault.amount == listing.high_bid, EscrowError::BadVault);

        let price = listing.high_bid;
        let fee = share(price, PROGRAM_FEE_BPS)?;
        let burned = share(price, u64::from(listing.burn_bps))?;
        let paid = price.checked_sub(fee).ok_or(EscrowError::Overflow)?.checked_sub(burned).ok_or(EscrowError::Overflow)?;
        let decimals = ctx.accounts.mint.decimals;
        let token_program = ctx.accounts.token_program.to_account_info();
        let asset_key = listing.asset;
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &[listing.bump]];

        if paid > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.creator_token.to_account_info(),
                        authority: ctx.accounts.listing.to_account_info(),
                    },
                    &[seeds],
                ),
                paid,
                decimals,
            )?;
        }
        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.treasury_token.to_account_info(),
                        authority: ctx.accounts.listing.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
                decimals,
            )?;
        }
        if burned > 0 {
            token_interface::burn(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.listing.to_account_info(),
                    },
                    &[seeds],
                ),
                burned,
            )?;
        }
        token_interface::close_account(CpiContext::new_with_signer(
            token_program,
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.creator.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            &[seeds],
        ))?;

        release(
            &ctx.accounts.core_program.to_account_info(),
            &ctx.accounts.asset.to_account_info(),
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.winner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            seeds,
        )?;

        emit!(Sold {
            asset: asset_key,
            buyer: ctx.accounts.winner.key(),
            paid,
            burned,
            fee,
        });
        Ok(())
    }

    /// The creator takes the title back only after the waiting period, and only when no auction bid is live.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        let listing = &ctx.accounts.listing;
        require!(listing.high_bid == 0, EscrowError::AuctionLive);
        let migrated = read_pool(&ctx.accounts.pool.to_account_info(), &listing.mint)?;
        require!(!(migrated && listing.graduated_at == 0), EscrowError::MarkGraduationFirst);
        let now = Clock::get()?.unix_timestamp;
        let due = reclaim_due(listing)?;
        require!(now >= due, EscrowError::TooEarly);

        let asset_key = listing.asset;
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &[listing.bump]];
        release(
            &ctx.accounts.core_program.to_account_info(),
            &ctx.accounts.asset.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            seeds,
        )?;
        emit!(Reclaimed { asset: asset_key });
        Ok(())
    }
}

fn require_open(listing: &Listing, now: i64) -> Result<()> {
    require!(listing.graduated_at > 0, EscrowError::NotGraduated);
    let opens_at = listing.graduated_at.checked_add(listing.delay).ok_or(EscrowError::Overflow)?;
    require!(now >= opens_at, EscrowError::NotOpen);
    Ok(())
}

/// Fixed sales wait a year. An auction with no bid waits 60 days after the sale opens. A coin that never graduates waits a year from deposit.
fn reclaim_due(listing: &Listing) -> Result<i64> {
    if listing.sale_kind == SALE_AUCTION && listing.graduated_at > 0 {
        let opens_at = listing.graduated_at.checked_add(listing.delay).ok_or(EscrowError::Overflow)?;
        return opens_at.checked_add(AUCTION_SIT).ok_or(error!(EscrowError::Overflow));
    }
    let base = if listing.graduated_at > 0 {
        listing.graduated_at.checked_add(listing.delay).ok_or(EscrowError::Overflow)?
    } else {
        listing.deposited_at
    };
    base.checked_add(RECLAIM_AFTER).ok_or(error!(EscrowError::Overflow))
}

/// `bps` of `price`, rounded down. Any leftover unit stays with the creator.
fn share(price: u64, bps: u64) -> Result<u64> {
    u64::try_from(u128::from(price) * u128::from(bps) / u128::from(BPS)).map_err(|_| error!(EscrowError::Overflow))
}

/// Moves tokens unless the amount is zero or the sender and receiver are the same account.
fn pay_tokens<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 || from.key() == to.key() {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.clone(),
            TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
        ),
        amount,
        decimals,
    )
}

fn release<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    listing: &AccountInfo<'info>,
    new_owner: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    TransferV1CpiBuilder::new(core)
        .asset(asset)
        .payer(payer)
        .authority(Some(listing))
        .new_owner(new_owner)
        .system_program(Some(system))
        .invoke_signed(&[seeds])?;
    Ok(())
}

/// Returns whether the pool has migrated. Fails unless this is a DBC pool for `mint`.
fn read_pool(pool: &AccountInfo, mint: &Pubkey) -> Result<bool> {
    require_keys_eq!(*pool.owner, DBC_PROGRAM, EscrowError::WrongPool);
    let data = pool.try_borrow_data()?;
    require!(data.len() == POOL_SIZE, EscrowError::WrongPool);
    require!(data[..8] == POOL_DISCRIMINATOR, EscrowError::WrongPool);
    require!(
        data[POOL_BASE_MINT_AT..POOL_BASE_MINT_AT + 32] == mint.to_bytes(),
        EscrowError::WrongPool
    );
    Ok(data[POOL_MIGRATED_AT] == 1)
}

/// A title nobody can move, burn, or change behind the escrow's back.
fn check_title(asset: &AccountInfo, creator: &Pubkey) -> Result<()> {
    require_keys_eq!(*asset.owner, mpl_core::ID, EscrowError::BadTitle);
    let data = asset.try_borrow_data()?;
    let base = BaseAssetV1::from_bytes(&data).map_err(|_| error!(EscrowError::BadTitle))?;
    require_keys_eq!(base.owner, *creator, EscrowError::NotOwner);
    require!(base.update_authority == UpdateAuthority::None, EscrowError::TitleChangeable);

    let base_len = base.len();
    if data.len() > base_len {
        let header = PluginHeaderV1::from_bytes(&data[base_len..]).map_err(|_| error!(EscrowError::BadTitle))?;
        let at = usize::try_from(header.plugin_registry_offset).map_err(|_| error!(EscrowError::BadTitle))?;
        require!(at < data.len(), EscrowError::BadTitle);
        let registry = PluginRegistryV1Safe::from_bytes(&data[at..]).map_err(|_| error!(EscrowError::BadTitle))?;
        require!(registry.external_registry.is_empty(), EscrowError::TitleHasHooks);
        for record in registry.registry.iter() {
            require!(allowed_plugin(record.plugin_type), EscrowError::TitleHasDelegate);
            require!(record.authority == PluginAuthority::None, EscrowError::TitleChangeable);
        }
    }
    Ok(())
}

fn allowed_plugin(kind: u8) -> bool {
    kind == PluginType::Royalties as u8
        || kind == PluginType::Attributes as u8
        || kind == PluginType::Edition as u8
        || kind == PluginType::AddBlocker as u8
        || kind == PluginType::ImmutableMetadata as u8
        || kind == PluginType::VerifiedCreators as u8
        || kind == PluginType::Autograph as u8
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub creator: Pubkey,
    pub asset: Pubkey,
    pub record: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub price: u64,
    pub delay: i64,
    pub deposited_at: i64,
    pub graduated_at: i64,
    /// Share of the sale price that is burned, in basis points. 2,500 is 25%.
    pub burn_bps: u16,
    /// 0 is a fixed price. 1 is an auction. Chosen at deposit.
    pub sale_kind: u8,
    pub bump: u8,
    /// The current leader. All zeros until the first bid.
    pub high_bidder: Pubkey,
    pub high_bid: u64,
    /// When the bidding clock ends. Zero until the first bid starts it.
    pub ends_at: i64,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: Core asset, checked in `check_title` and moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: The permanent record. Only its owner program is checked; the app checks its contents.
    pub record: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: DBC pool, checked in `read_pool`.
    pub pool: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkGraduated<'info> {
    #[account(mut, seeds = [LISTING_SEED, listing.asset.as_ref()], bump = listing.bump)]
    pub listing: Account<'info, Listing>,
    /// CHECK: Must be the listing's pool. Checked in `read_pool`.
    #[account(address = listing.pool)]
    pub pool: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator, seeds = [LISTING_SEED, listing.asset.as_ref()], bump = listing.bump)]
    pub listing: Account<'info, Listing>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Receives the coins and the listing rent. Must be the listing's creator.
    #[account(mut, address = listing.creator)]
    pub creator: UncheckedAccount<'info>,
    #[account(
        mut,
        close = creator,
        has_one = asset,
        has_one = mint,
        seeds = [LISTING_SEED, listing.asset.as_ref()],
        bump = listing.bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: Must be the listing's asset. Moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: The platform wallet. Constrained to `TREASURY`, so the fee cannot be sent anywhere else.
    #[account(address = TREASURY)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program
    )]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Bid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(mut, has_one = mint, seeds = [LISTING_SEED, listing.asset.as_ref()], bump = listing.bump)]
    pub listing: Account<'info, Listing>,
    #[account(mut, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = bidder, token::token_program = token_program)]
    pub bidder_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = bidder,
        associated_token::mint = mint,
        associated_token::authority = listing,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: The previous leader's token account. Checked when a refund is due. On the first bid, pass the bidder's own token account.
    #[account(mut)]
    pub previous_token: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Receives the creator's coins and the rent. Must be the listing's creator.
    #[account(mut, address = listing.creator)]
    pub creator: UncheckedAccount<'info>,
    #[account(
        mut,
        close = creator,
        has_one = asset,
        has_one = mint,
        seeds = [LISTING_SEED, listing.asset.as_ref()],
        bump = listing.bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: Must be the listing's asset. Moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: The high bidder. Checked against the listing. Receives the title.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    #[account(mut, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = listing, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: The platform wallet. Constrained to `TREASURY`, so the fee cannot be sent anywhere else.
    #[account(address = TREASURY)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program
    )]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        close = creator,
        has_one = creator,
        has_one = asset,
        seeds = [LISTING_SEED, listing.asset.as_ref()],
        bump = listing.bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: Must be the listing's asset. Moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: Must be the listing's pool. Checked in `read_pool`.
    #[account(address = listing.pool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Deposited {
    pub asset: Pubkey,
    pub creator: Pubkey,
    pub price: u64,
    pub delay_days: u16,
    pub burn_bps: u16,
    pub sale_kind: u8,
}

#[event]
pub struct Graduated {
    pub asset: Pubkey,
    pub graduated_at: i64,
    pub opens_at: i64,
}

#[event]
pub struct PriceSet {
    pub asset: Pubkey,
    pub price: u64,
}

#[event]
pub struct BidPlaced {
    pub asset: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
    pub ends_at: i64,
}

#[event]
pub struct Sold {
    pub asset: Pubkey,
    pub buyer: Pubkey,
    pub paid: u64,
    pub burned: u64,
    pub fee: u64,
}

#[event]
pub struct Reclaimed {
    pub asset: Pubkey,
}

#[error_code]
pub enum EscrowError {
    #[msg("The price has to be above zero.")]
    ZeroPrice,
    #[msg("The wait after graduation has to be 1 to 365 days.")]
    BadDelay,
    #[msg("The burn has to be a whole percent from 0 to 98. The program keeps 2%.")]
    BadBurn,
    #[msg("The sale is either a fixed price or an auction.")]
    BadSale,
    #[msg("The record is not a Metaplex Core asset.")]
    BadRecord,
    #[msg("The title is not a Metaplex Core asset.")]
    BadTitle,
    #[msg("Only the title's owner can deposit it.")]
    NotOwner,
    #[msg("The title can still be changed. Its update authority and every plugin authority must be None.")]
    TitleChangeable,
    #[msg("The title has a plugin that could move, burn, or freeze it.")]
    TitleHasDelegate,
    #[msg("The title has an external plugin that could block a sale.")]
    TitleHasHooks,
    #[msg("That is not the bonding curve pool for this coin.")]
    WrongPool,
    #[msg("The coin has not graduated.")]
    NotGraduated,
    #[msg("Graduation is already marked.")]
    AlreadyGraduated,
    #[msg("The sale is not open yet.")]
    NotOpen,
    #[msg("The price changed above what the buyer accepted.")]
    PriceMoved,
    #[msg("The coin graduated. Mark graduation before a reclaim.")]
    MarkGraduationFirst,
    #[msg("A reclaim is not allowed yet.")]
    TooEarly,
    #[msg("That listing is not an auction.")]
    NotAuction,
    #[msg("That listing is an auction. Pay by bidding.")]
    NotFixed,
    #[msg("The bid is under the reserve.")]
    BelowReserve,
    #[msg("The bid has to be higher than the current bid.")]
    BidTooLow,
    #[msg("The bidding clock has ended.")]
    AuctionOver,
    #[msg("A bid is in. The title stays until the auction finishes.")]
    AuctionLive,
    #[msg("Send the coins back to the current bidder.")]
    WrongRefund,
    #[msg("There is no finished bid to pay out.")]
    NoBid,
    #[msg("The bidding clock is still running.")]
    ClockRunning,
    #[msg("That wallet is not the high bidder.")]
    WrongWinner,
    #[msg("The coins held for the bid do not match the high bid.")]
    BadVault,
    #[msg("A number overflowed.")]
    Overflow,
}
