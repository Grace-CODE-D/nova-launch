#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

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

    // Initialize timelock with 1 hour delay
    crate::timelock::initialize_timelock(&env, Some(3600)).unwrap();

    (env, contract_id, admin, treasury)
}

#[test]
fn test_schedule_fee_update_creates_pending_change() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();

    let pending = client.get_pending_change(&change_id).unwrap();
    assert_eq!(pending.base_fee, Some(2_000_000));
    assert_eq!(pending.metadata_fee, None);
    assert!(!pending.executed);
    assert_eq!(pending.scheduled_by, admin);
}

#[test]
fn test_execute_change_before_timelock_fails() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();

    // Try to execute immediately
    let result = client.execute_change(&change_id);
    assert!(result.is_err());
}

#[test]
fn test_execute_change_after_timelock_succeeds() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &Some(750_000))
        .unwrap();

    // Advance time by 1 hour + 1 second
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 3601;
    });

    // Execute the change
    client.execute_change(&change_id).unwrap();

    // Verify fees were updated
    assert_eq!(client.get_base_fee(), 2_000_000);
    assert_eq!(client.get_metadata_fee(), 750_000);

    // Verify change is marked as executed
    let pending = client.get_pending_change(&change_id).unwrap();
    assert!(pending.executed);
}

#[test]
fn test_execute_change_twice_fails() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();

    // Advance time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 3601;
    });

    // Execute once
    client.execute_change(&change_id).unwrap();

    // Try to execute again
    let result = client.execute_change(&change_id);
    assert!(result.is_err());
}

#[test]
fn test_cancel_pending_change() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();

    // Cancel the change
    client.cancel_change(&admin, &change_id).unwrap();

    // Verify change is removed
    assert!(client.get_pending_change(&change_id).is_none());

    // Verify fees were not updated
    assert_eq!(client.get_base_fee(), 1_000_000);
}

#[test]
fn test_schedule_pause_update() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client.schedule_pause_update(&admin, &true).unwrap();

    let pending = client.get_pending_change(&change_id).unwrap();
    assert_eq!(pending.paused, Some(true));
    assert!(!pending.executed);
}

#[test]
fn test_execute_pause_update() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client.schedule_pause_update(&admin, &true).unwrap();

    // Advance time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 3601;
    });

    // Execute the change
    client.execute_change(&change_id).unwrap();

    // Verify contract is paused
    assert!(client.is_paused());
}

#[test]
fn test_schedule_treasury_update() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let new_treasury = Address::generate(&env);
    let change_id = client
        .schedule_treasury_update(&admin, &new_treasury)
        .unwrap();

    let pending = client.get_pending_change(&change_id).unwrap();
    assert_eq!(pending.treasury, Some(new_treasury.clone()));
}

#[test]
fn test_execute_treasury_update() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let new_treasury = Address::generate(&env);
    let change_id = client
        .schedule_treasury_update(&admin, &new_treasury)
        .unwrap();

    // Advance time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 3601;
    });

    // Execute the change
    client.execute_change(&change_id).unwrap();

    // Verify treasury was updated
    let state = client.get_state();
    assert_eq!(state.treasury, new_treasury);
}

#[test]
fn test_multiple_pending_changes() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    // Schedule multiple changes
    let change_id1 = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();
    let change_id2 = client.schedule_pause_update(&admin, &true).unwrap();
    let new_treasury = Address::generate(&env);
    let change_id3 = client
        .schedule_treasury_update(&admin, &new_treasury)
        .unwrap();

    // Verify all are pending
    assert!(client.get_pending_change(&change_id1).is_some());
    assert!(client.get_pending_change(&change_id2).is_some());
    assert!(client.get_pending_change(&change_id3).is_some());

    // Advance time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 3601;
    });

    // Execute all changes
    client.execute_change(&change_id1).unwrap();
    client.execute_change(&change_id2).unwrap();
    client.execute_change(&change_id3).unwrap();

    // Verify all changes were applied
    assert_eq!(client.get_base_fee(), 2_000_000);
    assert!(client.is_paused());
    assert_eq!(client.get_state().treasury, new_treasury);
}

#[test]
fn test_unauthorized_schedule_fails() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let attacker = Address::generate(&env);

    // Try to schedule as non-admin
    let result = client.schedule_fee_update(&attacker, &Some(2_000_000), &None);
    assert!(result.is_err());
}

#[test]
fn test_unauthorized_cancel_fails() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();

    let attacker = Address::generate(&env);

    // Try to cancel as non-admin
    let result = client.cancel_change(&attacker, &change_id);
    assert!(result.is_err());
}

#[test]
fn test_get_timelock_config() {
    let (env, _contract_id, _admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    let config = client.get_timelock_config();
    assert_eq!(config.delay_seconds, 3600);
    assert!(config.enabled);
}

#[test]
fn test_timelock_events_emitted() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    // Schedule a change
    let change_id = client
        .schedule_fee_update(&admin, &Some(2_000_000), &None)
        .unwrap();

    // Verify schedule event was emitted
    let events = env.events().all();
    assert!(!events.is_empty());

    // Advance time and execute
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 3601;
    });

    client.execute_change(&change_id).unwrap();

    // Verify execute event was emitted
    let events = env.events().all();
    assert!(!events.is_empty());
}

#[test]
fn test_negative_fee_in_schedule_fails() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    // Try to schedule negative fee
    let result = client.schedule_fee_update(&admin, &Some(-1_000_000), &None);
    assert!(result.is_err());
}

#[test]
fn test_both_fees_none_fails() {
    let (env, _contract_id, admin, _treasury) = setup();
    let client = TokenFactoryClient::new(&env, &_contract_id);

    // Try to schedule with no changes
    let result = client.schedule_fee_update(&admin, &None, &None);
    assert!(result.is_err());
}
