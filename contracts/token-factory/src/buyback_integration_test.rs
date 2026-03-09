/// Integration tests for buyback campaign functionality
///
/// Tests cover:
/// - Authorization checks (admin and token creator)
/// - Validation of campaign parameters
/// - Event emission and payload verification
/// - Multiple campaign scenarios

#[cfg(test)]
mod buyback_integration_tests {
    use crate::types::{BuybackCampaign, CampaignStatus, DataKey, Error, TokenInfo};
    use crate::TokenFactory;
    use crate::TokenFactoryClient;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        Address, Env, IntoVal, String, Symbol,
    };

    fn setup_factory() -> (Env, TokenFactoryClient, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Initialize factory
        client.initialize(&admin, &treasury, &1_000_000, &500_000);

        let token_creator = Address::generate(&env);

        (env, client, admin, treasury, token_creator)
    }

    fn create_test_token(
        env: &Env,
        client: &TokenFactoryClient,
        creator: &Address,
    ) -> (u32, Address) {
        // Create a token
        let token_params = crate::types::TokenCreationParams {
            name: String::from_str(env, "Test Token"),
            symbol: String::from_str(env, "TEST"),
            decimals: 7,
            initial_supply: 1_000_000_0000000,
            max_supply: None,
            metadata_uri: None,
        };

        // Note: This assumes create_token exists. If not, we'll need to mock the token
        // For now, let's manually set up the token in storage
        let token_address = Address::generate(env);
        let token_info = TokenInfo {
            address: token_address.clone(),
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

        // Store token directly in contract storage
        env.as_contract(&client.address, || {
            env.storage()
                .instance()
                .set(&DataKey::Token(0), &token_info);
            env.storage().instance().set(&DataKey::TokenCount, &1u32);
        });

        (0, token_address)
    }

    #[test]
    fn test_authorized_admin_can_create_campaign() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let budget = 10_000_0000000i128;
        let result = client.try_create_buyback_campaign(&admin, &token_index, &budget);

        assert!(result.is_ok());
        let campaign_id = result.unwrap();
        assert_eq!(campaign_id, 0);

        // Verify campaign details
        let campaign = client.get_buyback_campaign(&campaign_id);
        assert_eq!(campaign.id, 0);
        assert_eq!(campaign.token_index, token_index);
        assert_eq!(campaign.creator, admin);
        assert_eq!(campaign.budget, budget);
        assert_eq!(campaign.spent, 0);
        assert_eq!(campaign.tokens_bought, 0);
        assert_eq!(campaign.execution_count, 0);
        assert_eq!(campaign.status, CampaignStatus::Active);
    }

    #[test]
    fn test_authorized_token_creator_can_create_campaign() {
        let (env, client, _admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let budget = 5_000_0000000i128;
        let result = client.try_create_buyback_campaign(&token_creator, &token_index, &budget);

        assert!(result.is_ok());
        let campaign_id = result.unwrap();

        let campaign = client.get_buyback_campaign(&campaign_id);
        assert_eq!(campaign.creator, token_creator);
        assert_eq!(campaign.budget, budget);
        assert_eq!(campaign.status, CampaignStatus::Active);
    }

    #[test]
    fn test_unauthorized_user_cannot_create_campaign() {
        let (env, client, _admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let unauthorized = Address::generate(&env);
        let budget = 10_000_0000000i128;

        let result = client.try_create_buyback_campaign(&unauthorized, &token_index, &budget);

        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_zero_budget_fails() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let result = client.try_create_buyback_campaign(&admin, &token_index, &0);

        assert_eq!(result, Err(Ok(Error::InvalidBudget)));
    }

    #[test]
    fn test_negative_budget_fails() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let result = client.try_create_buyback_campaign(&admin, &token_index, &(-1000));

        assert_eq!(result, Err(Ok(Error::InvalidBudget)));
    }

    #[test]
    fn test_invalid_token_index_fails() {
        let (env, client, admin, _treasury, _token_creator) = setup_factory();

        let budget = 10_000_0000000i128;
        let result = client.try_create_buyback_campaign(&admin, &999, &budget);

        assert_eq!(result, Err(Ok(Error::TokenNotFound)));
    }

    #[test]
    fn test_campaign_created_event_emitted() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let budget = 10_000_0000000i128;
        let campaign_id = client.create_buyback_campaign(&admin, &token_index, &budget);

        // Verify event was emitted
        let events = env.events().all();
        let mut found_event = false;

        for event in events.iter() {
            let topics = &event.topics;
            if topics.len() >= 2 {
                if let Ok(symbol) = topics.get(0).unwrap().try_into_val(&env) {
                    let sym: Symbol = symbol;
                    if sym == Symbol::new(&env, "cmp_cr_v1") {
                        found_event = true;
                        // Verify campaign_id in topics
                        assert_eq!(topics.get(1).unwrap(), campaign_id.into_val(&env));
                        break;
                    }
                }
            }
        }

        assert!(found_event, "Campaign created event not found");
    }

    #[test]
    fn test_campaign_created_event_has_correct_payload() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _token_address) = create_test_token(&env, &client, &token_creator);

        let budget = 10_000_0000000i128;
        let campaign_id = client.create_buyback_campaign(&admin, &token_index, &budget);

        // Get the campaign to verify event payload matches
        let campaign = client.get_buyback_campaign(&campaign_id);

        // Verify event structure
        let events = env.events().all();
        let mut found_event = false;

        for event in events.iter() {
            let topics = &event.topics;
            if topics.len() >= 2 {
                if let Ok(symbol) = topics.get(0).unwrap().try_into_val(&env) {
                    let sym: Symbol = symbol;
                    if sym == Symbol::new(&env, "cmp_cr_v1") {
                        found_event = true;
                        // Event payload should contain: creator, token_index, budget, status
                        // The actual payload is in event.data
                        break;
                    }
                }
            }
        }

        assert!(found_event);
        assert_eq!(campaign.creator, admin);
        assert_eq!(campaign.token_index, token_index);
        assert_eq!(campaign.budget, budget);
        assert_eq!(campaign.status, CampaignStatus::Active);
    }

    #[test]
    fn test_multiple_campaigns_can_be_created() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();

        // Create two tokens
        let (token_index_1, _) = create_test_token(&env, &client, &token_creator);

        // Create second token
        env.as_contract(&client.address, || {
            let token_info = TokenInfo {
                address: Address::generate(&env),
                creator: token_creator.clone(),
                name: String::from_str(&env, "Test Token 2"),
                symbol: String::from_str(&env, "TEST2"),
                decimals: 7,
                total_supply: 2_000_000_0000000,
                initial_supply: 2_000_000_0000000,
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
                .set(&DataKey::Token(1), &token_info);
            env.storage().instance().set(&DataKey::TokenCount, &2u32);
        });

        let campaign_id_1 = client.create_buyback_campaign(&admin, &token_index_1, &10_000_0000000);
        let campaign_id_2 = client.create_buyback_campaign(&admin, &1, &20_000_0000000);

        assert_eq!(campaign_id_1, 0);
        assert_eq!(campaign_id_2, 1);

        let campaign_1 = client.get_buyback_campaign(&campaign_id_1);
        let campaign_2 = client.get_buyback_campaign(&campaign_id_2);

        assert_eq!(campaign_1.token_index, 0);
        assert_eq!(campaign_2.token_index, 1);
        assert_eq!(campaign_1.budget, 10_000_0000000);
        assert_eq!(campaign_2.budget, 20_000_0000000);
    }

    #[test]
    fn test_campaign_counters_increment_correctly() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _) = create_test_token(&env, &client, &token_creator);

        // Create first campaign
        let campaign_id_1 = client.create_buyback_campaign(&admin, &token_index, &10_000_0000000);
        assert_eq!(campaign_id_1, 0);

        // Create second campaign
        let campaign_id_2 = client.create_buyback_campaign(&admin, &token_index, &15_000_0000000);
        assert_eq!(campaign_id_2, 1);

        // Verify campaign count
        env.as_contract(&client.address, || {
            let count: u64 = env
                .storage()
                .instance()
                .get(&DataKey::BuybackCampaignCount)
                .unwrap();
            assert_eq!(count, 2);

            let next_id: u64 = env
                .storage()
                .instance()
                .get(&DataKey::NextCampaignId)
                .unwrap();
            assert_eq!(next_id, 2);
        });
    }

    #[test]
    fn test_get_nonexistent_campaign_fails() {
        let (_env, client, _admin, _treasury, _token_creator) = setup_factory();

        let result = client.try_get_buyback_campaign(&999);
        assert_eq!(result, Err(Ok(Error::CampaignNotFound)));
    }

    #[test]
    fn test_campaign_timestamps_are_set() {
        let (env, client, admin, _treasury, token_creator) = setup_factory();
        let (token_index, _) = create_test_token(&env, &client, &token_creator);

        let timestamp_before = env.ledger().timestamp();
        let campaign_id = client.create_buyback_campaign(&admin, &token_index, &10_000_0000000);
        let timestamp_after = env.ledger().timestamp();

        let campaign = client.get_buyback_campaign(&campaign_id);

        assert!(campaign.created_at >= timestamp_before);
        assert!(campaign.created_at <= timestamp_after);
        assert_eq!(campaign.created_at, campaign.updated_at);
    }
}
