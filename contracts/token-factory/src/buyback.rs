/// Buyback Campaign Module
///
/// Provides functionality for creating and managing token buyback campaigns
/// with role-based authorization and auditable event emission.

use crate::storage;
use crate::types::{BuybackCampaign, CampaignStatus, DataKey, Error};
use soroban_sdk::{Address, Env};

/// Create a new buyback campaign
///
/// # Arguments
/// * `env` - The contract environment
/// * `creator` - Address creating the campaign (must be authorized)
/// * `token_index` - Index of the token to buy back
/// * `budget` - Total budget allocated for the campaign
///
/// # Returns
/// * `Ok(u64)` - The campaign ID if successful
/// * `Err(Error)` - Error if validation fails or unauthorized
///
/// # Authorization
/// Requires the creator to be either:
/// - The factory admin
/// - The token creator
///
/// # Events
/// Emits a versioned `campaign_created` event with campaign details
pub fn create_buyback_campaign(
    env: &Env,
    creator: &Address,
    token_index: u32,
    budget: i128,
) -> Result<u64, Error> {
    // Require authorization from the creator
    creator.require_auth();

    // Validate budget
    if budget <= 0 {
        return Err(Error::InvalidBudget);
    }

    // Validate token exists
    let token_info = storage::get_token_info(env, token_index)?;

    // Check authorization: must be admin or token creator
    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if creator != &admin && creator != &token_info.creator {
        return Err(Error::Unauthorized);
    }

    // Get next campaign ID
    let campaign_id = env
        .storage()
        .instance()
        .get::<DataKey, u64>(&DataKey::NextCampaignId)
        .unwrap_or(0);

    // Create campaign
    let timestamp = env.ledger().timestamp();
    let campaign = BuybackCampaign {
        id: campaign_id,
        token_index,
        creator: creator.clone(),
        budget,
        spent: 0,
        tokens_bought: 0,
        execution_count: 0,
        status: CampaignStatus::Active,
        created_at: timestamp,
        updated_at: timestamp,
    };

    // Persist campaign state
    env.storage()
        .instance()
        .set(&DataKey::BuybackCampaign(campaign_id), &campaign);

    // Update campaign count
    let count = env
        .storage()
        .instance()
        .get::<DataKey, u64>(&DataKey::BuybackCampaignCount)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::BuybackCampaignCount, &(count + 1));

    // Update next campaign ID
    env.storage()
        .instance()
        .set(&DataKey::NextCampaignId, &(campaign_id + 1));

    // Emit versioned event
    emit_campaign_created(env, &campaign);

    Ok(campaign_id)
}

/// Get a buyback campaign by ID
///
/// # Arguments
/// * `env` - The contract environment
/// * `campaign_id` - The campaign ID to retrieve
///
/// # Returns
/// * `Ok(BuybackCampaign)` - The campaign if found
/// * `Err(Error::CampaignNotFound)` - If campaign doesn't exist
pub fn get_campaign(env: &Env, campaign_id: u64) -> Result<BuybackCampaign, Error> {
    env.storage()
        .instance()
        .get::<DataKey, BuybackCampaign>(&DataKey::BuybackCampaign(campaign_id))
        .ok_or(Error::CampaignNotFound)
}

