#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client
        .initialize(&admin, &treasury, &1_000_000, &500_000)
        .unwrap();

    (env, contract_id, admin, treasury)
}

fn create_token(
    env: &Env,
    client: &TokenFactoryClient,
    creator: &Address,
    name: &str,
    symbol: &str,
) {
    // Note: This assumes you have a create_token function
    // If not, we'll need to manually set up the token info
    let token_name = String::from_str(env, name);
    let token_symbol = String::from_str(env, symbol);
    
    // Manually create token info for testing
    let token_index = crate::storage::get_token_count(env);
    let token_info = crate::types::TokenInfo {
        address: Address::generate(env),
        creator: creator.clone(),
        name: token_name,
        symbol: token_symbol,
        decimals: 7,
        total_supply: 1_000_000_0000000,
        initial_supply: 1_000_000_0000000,
        max_supply: None,
        total_burned: 0,
        burn_count: 0,
        metadata_uri: None,
        created_at: env.ledger().timestamp(),
        clawback_enabled: false,
    };
    
    crate::storage::set_token_info(env, token_index, &token_info);
    crate::storage::increment_token_count(env);
}

#[test]
fn test_pagination_empty_results() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    let result = client.get_tokens_by_creator(&creator, &None, &Some(20)).unwrap();
    
    assert_eq!(result.tokens.len(), 0);
    assert!(result.cursor.is_none());
}

#[test]
fn test_pagination_single_page() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 5 tokens
    for i in 0..5 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    let result = client.get_tokens_by_creator(&creator, &None, &Some(20)).unwrap();
    
    assert_eq!(result.tokens.len(), 5);
    assert!(result.cursor.is_none()); // No more pages
}

#[test]
fn test_pagination_multiple_pages() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 50 tokens
    for i in 0..50 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // First page
    let page1 = client.get_tokens_by_creator(&creator, &None, &Some(20)).unwrap();
    assert_eq!(page1.tokens.len(), 20);
    assert!(page1.cursor.is_some());
    
    // Second page
    let page2 = client.get_tokens_by_creator(&creator, &page1.cursor, &Some(20)).unwrap();
    assert_eq!(page2.tokens.len(), 20);
    assert!(page2.cursor.is_some());
    
    // Third page (last 10)
    let page3 = client.get_tokens_by_creator(&creator, &page2.cursor, &Some(20)).unwrap();
    assert_eq!(page3.tokens.len(), 10);
    assert!(page3.cursor.is_none());
}

#[test]
fn test_pagination_deterministic_ordering() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 30 tokens
    for i in 0..30 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // Fetch first page twice
    let result1 = client.get_tokens_by_creator(&creator, &None, &Some(10)).unwrap();
    let result2 = client.get_tokens_by_creator(&creator, &None, &Some(10)).unwrap();
    
    // Results should be identical
    assert_eq!(result1.tokens.len(), result2.tokens.len());
    
    for i in 0..result1.tokens.len() {
        let token1 = result1.tokens.get(i).unwrap();
        let token2 = result2.tokens.get(i).unwrap();
        assert_eq!(token1.address, token2.address);
        assert_eq!(token1.name, token2.name);
        assert_eq!(token1.symbol, token2.symbol);
    }
}

#[test]
fn test_pagination_boundary_exact_page_size() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create exactly 20 tokens
    for i in 0..20 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    let result = client.get_tokens_by_creator(&creator, &None, &Some(20)).unwrap();
    
    assert_eq!(result.tokens.len(), 20);
    assert!(result.cursor.is_none()); // Exactly one page, no more
}

#[test]
fn test_pagination_boundary_one_more_than_page() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 21 tokens (one more than page size)
    for i in 0..21 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // First page
    let page1 = client.get_tokens_by_creator(&creator, &None, &Some(20)).unwrap();
    assert_eq!(page1.tokens.len(), 20);
    assert!(page1.cursor.is_some());
    
    // Second page should have exactly 1 token
    let page2 = client.get_tokens_by_creator(&creator, &page1.cursor, &Some(20)).unwrap();
    assert_eq!(page2.tokens.len(), 1);
    assert!(page2.cursor.is_none());
}

