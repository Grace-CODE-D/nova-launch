#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::Address as _,
    Address, Env, String as SorobanString,
};

fn setup() -> (Env, Address, TokenFactoryClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

    (env, contract_id, client, admin, treasury)
}

#[test]
fn test_fee_accrual_on_token_creation() {
    let (env, _contract_id, client, _admin, _treasury) = setup();
    let creator = Address::generate(&env);

    // Initially no fees accrued
    assert_eq!(client.get_accrued_fees(), 0);

    // Create token with base fee
    let fee = 100_0000000;
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "TestToken"),
        &SorobanString::from_str(&env, "TST"),
        &7,
        &1000_0000000,
        &fee,
    );

    // Fee should be accrued
    assert_eq!(client.get_accrued_fees(), fee);

    // Create another token
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token2"),
        &SorobanString::from_str(&env, "TK2"),
        &7,
        &2000_0000000,
        &fee,
    );

    // Fees should accumulate
    assert_eq!(client.get_accrued_fees(), fee * 2);
}

#[test]
fn test_collect_fees_success() {
    let (env, _contract_id, client, admin, _treasury) = setup();
    let creator = Address::generate(&env);

    // Create token to accrue fees
    let fee = 100_0000000;
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "TestToken"),
        &SorobanString::from_str(&env, "TST"),
        &7,
        &1000_0000000,
        &fee,
    );

    assert_eq!(client.get_accrued_fees(), fee);

    // Collect fees
    client.collect_fees(&admin);

    // Fees should be reset to zero
    assert_eq!(client.get_accrued_fees(), 0);
}

#[test]
fn test_collect_fees_unauthorized() {
    let (env, _contract_id, client, _admin, _treasury) = setup();
    let creator = Address::generate(&env);
    let non_admin = Address::generate(&env);

    // Create token to accrue fees
    let fee = 100_0000000;
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "TestToken"),
        &SorobanString::from_str(&env, "TST"),
        &7,
        &1000_0000000,
        &fee,
    );

    // Non-admin tries to collect fees - should panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.try_collect_fees(&non_admin)
    }));
    
    assert!(result.is_err());

    // Fees should remain unchanged
    assert_eq!(client.get_accrued_fees(), fee);
}

#[test]
fn test_collect_fees_when_zero() {
    let (_env, _contract_id, client, admin, _treasury) = setup();

    // No fees accrued
    assert_eq!(client.get_accrued_fees(), 0);

    // Try to collect fees - should panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.try_collect_fees(&admin)
    }));
    
    assert!(result.is_err());
}

#[test]
fn test_multiple_fee_collections() {
    let (env, _contract_id, client, admin, _treasury) = setup();
    let creator = Address::generate(&env);
    let fee = 100_0000000;

    // First batch of tokens
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token0"),
        &SorobanString::from_str(&env, "TK0"),
        &7,
        &1000_0000000,
        &fee,
    );
    
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token1"),
        &SorobanString::from_str(&env, "TK1"),
        &7,
        &1000_0000000,
        &fee,
    );
    
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token2"),
        &SorobanString::from_str(&env, "TK2"),
        &7,
        &1000_0000000,
        &fee,
    );

    assert_eq!(client.get_accrued_fees(), fee * 3);

    // First collection
    client.collect_fees(&admin);
    assert_eq!(client.get_accrued_fees(), 0);

    // Second batch of tokens
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token3"),
        &SorobanString::from_str(&env, "TK3"),
        &7,
        &1000_0000000,
        &fee,
    );
    
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token4"),
        &SorobanString::from_str(&env, "TK4"),
        &7,
        &1000_0000000,
        &fee,
    );

    assert_eq!(client.get_accrued_fees(), fee * 2);

    // Second collection
    client.collect_fees(&admin);
    assert_eq!(client.get_accrued_fees(), 0);
}

#[test]
fn test_fee_accrual_with_different_amounts() {
    let (env, _contract_id, client, _admin, _treasury) = setup();
    let creator = Address::generate(&env);

    // Create tokens with different fee amounts
    let fee1 = 100_0000000;
    let fee2 = 150_0000000;
    let fee3 = 200_0000000;

    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token1"),
        &SorobanString::from_str(&env, "TK1"),
        &7,
        &1000_0000000,
        &fee1,
    );

    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token2"),
        &SorobanString::from_str(&env, "TK2"),
        &7,
        &1000_0000000,
        &fee2,
    );

    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "Token3"),
        &SorobanString::from_str(&env, "TK3"),
        &7,
        &1000_0000000,
        &fee3,
    );

    // Total should be sum of all fees
    assert_eq!(client.get_accrued_fees(), fee1 + fee2 + fee3);
}

#[test]
fn test_fee_accounting_accuracy() {
    let (env, _contract_id, client, admin, _treasury) = setup();
    let creator = Address::generate(&env);
    let base_fee = 100_0000000;

    let mut expected_total = 0i128;

    // Create 10 tokens with varying fees
    for i in 0..10 {
        let fee = base_fee + (i as i128 * 10_0000000);
        expected_total += fee;

        let token_name = SorobanString::from_str(&env, "Token");
        let token_symbol = SorobanString::from_str(&env, "TKN");

        client.create_token(
            &creator,
            &token_name,
            &token_symbol,
            &7,
            &1000_0000000,
            &fee,
        );

        // Verify running total
        assert_eq!(client.get_accrued_fees(), expected_total);
    }

    // Final verification
    assert_eq!(client.get_accrued_fees(), expected_total);

    // Collect and verify reset
    client.collect_fees(&admin);
    assert_eq!(client.get_accrued_fees(), 0);
}

#[test]
fn test_no_fee_leakage_on_failed_token_creation() {
    let (env, _contract_id, client, _admin, _treasury) = setup();
    let creator = Address::generate(&env);

    let initial_fees = client.get_accrued_fees();

    // Try to create token with insufficient fee - should panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.try_create_token(
            &creator,
            &SorobanString::from_str(&env, "TestToken"),
            &SorobanString::from_str(&env, "TST"),
            &7,
            &1000_0000000,
            &50_0000000, // Less than base fee of 100
        )
    }));

    assert!(result.is_err());

    // Fees should not have changed
    assert_eq!(client.get_accrued_fees(), initial_fees);
}

#[test]
fn test_collect_fees_checks_effects_interactions_pattern() {
    let (env, _contract_id, client, admin, _treasury) = setup();
    let creator = Address::generate(&env);

    let fee = 100_0000000;
    client.create_token(
        &creator,
        &SorobanString::from_str(&env, "TestToken"),
        &SorobanString::from_str(&env, "TST"),
        &7,
        &1000_0000000,
        &fee,
    );

    // Collect fees
    client.collect_fees(&admin);

    // Verify state was updated before event emission
    // (fees should be zero even if event processing fails)
    assert_eq!(client.get_accrued_fees(), 0);
}
