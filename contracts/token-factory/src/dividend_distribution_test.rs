//! Dividend distribution engine tests (#1148)
//!
//! Covers:
//! - Proportional distribution across 3+ holders
//! - Double-claim prevention
//! - Claim after window expiry (must fail)
//! - Admin reclaim of unclaimed dividends
//! - Property: sum of all claimable shares never exceeds total_amount

#[cfg(test)]
mod dividend_distribution_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, String,
    };

    use crate::{TokenFactory, TokenFactoryClient};

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    const CLAIM_WINDOW: u32 = 500;
    const POOL: i128 = 1_000_000_000;

    /// Set up factory + token. Returns (client, admin, token_index).
    fn setup(env: &Env) -> (TokenFactoryClient, Address, u32) {
        env.mock_all_auths();
        let cid = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(env, &cid);

        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        client.initialize(&admin, &treasury, &0i128, &0i128);

        client.create_token(
            &admin,
            &String::from_str(env, "DividendToken"),
            &String::from_str(env, "DVD"),
            &7u32,
            &0i128,
            &None,
            &0i128,
        );

        (client, admin, 0u32)
    }

    fn mint(client: &TokenFactoryClient, admin: &Address, token_index: u32, to: &Address, amount: i128) {
        client.mint(admin, &token_index, to, &amount);
    }

    fn advance_ledger(env: &Env, by: u32) {
        env.ledger().with_mut(|l| l.sequence_number += by);
    }

    fn asset(env: &Env) -> Address {
        Address::generate(env)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Proportional distribution across 3 holders
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn proportional_distribution_three_holders() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let h1 = Address::generate(&env);
        let h2 = Address::generate(&env);
        let h3 = Address::generate(&env);

        // Balances: 500, 300, 200 — total 1000
        mint(&client, &admin, token_index, &h1, 500_0000000);
        mint(&client, &admin, token_index, &h2, 300_0000000);
        mint(&client, &admin, token_index, &h3, 200_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);

        let a1 = client.claim_dividend(&h1, &dist_id);
        let a2 = client.claim_dividend(&h2, &dist_id);
        let a3 = client.claim_dividend(&h3, &dist_id);

        assert_eq!(a1, POOL * 500 / 1000);
        assert_eq!(a2, POOL * 300 / 1000);
        assert_eq!(a3, POOL * 200 / 1000);
        assert!(a1 + a2 + a3 <= POOL);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Double-claim prevention
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn double_claim_is_rejected() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);
        client.claim_dividend(&holder, &dist_id);

        let result = client.try_claim_dividend(&holder, &dist_id);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::DistributionAlreadyClaimed.into());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Claim after window expiry must fail
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn claim_after_window_closed_is_rejected() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);
        advance_ledger(&env, CLAIM_WINDOW + 1);

        let result = client.try_claim_dividend(&holder, &dist_id);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::DistributionWindowClosed.into());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Admin reclaim after window closes
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_reclaims_unclaimed_after_window() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let h1 = Address::generate(&env);
        let h2 = Address::generate(&env);
        // h1 and h2 each hold 50%
        mint(&client, &admin, token_index, &h1, 500_0000000);
        mint(&client, &admin, token_index, &h2, 500_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);

        // Only h1 claims
        let claimed = client.claim_dividend(&h1, &dist_id);

        advance_ledger(&env, CLAIM_WINDOW + 1);

        let reclaimed = client.reclaim_unclaimed(&admin, &dist_id);
        assert_eq!(reclaimed, POOL - claimed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Reclaim while window open must fail
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn reclaim_while_window_open_is_rejected() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);

        let result = client.try_reclaim_unclaimed(&admin, &dist_id);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::DistributionWindowOpen.into());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Double reclaim must fail
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn double_reclaim_is_rejected() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);
        advance_ledger(&env, CLAIM_WINDOW + 1);
        client.reclaim_unclaimed(&admin, &dist_id);

        let result = client.try_reclaim_unclaimed(&admin, &dist_id);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::DistributionAlreadyReclaimed.into());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Non-admin cannot initiate
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn non_admin_cannot_initiate_distribution() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let attacker = Address::generate(&env);
        mint(&client, &admin, token_index, &attacker, 1000_0000000);

        let result = client.try_initiate_distribution(&attacker, &token_index, &a, &POOL, &CLAIM_WINDOW);
        assert!(result.is_err());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Property: sum of claims never exceeds total_amount
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn sum_of_claims_never_exceeds_total() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        // 5 holders with varied balances (prime-ish numbers for non-trivial rounding)
        let balances: [i128; 5] = [100, 251, 333, 77, 239];
        let mut holders: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
        for &b in &balances {
            let h = Address::generate(&env);
            mint(&client, &admin, token_index, &h, b * 10_000_000);
            holders.push_back(h);
        }

        let total: i128 = 999_999_997; // not round
        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &total, &CLAIM_WINDOW);

        let mut sum: i128 = 0;
        for i in 0..holders.len() {
            sum += client.claim_dividend(&holders.get(i).unwrap(), &dist_id);
        }

        assert!(sum <= total, "sum {} exceeded total {}", sum, total);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Zero-balance holder gets NothingToClaim
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn zero_balance_holder_gets_nothing_to_claim() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);
        let a = asset(&env);

        let real_holder = Address::generate(&env);
        let zero_holder = Address::generate(&env);
        mint(&client, &admin, token_index, &real_holder, 1000_0000000);

        let dist_id = client.initiate_distribution(&admin, &token_index, &a, &POOL, &CLAIM_WINDOW);

        let result = client.try_claim_dividend(&zero_holder, &dist_id);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::NothingToClaim.into());
    }
}