#[test]
fn test_pagination_max_limit_enforced() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 150 tokens
    for i in 0..150 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // Request more than MAX_PAGE_SIZE (100)
    let result = client.get_tokens_by_creator(&creator, &None, &Some(150)).unwrap();
    
    // Should be capped at 100
    assert_eq!(result.tokens.len(), 100);
    assert!(result.cursor.is_some());
}

#[test]
fn test_pagination_default_limit() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 50 tokens
    for i in 0..50 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // No limit specified, should use default (20)
    let result = client.get_tokens_by_creator(&creator, &None, &None).unwrap();
    
    assert_eq!(result.tokens.len(), 20);
    assert!(result.cursor.is_some());
}

#[test]
fn test_pagination_multiple_creators_isolated() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator1 = Address::generate(&env);
    let creator2 = Address::generate(&env);
    
    // Create 10 tokens for creator1
    for i in 0..10 {
        create_token(&env, &client, &creator1, &format!("Token1-{}", i), &format!("T1{}", i));
    }
    
    // Create 5 tokens for creator2
    for i in 0..5 {
        create_token(&env, &client, &creator2, &format!("Token2-{}", i), &format!("T2{}", i));
    }
    
    // Verify creator1 has 10 tokens
    let result1 = client.get_tokens_by_creator(&creator1, &None, &Some(20)).unwrap();
    assert_eq!(result1.tokens.len(), 10);
    assert!(result1.cursor.is_none());
    
    // Verify creator2 has 5 tokens
    let result2 = client.get_tokens_by_creator(&creator2, &None, &Some(20)).unwrap();
    assert_eq!(result2.tokens.len(), 5);
    assert!(result2.cursor.is_none());
    
    // Verify tokens belong to correct creators
    for i in 0..result1.tokens.len() {
        let token = result1.tokens.get(i).unwrap();
        assert_eq!(token.creator, creator1);
    }
    
    for i in 0..result2.tokens.len() {
        let token = result2.tokens.get(i).unwrap();
        assert_eq!(token.creator, creator2);
    }
}

#[test]
fn test_get_creator_token_count() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Initially zero
    assert_eq!(client.get_creator_token_count(&creator), 0);
    
    // Create 42 tokens
    for i in 0..42 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // Should return 42
    assert_eq!(client.get_creator_token_count(&creator), 42);
}

#[test]
fn test_pagination_stable_across_new_tokens() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create 30 tokens
    for i in 0..30 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // Get first page
    let page1 = client.get_tokens_by_creator(&creator, &None, &Some(10)).unwrap();
    assert_eq!(page1.tokens.len(), 10);
    
    // Create more tokens
    for i in 30..40 {
        create_token(&env, &client, &creator, &format!("Token {}", i), &format!("TK{}", i));
    }
    
    // Get second page using cursor from before new tokens
    let page2 = client.get_tokens_by_creator(&creator, &page1.cursor, &Some(10)).unwrap();
    assert_eq!(page2.tokens.len(), 10);
    
    // The cursor should still work correctly
    assert!(page2.cursor.is_some());
}

#[test]
fn test_pagination_ordering_by_creation() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);
    
    let creator = Address::generate(&env);
    
    // Create tokens with specific names to verify order
    let token_names = vec!["First", "Second", "Third", "Fourth", "Fifth"];
    for name in &token_names {
        create_token(&env, &client, &creator, name, "TST");
    }
    
    let result = client.get_tokens_by_creator(&creator, &None, &Some(10)).unwrap();
    
    // Verify tokens are in creation order
    for (i, expected_name) in token_names.iter().enumerate() {
        let token = result.tokens.get(i as u32).unwrap();
        assert_eq!(token.name, String::from_str(&env, expected_name));
    }
}