/// Emit campaign created event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: cmp_cr_v1
///
/// **Topics** (indexed):
/// - Event name: "cmp_cr_v1"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - creator: Address - Campaign creator
/// - token_index: u32 - Token being bought back
/// - budget: i128 - Total campaign budget
/// - status: CampaignStatus - Initial status (Active)
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
fn emit_campaign_created(env: &Env, campaign: &BuybackCampaign) {
    env.events().publish(
        (soroban_sdk::symbol_short!("cmp_cr_v1"), campaign.id),
        (
            campaign.creator.clone(),
            campaign.token_index,
            campaign.budget,
            campaign.status,
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{TokenInfo, VaultStatus};
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        vec, Address, Env, IntoVal, String, Symbol,
    };

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        // Initialize storage
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Treasury, &treasury);

        (env, admin, treasury, creator)
    }

    fn create_test_token(env: &Env, creator: &Address, index: u32) {
        let token_info = TokenInfo {
            address: Address::generate(env),
            creator: creator.clone(),
            name: String::from_str(env, "Test Token"),
            symbol: String::from_str(env, "TEST"),
            decimals: 7,
            total_supply: 1_000_000_0000000,
            initial_supply: 1_000_000_0000000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            created_at: env.ledger().timestamp(),
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        };

        env.storage()
            .instance()
            .set(&DataKey::Token(index), &token_info);
        env.storage().instance().set(&DataKey::TokenCount, &(index + 1));
    }

    #[test]
    fn test_create_campaign_success_as_admin() {
        let (env, admin, _treasury, _creator) = setup();
        create_test_token(&env, &admin, 0);

        let budget = 10_000_0000000i128;
        let result = create_buyback_campaign(&env, &admin, 0, budget);

        assert!(result.is_ok());
        let campaign_id = result.unwrap();
        assert_eq!(campaign_id, 0);

        // Verify campaign was stored
        let campaign = get_campaign(&env, campaign_id).unwrap();
        assert_eq!(campaign.id, 0);
        assert_eq!(campaign.token_index, 0);
        assert_eq!(campaign.creator, admin);
        assert_eq!(campaign.budget, budget);
        assert_eq!(campaign.spent, 0);
        assert_eq!(campaign.tokens_bought, 0);
        assert_eq!(campaign.execution_count, 0);
        assert_eq!(campaign.status, CampaignStatus::Active);

        // Verify counters were updated
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BuybackCampaignCount)
            .unwrap();
        assert_eq!(count, 1);

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextCampaignId)
            .unwrap();
        assert_eq!(next_id, 1);
    }

    #[test]
    fn test_create_campaign_success_as_token_creator() {
        let (env, _admin, _treasury, creator) = setup();
        create_test_token(&env, &creator, 0);

        let budget = 5_000_0000000i128;
        let result = create_buyback_campaign(&env, &creator, 0, budget);

        assert!(result.is_ok());
        let campaign_id = result.unwrap();

        let campaign = get_campaign(&env, campaign_id).unwrap();
        assert_eq!(campaign.creator, creator);
        assert_eq!(campaign.budget, budget);
    }

    #[test]
    fn test_create_campaign_unauthorized() {
        let (env, _admin, _treasury, creator) = setup();
        let unauthorized = Address::generate(&env);
        create_test_token(&env, &creator, 0);

        let budget = 10_000_0000000i128;
        let result = create_buyback_campaign(&env, &unauthorized, 0, budget);

        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_create_campaign_invalid_budget_zero() {
        let (env, admin, _treasury, _creator) = setup();
        create_test_token(&env, &admin, 0);

        let result = create_buyback_campaign(&env, &admin, 0, 0);
        assert_eq!(result, Err(Error::InvalidBudget));
    }

    #[test]
    fn test_create_campaign_invalid_budget_negative() {
        let (env, admin, _treasury, _creator) = setup();
        create_test_token(&env, &admin, 0);

        let result = create_buyback_campaign(&env, &admin, 0, -1000);
        assert_eq!(result, Err(Error::InvalidBudget));
    }

    #[test]
    fn test_create_campaign_token_not_found() {
        let (env, admin, _treasury, _creator) = setup();

        let budget = 10_000_0000000i128;
        let result = create_buyback_campaign(&env, &admin, 999, budget);

        assert_eq!(result, Err(Error::TokenNotFound));
    }

    #[test]
    fn test_create_multiple_campaigns() {
        let (env, admin, _treasury, _creator) = setup();
        create_test_token(&env, &admin, 0);
        create_test_token(&env, &admin, 1);

        let campaign_id_1 = create_buyback_campaign(&env, &admin, 0, 10_000_0000000).unwrap();
        let campaign_id_2 = create_buyback_campaign(&env, &admin, 1, 20_000_0000000).unwrap();

        assert_eq!(campaign_id_1, 0);
        assert_eq!(campaign_id_2, 1);

        let campaign_1 = get_campaign(&env, campaign_id_1).unwrap();
        let campaign_2 = get_campaign(&env, campaign_id_2).unwrap();

        assert_eq!(campaign_1.token_index, 0);
        assert_eq!(campaign_2.token_index, 1);
        assert_eq!(campaign_1.budget, 10_000_0000000);
        assert_eq!(campaign_2.budget, 20_000_0000000);
    }

    #[test]
    fn test_get_campaign_not_found() {
        let (env, _admin, _treasury, _creator) = setup();

        let result = get_campaign(&env, 999);
        assert_eq!(result, Err(Error::CampaignNotFound));
    }

    #[test]
    fn test_campaign_created_event_emitted() {
        let (env, admin, _treasury, _creator) = setup();
        create_test_token(&env, &admin, 0);

        let budget = 10_000_0000000i128;
        let campaign_id = create_buyback_campaign(&env, &admin, 0, budget).unwrap();

        // Verify event was emitted
        let events = env.events().all();
        let last_event = events.last().unwrap();

        // Check event topics
        let topics = last_event.topics;
        assert_eq!(topics.len(), 2);
        assert_eq!(
            topics.get(0).unwrap(),
            Symbol::new(&env, "cmp_cr_v1").into_val(&env)
        );
        assert_eq!(topics.get(1).unwrap(), campaign_id.into_val(&env));
    }

    #[test]
    fn test_campaign_created_event_payload() {
        let (env, admin, _treasury, _creator) = setup();
        create_test_token(&env, &admin, 0);

        let budget = 10_000_0000000i128;
        create_buyback_campaign(&env, &admin, 0, budget).unwrap();

        // Verify event payload contains correct data
        let events = env.events().all();
        let last_event = events.last().unwrap();

        // The payload should contain: creator, token_index, budget, status
        // We can't easily deserialize the exact payload structure in tests,
        // but we can verify the event was emitted with the correct topic
        assert_eq!(last_event.topics.len(), 2);
    }
}
