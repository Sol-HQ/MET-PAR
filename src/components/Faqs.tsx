import Link from "next/link";
import { LawRecord } from "@/components/LawRecord";
import { ESCROW_PATH, TENSOR_TAKER_FEE_PERCENT } from "@/lib/title";

export function Faqs() {
  return (
    <div className="desk">
      <section className="lede">
        <p className="eyebrow">The whole desk</p>
        <h1>FAQs</h1>
        <p className="tagline">What each part does, and how the parts meet.</p>
        <div className="asset-nav">
          <Link href="/" className="asset-link">
            PAR
          </Link>
          <Link href="/pools" className="asset-link">
            Pools
          </Link>
          <Link href="/asset" className="asset-link">
            Real-world asset
          </Link>
        </div>
      </section>

      <article className="card faqs">
        <h2>Where is the coin created?</h2>
        <p>
          The front page creates a coin. The real-world asset page records one object. The coin is created first,
          on the front page. Its token address is then pasted into the object page. The object page does not create
          the coin.
        </p>
        <p>
          A coin can exist on its own. An object can exist with a coin attached, or with no coin. Painting is one
          example of an object. The same steps fit a card, a kite, a watch, or anything else one person can hand over.
        </p>

        <h2>What is PAR on, and what is PAR off?</h2>
        <p>
          PAR on is one price. Most of the tokens buyers receive stay within 10% of it, so a buyer now and a buyer
          later pay nearly the same. That stretch is the shelf. It lasts until those tokens are bought. The last
          slice of the sale then rises to the pool price. Both prices are on the form before anyone buys.
        </p>
        <p>
          PAR off lets the price rise from the first token to the last. The opening price and the pool price are
          still on the form. That rise is the whole sale.
        </p>
        <p>
          The shelf ends when its tokens are bought. A falling fee ends when its clock runs out. Each one ends on
          its own. Slow buying can reach the ending fee while the price is still on the shelf. A fast sale can be
          rising toward the pool while the fee is still falling.
        </p>
        <p>Both climbs end at the same lock.</p>

        <h2>What does the curve fee do?</h2>
        <p>
          The curve fee is what a trade pays while the coin is still for sale. Fee falls starts at the percent you
          type and steps down to the ending fee. Fee stays flat keeps one percent for the whole sale. The price
          curve stays on the card. The ending fee and the clock are hidden while the fee is flat.
        </p>
        <p>
          Curved fall and straight fall stay on the form. They apply when the fee falls. Curved drops faster at the
          start. Straight drops the same amount at each step. The clock is 1 hour, 6 hours, 12 hours, 24 hours, 48
          hours, or 7 days. A buy at the open pays the opening fee. A buy after the clock pays the ending fee. A flat
          fee charges the same percent on every trade until migration.
        </p>
        <p>
          The Meme card starts at 10% and falls on a curve to 1% over 48 hours. The other cards start from the fee
          already on the form. The prices and the fee are written into the template. They cannot be edited later.
        </p>

        <h2>What is the lock?</h2>
        <p>
          The lock is graduation. It happens when the curve is full, with PAR on and with PAR off. The quote raised
          on the sale and the tokens still left move into a Meteora DAMM v2 pool. That pool is locked. The quote and
          those tokens stay in it. They are not paid out.
        </p>
        <p>
          A locked pool is required. The creator keeps coins through creator supply. That supply is reserved beside
          the pool. Claiming it does not pull tokens out of the pool.
        </p>
        <p>
          One claim at the lock pays the full amount except 1 token, then that 1 token one second later, so the
          program can store the claim. A year schedule is 12 monthly claims after a 30-day wait. The lock signature
          comes after the curve fills and before the trading pool opens. It does not start when the coin is created.
        </p>

        <h2>What happens after the lock?</h2>
        <p>
          Trading continues on this site, on Meteora, and on Jupiter, Axiom, and Photon. A buy can move the price
          up. A sell can move it down. The curve fee has stopped, even if time is left on its clock. Every later
          trade pays the pool fee chosen on the form. The default is 0.25%. The Meme card uses 1%.
        </p>
        <p>
          A share of that pool fee can be put back into the pool. The quote and the tokens that locked stay locked
          either way. At 100% put back, nothing from that pool fee is left to claim.
        </p>
        <p>
          Of each trading fee, Meteora keeps 20%. The platform and the creator share the rest. At a 20% platform
          fee, the whole fee is Meteora 20%, platform 20%, and creator 60%. Those fee shares wait until they are
          claimed. A claim takes the fee. It does not take the locked quote or the locked tokens.
        </p>
        <p>
          Meteora keeps 0.2% of the quote and 0.2% of the tokens that move into the pool. That protocol fee stays
          on. The optional extra migration fee on this desk stays at zero.
        </p>

        <h2>What do the cards set?</h2>
        <p>
          Meme is a rising coin. PAR stays off. A slider sets the lock from $10,000 to $50,000, or the same sizes
          in SOL. The supply stays 1,000,000,000. A 5% creator bag is the start, paid when the coin locks. The bag
          can be changed up to 20%.
        </p>
        <p>
          Starter, Solid, and Deep are one shelf at three locks: $10,000, $25,000, and $50,000, or 10, 25, and 50
          SOL. PAR starts on. The sliders move the price. The lock stays.
        </p>
        <p>
          Thin is a $750 curve, or 1 SOL. On the real network, $750 is the smallest USDC curve Meteora opens by
          itself. 1 SOL is under that keeper line, so someone has to open the trading pool by hand.
        </p>
        <p>
          Par fixed is 1,000,000,000 tokens from $0.00005 to $0.00006. Custom is where a supply and two prices are
          typed. A rising curve that tries to lock half the supply is rejected.
        </p>

        <h2>What is the object?</h2>
        <p>
          The NFT is the record of one object: the token address, the pool, the proofs, the rules, and the picture.
          When a coin is attached, the coin is the payment token and the meme. It pays for the title. The meme is
          the joy and heart of the object. The coin is not a share of the object, and it pays nothing. The creator
          sets the title price later, in the coin.
        </p>
        <p>
          Two NFTs are made, and the record sheet is on both. The master goes to the program vault and stays there,
          frozen. One edition is the title. It goes to the creator, or into escrow on the practice network. The
          chain NFT and the record sheet are the proof. PAR keeps a copy of those proofs.
        </p>
        <p>
          With a coin attached, the title can be sold only after graduation, and only after a clock the creator
          chose, from 1 to 365 days. The day is set at graduation and locks into the title. With no coin, the
          creator names the payment token. The title stays in the creator&apos;s wallet until the creator lists it.
        </p>
        <p>
          A normal wallet lists the title through Tensor&apos;s marketplace program, at one price, and can buy a
          title that is already listed. The buyer pays that price. Tensor pays the seller the full price and
          charges the buyer about {TENSOR_TAKER_FEE_PERCENT}% on top. PAR takes none of that sale. A burn, if the
          creator promised one, is the creator&apos;s own promise. {ESCROW_PATH} On the practice network that program
          is open to the two test wallets, and only when a coin is attached.
        </p>
        <p>
          The creator signs the terms and owes the handoff. PAR is software. It does not hold, insure, or guarantee
          the object. The declared value on the sheet is the amount owed if the object is not handed over.
        </p>

        <h2>What does creating a coin cost?</h2>
        <p>
          Creating a coin on the real network signs twice. The first signature writes the template. The second
          writes the mint and the pool. The review shows the SOL rent, the network fee, and a small tip inside the
          real-network transaction. USDC spent to create is 0. Nothing is sent until the wallet confirms.
        </p>
        <p>
          The name can be 32 characters. The symbol can be 10. The description box stops at 80. The chain stores
          one metadata link of at most 200 characters. A long description is left off that link when the name, the
          symbol, and the picture already fill it.
        </p>

        <h2>What does PAR do?</h2>
        <ul>
          <li>Creates the coin on a Meteora bonding curve and shows both climbs before anyone buys.</li>
          <li>Writes the prices, the supply, and the fee into a template that cannot be edited later.</li>
          <li>Locks the quote and the remaining tokens in the trading pool when the curve is full.</li>
          <li>Keeps trading open on this site after the lock, and on Meteora, Jupiter, Axiom, and Photon.</li>
          <li>Records one object on two NFTs, with the master frozen in the vault and one title for the creator.</li>
          <li>Shows the exact amounts and waits for a second confirmation before a real-network wallet opens.</li>
          <li>Keeps a copy of the proofs. The chain NFT and the record sheet are the proof a buyer can read.</li>
        </ul>

        <h2>What does PAR not do?</h2>
        <ul>
          <li>It does not hold, insure, or guarantee the object, the coins, or the handoff.</li>
          <li>It does not promise that a price will go up, or promise a return.</li>
          <li>The coin is not a share of the object, and it pays nothing to the holder.</li>
          <li>A fee claim does not withdraw the locked quote or the locked tokens.</li>
          <li>Creator supply does not come out of the pool.</li>
          <li>The object page does not create the coin.</li>
          <li>Escrow is not a real-network option yet.</li>
          <li>PAR takes none of a Tensor sale.</li>
        </ul>

        <h2>How do the parts tie together?</h2>
        <p>
          A person creates the coin on the front page, or skips the coin. If the thing is an object, they open the
          real-world asset page, paste the coin address when there is one, and sign the record. Buyers then fill
          the curve. When it is full, one signature locks the creator supply if there is any, and a later signature
          opens the trading pool. The quote and the remaining tokens stay in that pool. Trading continues.
        </p>
        <p>
          If a coin is attached to an object, the title waits until graduation and until the creator&apos;s clock
          ends. The title can then be listed. The person named on the sheet hands the object to the holder of the
          title. The coin can keep trading after that handoff. The pool stays locked.
        </p>

        <h2>Where does this sit with the law?</h2>
        <p>The record below is the same structure shown on the object page.</p>
      </article>
      <LawRecord />
    </div>
  );
}
