use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint as SplMint, Token, TokenAccount as SplTokenAccount};
use anchor_spl::token_interface::{self, Burn, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};
use mpl_core::accounts::{BaseAssetV1, BaseCollectionV1, PluginHeaderV1};
use mpl_core::instructions::TransferV1CpiBuilder;
use mpl_core::types::{PluginAuthority, PluginType, Royalties, RuleSet, UpdateAuthority};
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

/// Wrapped SOL. The token program refuses to burn it, so a sale priced in it cannot carry a burn.
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// The app seals a title's collection by handing its update authority to this PDA of the Core program:
/// `["par sealed", collection]`. Nothing can sign for it, so the collection and its title can never change again.
pub const SEALED_SEED: &[u8] = b"par sealed";

pub const LISTING_SEED: &[u8] = b"listing";
pub const PAYOUT_SEED: &[u8] = b"payout";
pub const MAX_PAYOUTS: usize = 3;

#[program]
pub mod par_escrow {
    use super::*;

    /// The creator moves the title into the escrow. It can only leave by a sale or, after a long wait, a reclaim.
    /// `burn_bps` is the share of the sale price that is burned. It is a whole percent, from 0 to 98.
    /// `sale_kind` is 0 for a fixed price or 1 for an auction. It is fixed at deposit.
    /// `mint` is the token the price is in. It can be the coin or any ordinary SPL token, wrapped SOL included.
    /// A burn above 0 is allowed only when `mint` is the coin: a burn only ever reduces the title's own coin.
    /// `coin` is the title's coin and has to be the pool's base mint. A title in a collection passes the
    /// collection in the remaining accounts.
    pub fn deposit<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, Deposit<'info>>,
        price: u64,
        delay_days: u16,
        burn_bps: u16,
        sale_kind: u8,
    ) -> Result<()> {
        require!(price > 0, EscrowError::ZeroPrice);
        require!(delay_days >= 1 && delay_days <= MAX_DELAY_DAYS, EscrowError::BadDelay);
        require!(burn_bps <= MAX_BURN_BPS && burn_bps % 100 == 0, EscrowError::BadBurn);
        require!(sale_kind == SALE_FIXED || sale_kind == SALE_AUCTION, EscrowError::BadSale);
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            anchor_spl::token::ID,
            EscrowError::UnsupportedToken
        );
        require_coin_burn(&ctx.accounts.mint.key(), Some(&ctx.accounts.coin.key()), burn_bps)?;
        require_burnable(&ctx.accounts.mint.key(), burn_bps)?;
        require_keys_eq!(*ctx.accounts.record.owner, mpl_core::ID, EscrowError::BadRecord);
        let asset = ctx.accounts.asset.to_account_info();
        let collection = title_collection(&asset, ctx.remaining_accounts)?;
        check_title(&asset, &ctx.accounts.creator.key(), collection.as_ref())?;
        let migrated = read_pool(&ctx.accounts.pool.to_account_info(), Some(&ctx.accounts.coin.key()))?;
        let now = Clock::get()?.unix_timestamp;

        let core = ctx.accounts.core_program.to_account_info();
        let creator = ctx.accounts.creator.to_account_info();
        let listing_info = ctx.accounts.listing.to_account_info();
        let system = ctx.accounts.system_program.to_account_info();
        TransferV1CpiBuilder::new(&core)
            .asset(&asset)
            .collection(collection.as_ref())
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

    /// A title with no coin. The creator names an ordinary SPL token and up to three fixed payouts. With no coin
    /// there is nothing of the creator's own to burn, so `burn_bps` has to be 0 (`BurnNotCoin`).
    /// There is no pool and no graduation. The program still keeps 2% of the price. Token-2022 is refused.
    /// A title in a collection passes the collection in the remaining accounts.
    pub fn deposit_open<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, DepositOpen<'info>>,
        price: u64,
        delay_days: u16,
        burn_bps: u16,
        sale_kind: u8,
        payout_wallets: [Pubkey; 3],
        payout_amounts: [u64; 3],
    ) -> Result<()> {
        require!(price > 0, EscrowError::ZeroPrice);
        require!(delay_days <= MAX_DELAY_DAYS, EscrowError::BadOpenDelay);
        require!(burn_bps <= MAX_BURN_BPS && burn_bps % 100 == 0, EscrowError::BadBurn);
        require!(sale_kind == SALE_FIXED || sale_kind == SALE_AUCTION, EscrowError::BadSale);
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            anchor_spl::token::ID,
            EscrowError::UnsupportedToken
        );
        require_coin_burn(&ctx.accounts.mint.key(), None, burn_bps)?;
        require_burnable(&ctx.accounts.mint.key(), burn_bps)?;
        require_keys_eq!(*ctx.accounts.record.owner, mpl_core::ID, EscrowError::BadRecord);
        let asset = ctx.accounts.asset.to_account_info();
        let collection = title_collection(&asset, ctx.remaining_accounts)?;
        check_title(&asset, &ctx.accounts.creator.key(), collection.as_ref())?;
        let assigned = pack_payouts(&payout_wallets, &payout_amounts)?;
        let fee = share(price, PROGRAM_FEE_BPS)?;
        let burned = share(price, u64::from(burn_bps))?;
        let net = price.checked_sub(fee).ok_or(EscrowError::Overflow)?.checked_sub(burned).ok_or(EscrowError::Overflow)?;
        require!(assigned <= net, EscrowError::PayoutTooBig);

        let core = ctx.accounts.core_program.to_account_info();
        let creator = ctx.accounts.creator.to_account_info();
        let listing_info = ctx.accounts.listing.to_account_info();
        let system = ctx.accounts.system_program.to_account_info();
        TransferV1CpiBuilder::new(&core)
            .asset(&asset)
            .collection(collection.as_ref())
            .payer(&creator)
            .authority(Some(&creator))
            .new_owner(&listing_info)
            .system_program(Some(&system))
            .invoke()?;

        let now = Clock::get()?.unix_timestamp;
        let listing = &mut ctx.accounts.listing;
        listing.creator = ctx.accounts.creator.key();
        listing.asset = ctx.accounts.asset.key();
        listing.record = ctx.accounts.record.key();
        listing.mint = ctx.accounts.mint.key();
        listing.pool = Pubkey::default();
        listing.price = price;
        listing.delay = i64::from(delay_days) * DAY;
        listing.deposited_at = now;
        listing.graduated_at = now;
        listing.burn_bps = burn_bps;
        listing.sale_kind = sale_kind;
        listing.bump = ctx.bumps.listing;
        listing.high_bidder = Pubkey::default();
        listing.high_bid = 0;
        listing.ends_at = 0;

        let payouts = &mut ctx.accounts.payouts;
        payouts.wallets = payout_wallets;
        payouts.amounts = payout_amounts;

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
        // The pool's address is fixed on the listing and was checked against the coin at deposit.
        let migrated = read_pool(&ctx.accounts.pool.to_account_info(), None)?;
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
    pub fn buy<'a, 'b, 'c, 'info>(ctx: Context<'a, 'b, 'c, 'info, Buy<'info>>, max_price: u64) -> Result<()> {
        let listing = &ctx.accounts.listing;
        require!(listing.sale_kind == SALE_FIXED, EscrowError::NotFixed);
        let now = Clock::get()?.unix_timestamp;
        require_open(listing, now)?;
        let price = listing.price;
        require!(price <= max_price, EscrowError::PriceMoved);

        let fee = share(price, PROGRAM_FEE_BPS)?;
        let burned = share(price, u64::from(listing.burn_bps))?;
        let mut paid = price.checked_sub(fee).ok_or(EscrowError::Overflow)?.checked_sub(burned).ok_or(EscrowError::Overflow)?;
        let decimals = ctx.accounts.mint.decimals;
        let named = named_payouts(&ctx.remaining_accounts, &listing.asset, &ctx.program_id, listing.pool == Pubkey::default(), &listing.mint)?;
        let token_program = ctx.accounts.token_program.to_account_info();
        for (index, amount) in named {
            require!(amount <= paid, EscrowError::PayoutTooBig);
            require!(ctx.remaining_accounts[index].key() != ctx.accounts.buyer_token.key(), EscrowError::BadPayout);
            paid = paid.checked_sub(amount).ok_or(EscrowError::Overflow)?;
            pay_tokens(
                &token_program,
                &ctx.accounts.buyer_token.to_account_info(),
                &ctx.accounts.mint.to_account_info(),
                &ctx.remaining_accounts[index],
                &ctx.accounts.buyer.to_account_info(),
                amount,
                decimals,
            )?;
        }

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
            ctx.remaining_accounts,
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
        require_keys_eq!(ctx.accounts.token_program.key(), anchor_spl::token::ID, EscrowError::UnsupportedToken);
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
    pub fn settle<'a, 'b, 'c, 'info>(ctx: Context<'a, 'b, 'c, 'info, Settle<'info>>) -> Result<()> {
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
        let mut paid = price.checked_sub(fee).ok_or(EscrowError::Overflow)?.checked_sub(burned).ok_or(EscrowError::Overflow)?;
        let decimals = ctx.accounts.mint.decimals;
        let asset_key = listing.asset;
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &[listing.bump]];
        let named = named_payouts(&ctx.remaining_accounts, &asset_key, &ctx.program_id, listing.pool == Pubkey::default(), &listing.mint)?;
        let token_program = ctx.accounts.token_program.to_account_info();
        for (index, amount) in named {
            require!(amount <= paid, EscrowError::PayoutTooBig);
            paid = paid.checked_sub(amount).ok_or(EscrowError::Overflow)?;
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.remaining_accounts[index].clone(),
                        authority: ctx.accounts.listing.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                decimals,
            )?;
        }

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
            ctx.remaining_accounts,
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
    pub fn reclaim<'a, 'b, 'c, 'info>(ctx: Context<'a, 'b, 'c, 'info, Reclaim<'info>>) -> Result<()> {
        let listing = &ctx.accounts.listing;
        require!(listing.high_bid == 0, EscrowError::AuctionLive);
        if listing.pool != Pubkey::default() {
            let migrated = read_pool(&ctx.accounts.pool.to_account_info(), None)?;
            require!(!(migrated && listing.graduated_at == 0), EscrowError::MarkGraduationFirst);
        }
        let now = Clock::get()?.unix_timestamp;
        let due = reclaim_due(listing)?;
        require!(now >= due, EscrowError::TooEarly);

        let asset_key = listing.asset;
        let seeds: &[&[u8]] = &[LISTING_SEED, asset_key.as_ref(), &[listing.bump]];
        release(
            &ctx.accounts.core_program.to_account_info(),
            &ctx.accounts.asset.to_account_info(),
            ctx.remaining_accounts,
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

/// Sends the title out of the escrow. A title in a collection needs its collection, which the caller passes in
/// the remaining accounts; Core checks it is the title's collection.
fn release<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    payer: &AccountInfo<'info>,
    listing: &AccountInfo<'info>,
    new_owner: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let collection = title_collection(asset, remaining)?;
    TransferV1CpiBuilder::new(core)
        .asset(asset)
        .collection(collection.as_ref())
        .payer(payer)
        .authority(Some(listing))
        .new_owner(new_owner)
        .system_program(Some(system))
        .invoke_signed(&[seeds])?;
    Ok(())
}

/// Named amounts are packed at the front. A zero amount ends the list.
fn pack_payouts(wallets: &[Pubkey; 3], amounts: &[u64; 3]) -> Result<u64> {
    let mut assigned = 0u64;
    let mut closed = false;
    for i in 0..MAX_PAYOUTS {
        if amounts[i] == 0 {
            closed = true;
            require!(wallets[i] == Pubkey::default(), EscrowError::BadPayout);
            continue;
        }
        require!(!closed, EscrowError::BadPayout);
        require!(wallets[i] != Pubkey::default(), EscrowError::BadPayout);
        assigned = assigned.checked_add(amounts[i]).ok_or(EscrowError::Overflow)?;
    }
    Ok(assigned)
}

/// When this sale has no coin, the payout account and one token account per named wallet are required.
/// A coin sale passes nothing here and pays the creator the whole remainder.
fn named_payouts(remaining: &[AccountInfo], asset: &Pubkey, program_id: &Pubkey, required: bool, mint: &Pubkey) -> Result<Vec<(usize, u64)>> {
    if !required {
        return Ok(Vec::new());
    }
    require!(!remaining.is_empty(), EscrowError::BadPayout);
    let (expected, _) = Pubkey::find_program_address(&[PAYOUT_SEED, asset.as_ref()], program_id);
    require_keys_eq!(remaining[0].key(), expected, EscrowError::BadPayout);
    require_keys_eq!(*remaining[0].owner, *program_id, EscrowError::BadPayout);
    let stored = {
        let data = remaining[0].try_borrow_data()?;
        require!(data.len() >= 8 + 96 + 24, EscrowError::BadPayout);
        let mut rows = Vec::new();
        for i in 0..MAX_PAYOUTS {
            let amount_at = 8 + 96 + i * 8;
            let amount = u64::from_le_bytes(data[amount_at..amount_at + 8].try_into().map_err(|_| error!(EscrowError::BadPayout))?);
            if amount == 0 {
                break;
            }
            let wallet_at = 8 + i * 32;
            let wallet = Pubkey::new_from_array(data[wallet_at..wallet_at + 32].try_into().map_err(|_| error!(EscrowError::BadPayout))?);
            rows.push((wallet, amount));
        }
        rows
    };
    let mut named = Vec::new();
    for (i, (wallet, amount)) in stored.iter().enumerate() {
        let index = i + 1;
        let token = remaining.get(index).ok_or(error!(EscrowError::BadPayout))?;
        require_keys_eq!(*token.owner, anchor_spl::token::ID, EscrowError::BadPayout);
        let data = token.try_borrow_data()?;
        require!(data.len() >= 64, EscrowError::BadPayout);
        require!(data[0..32] == mint.to_bytes(), EscrowError::BadPayout);
        require!(data[32..64] == wallet.to_bytes(), EscrowError::BadPayout);
        named.push((index, *amount));
    }
    Ok(named)
}

/// Returns whether the pool has migrated. Fails unless this is a DBC pool, and, when `coin` is given, its pool.
fn read_pool(pool: &AccountInfo, coin: Option<&Pubkey>) -> Result<bool> {
    require_keys_eq!(*pool.owner, DBC_PROGRAM, EscrowError::WrongPool);
    let data = pool.try_borrow_data()?;
    require!(data.len() == POOL_SIZE, EscrowError::WrongPool);
    require!(data[..8] == POOL_DISCRIMINATOR, EscrowError::WrongPool);
    if let Some(coin) = coin {
        require!(
            data[POOL_BASE_MINT_AT..POOL_BASE_MINT_AT + 32] == coin.to_bytes(),
            EscrowError::WrongPool
        );
    }
    Ok(data[POOL_MIGRATED_AT] == 1)
}

/// A burn only ever destroys the title's own paired coin, to reduce its supply. A sale priced in any other token
/// (SOL, USDC, anything else), and every sale of a title with no coin (`coin` is None), has to burn 0.
fn require_coin_burn(mint: &Pubkey, coin: Option<&Pubkey>, burn_bps: u16) -> Result<()> {
    require!(burn_bps == 0 || coin == Some(mint), EscrowError::BurnNotCoin);
    Ok(())
}

/// The token program will not burn wrapped SOL, so a burn there would make the sale impossible.
/// `require_coin_burn` already stops it (a coin is never wrapped SOL); this stays as a second check.
fn require_burnable(mint: &Pubkey, burn_bps: u16) -> Result<()> {
    require!(burn_bps == 0 || *mint != NATIVE_MINT, EscrowError::NativeBurn);
    Ok(())
}

/// The title's collection account, taken from `remaining` when the title belongs to a collection.
/// Returns None for a title with no collection. Fails when the title has one and it was not passed.
fn title_collection<'info>(asset: &AccountInfo<'info>, remaining: &[AccountInfo<'info>]) -> Result<Option<AccountInfo<'info>>> {
    require_keys_eq!(*asset.owner, mpl_core::ID, EscrowError::BadTitle);
    let wanted = {
        let data = asset.try_borrow_data()?;
        let base = BaseAssetV1::from_bytes(&data).map_err(|_| error!(EscrowError::BadTitle))?;
        match base.update_authority {
            UpdateAuthority::Collection(key) => key,
            _ => return Ok(None),
        }
    };
    let found = remaining.iter().find(|account| account.key() == wanted).ok_or(error!(EscrowError::WrongCollection))?;
    require_keys_eq!(*found.owner, mpl_core::ID, EscrowError::WrongCollection);
    Ok(Some(found.clone()))
}

/// A title nobody can move, burn, or change behind the escrow's back.
///
/// Two kinds pass, and nothing else:
/// - a standalone title whose update authority is None (the older escrow titles), and
/// - a title in its own sealed collection: update authority Collection(c), and c is a Core collection whose update
///   authority is the `["par sealed", c]` PDA of the Core program, with exactly one asset ever minted into it.
///
/// No key exists for either authority, so nobody can update, re-delegate, freeze, burn, or move the title or its
/// collection. Every plugin on the title (and on the collection) must be on a short list that cannot move, freeze, or
/// burn it, with authority None (or the sealed update authority), and neither may carry external plugins (hooks,
/// oracles) that could refuse a transfer. A royalty plugin passes only without a program allow or deny list.
/// While the title sits in the escrow the listing owns it, so only this program could add an owner-managed delegate,
/// and it never does.
fn check_title(asset: &AccountInfo, creator: &Pubkey, collection: Option<&AccountInfo>) -> Result<()> {
    require_keys_eq!(*asset.owner, mpl_core::ID, EscrowError::BadTitle);
    let data = asset.try_borrow_data()?;
    let base = BaseAssetV1::from_bytes(&data).map_err(|_| error!(EscrowError::BadTitle))?;
    require_keys_eq!(base.owner, *creator, EscrowError::NotOwner);
    let sealed = match base.update_authority {
        UpdateAuthority::None => false,
        UpdateAuthority::Collection(key) => {
            let collection = collection.ok_or(error!(EscrowError::WrongCollection))?;
            require_keys_eq!(collection.key(), key, EscrowError::WrongCollection);
            check_sealed_collection(collection)?;
            true
        }
        UpdateAuthority::Address(_) => return err!(EscrowError::TitleChangeable),
    };
    check_plugins(&data, base.len(), sealed, allowed_plugin)
}

/// The title's collection: a Core collection, sealed, holding only this title, with nothing on it that reaches its assets.
fn check_sealed_collection(collection: &AccountInfo) -> Result<()> {
    require_keys_eq!(*collection.owner, mpl_core::ID, EscrowError::WrongCollection);
    let data = collection.try_borrow_data()?;
    let base = BaseCollectionV1::from_bytes(&data).map_err(|_| error!(EscrowError::WrongCollection))?;
    require!(base.key == mpl_core::types::Key::CollectionV1, EscrowError::WrongCollection);
    let (seal, _) = Pubkey::find_program_address(&[SEALED_SEED, collection.key.as_ref()], &mpl_core::ID);
    require_keys_eq!(base.update_authority, seal, EscrowError::CollectionChangeable);
    require!(base.num_minted == 1 && base.current_size == 1, EscrowError::CollectionNotSingle);
    check_plugins(&data, base.len(), true, allowed_collection_plugin)
}

/// Walks the plugin registry after the base account. `sealed` lets a plugin keep the sealed update authority.
fn check_plugins(data: &[u8], base_len: usize, sealed: bool, allowed: fn(u8) -> bool) -> Result<()> {
    if data.len() <= base_len {
        return Ok(());
    }
    let header = PluginHeaderV1::from_bytes(&data[base_len..]).map_err(|_| error!(EscrowError::BadTitle))?;
    let at = usize::try_from(header.plugin_registry_offset).map_err(|_| error!(EscrowError::BadTitle))?;
    require!(at < data.len(), EscrowError::BadTitle);
    let registry = PluginRegistryV1Safe::from_bytes(&data[at..]).map_err(|_| error!(EscrowError::BadTitle))?;
    require!(registry.external_registry.is_empty(), EscrowError::TitleHasHooks);
    for record in registry.registry.iter() {
        require!(allowed(record.plugin_type), EscrowError::TitleHasDelegate);
        let locked = record.authority == PluginAuthority::None || (sealed && record.authority == PluginAuthority::UpdateAuthority);
        require!(locked, EscrowError::TitleChangeable);
        if record.plugin_type == PluginType::Royalties as u8 {
            let start = usize::try_from(record.offset).map_err(|_| error!(EscrowError::BadTitle))?.checked_add(1).ok_or(EscrowError::Overflow)?;
            require!(start <= data.len(), EscrowError::BadTitle);
            let royalties = Royalties::deserialize(&mut &data[start..]).map_err(|_| error!(EscrowError::BadTitle))?;
            require!(royalties.rule_set == RuleSet::None, EscrowError::TitleHasHooks);
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

/// Collection plugins reach every asset in it. Only ones that cannot move, freeze, burn, or update a title pass.
fn allowed_collection_plugin(kind: u8) -> bool {
    kind == PluginType::MasterEdition as u8
        || kind == PluginType::Royalties as u8
        || kind == PluginType::Attributes as u8
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

/// Fixed token amounts paid before the depositing creator receives the rest. Empty amounts are zero.
#[account]
#[derive(InitSpace)]
pub struct Payouts {
    pub wallets: [Pubkey; 3],
    pub amounts: [u64; 3],
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
    /// The token the price is in.
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: DBC pool, checked in `read_pool` against `coin`.
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
    /// CHECK: The title's coin. Only its address is used: it has to be the pool's base mint (`read_pool`).
    pub coin: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositOpen<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: Core asset, checked in `check_title` and moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: The permanent record. Only its owner program is checked.
    pub record: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = creator,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    #[account(
        init,
        payer = creator,
        space = 8 + Payouts::INIT_SPACE,
        seeds = [PAYOUT_SEED, asset.key().as_ref()],
        bump
    )]
    pub payouts: Account<'info, Payouts>,
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
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Must be the listing's asset. Moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: Account<'info, SplMint>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token: Account<'info, SplTokenAccount>,
    #[account(mut, token::mint = mint, token::authority = creator)]
    pub creator_token: Account<'info, SplTokenAccount>,
    /// CHECK: The platform wallet. Constrained to `TREASURY`, so the fee cannot be sent anywhere else.
    #[account(address = TREASURY)]
    pub treasury: UncheckedAccount<'info>,
    /// Created by the buyer before this instruction. Creating it here overflowed the stack.
    #[account(mut, token::mint = mint, token::authority = treasury)]
    pub treasury_token: Account<'info, SplTokenAccount>,
    pub token_program: Program<'info, Token>,
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
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Must be the listing's asset. Moved by the Core program.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: The high bidder. Checked against the listing. Receives the title.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: Account<'info, SplMint>,
    #[account(mut, token::mint = mint, token::authority = listing)]
    pub vault: Account<'info, SplTokenAccount>,
    #[account(mut, token::mint = mint, token::authority = creator)]
    pub creator_token: Account<'info, SplTokenAccount>,
    /// CHECK: The platform wallet. Constrained to `TREASURY`, so the fee cannot be sent anywhere else.
    #[account(address = TREASURY)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = treasury)]
    pub treasury_token: Account<'info, SplTokenAccount>,
    pub token_program: Program<'info, Token>,
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
    /// CHECK: The coin's pool when this sale has one. Ignored when the listing has no pool.
    #[account(constraint = listing.pool == Pubkey::default() || pool.key() == listing.pool @ EscrowError::WrongPool)]
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
    #[msg("The wait has to be a whole number from 0 to 365 days.")]
    BadOpenDelay,
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
    #[msg("The title can still be changed. Its update authority must be None or its sealed collection, and every plugin authority must be None.")]
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
    #[msg("That token cannot be used. The escrow settles an ordinary SPL token. Token-2022 is refused.")]
    UnsupportedToken,
    #[msg("Those payouts do not fit. The program keeps 2%, then the burn, and the named amounts have to fit in what is left.")]
    PayoutTooBig,
    #[msg("A payout wallet or its token account is wrong.")]
    BadPayout,
    #[msg("The title belongs to a collection. Pass that collection.")]
    WrongCollection,
    #[msg("The title's collection can still be changed. Its update authority must be the sealed address.")]
    CollectionChangeable,
    #[msg("The title's collection has to hold only this title.")]
    CollectionNotSingle,
    #[msg("Wrapped SOL cannot be burned. A sale priced in SOL has to have a burn of 0.")]
    NativeBurn,
    #[msg("A burn only burns the title's own coin. Priced in any other token, or for a title with no coin, the burn has to be 0.")]
    BurnNotCoin,
}
