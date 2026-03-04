# set_metadata Entrypoint Implementation

## Overview

The `set_metadata` entrypoint has been successfully implemented in the Token Factory contract with strict mutability rules to ensure metadata immutability once set.

## Implementation Details

### Location
- **File**: `contracts/token-factory/src/lib.rs` (lines 711-751)
- **Module**: `TokenFactory` contract implementation

### Function Signature

```rust
pub fn set_metadata(
    env: Env,
    token_index: u32,
    admin: Address,
    metadata_uri: String,
) -> Result<(), Error>
```

### Mutability Rules

The implementation enforces strict immutability rules:

1. **One-Time Setting**: Metadata can only be set if it's currently `None`
2. **Permanent**: Once set, metadata cannot be changed or removed
3. **Tamper-Proof**: Any attempt to modify existing metadata returns `Error::MetadataAlreadySet`

### Security Checks

The implementation includes comprehensive security validations:

1. **Pause Check**: Early return if contract is paused (`Error::ContractPaused`)
2. **Authorization**: Requires caller authentication via `admin.require_auth()`
3. **Token Existence**: Validates token exists (`Error::TokenNotFound`)
4. **Creator Verification**: Ensures caller is the token creator (`Error::Unauthorized`)
5. **Immutability Enforcement**: Prevents metadata modification (`Error::MetadataAlreadySet`)

### Implementation Flow

```
1. Check if contract is paused → Return Error::ContractPaused if true
2. Require admin authorization → Panic if not authorized
3. Load token info by index → Return Error::TokenNotFound if not found
4. Verify admin is token creator → Return Error::Unauthorized if mismatch
5. Check if metadata already set → Return Error::MetadataAlreadySet if exists
6. Set metadata URI in token info
7. Update storage by index
8. Update storage by address (dual lookup)
9. Emit metadata_set event
10. Return Ok(())
```

### Storage Updates

The implementation maintains consistency across two storage lookups:

- **By Index**: `storage::set_token_info(&env, token_index, &token_info)`
- **By Address**: `storage::set_token_info_by_address(&env, &token_info.address, &token_info)`

This ensures metadata is accessible via both token index and token address queries.

### Event Emission

The implementation emits an optimized event for off-chain tracking:

```rust
events::emit_metadata_set(&env, &token_info.address, &admin, &metadata_uri);
```

**Event Details**:
- **Symbol**: `meta_set`
- **Indexed**: Token address
- **Payload**: Admin address, metadata URI
- **Location**: `contracts/token-factory/src/events.rs` (lines 113-123)

## Error Handling

The implementation returns specific errors for different failure scenarios:

| Error | Code | Description |
|-------|------|-------------|
| `ContractPaused` | 14 | Operation not allowed while contract is paused |
| `TokenNotFound` | 4 | Token index does not exist |
| `Unauthorized` | 2 | Caller is not the token creator |
| `MetadataAlreadySet` | 5 | Metadata has already been set (immutable) |

## Testing

### Unit Tests

Comprehensive unit tests are implemented in `contracts/token-factory/src/set_metadata_test.rs`:

1. **test_set_metadata_success** - Verifies successful metadata setting
2. **test_set_metadata_immutability** - Ensures metadata cannot be changed
3. **test_set_metadata_unauthorized** - Validates authorization checks
4. **test_set_metadata_token_not_found** - Tests invalid token handling
5. **test_set_metadata_when_paused** - Verifies pause functionality
6. **test_set_metadata_various_uri_formats** - Tests different URI formats
7. **test_set_metadata_event_emission** - Validates event emission
8. **test_set_metadata_updates_both_lookups** - Ensures dual storage consistency
9. **test_set_metadata_empty_string** - Tests edge case with empty URI
10. **test_set_metadata_multiple_tokens** - Verifies isolation between tokens

### Property-Based Tests

Property-based tests using `proptest` are in `contracts/token-factory/src/metadata_immutability_test.rs`:

- **prop_metadata_immutability** - Generates random URIs and verifies immutability across 350 test cases

## Usage Example

```rust
use soroban_sdk::{Env, String, Address};

// Initialize factory
let factory = TokenFactoryClient::new(&env, &contract_id);

// Assume token 0 exists and was created by 'creator'
let token_index = 0u32;
let creator = Address::generate(&env);
let metadata_uri = String::from_str(&env, "ipfs://QmTest1234567890");

// Set metadata (first time - succeeds)
factory.set_metadata(&token_index, &creator, &metadata_uri);

// Attempt to change metadata (fails with MetadataAlreadySet)
let new_uri = String::from_str(&env, "ipfs://QmNewUri");
let result = factory.try_set_metadata(&token_index, &creator, &new_uri);
assert!(result.is_err()); // Returns Error::MetadataAlreadySet
```

## Integration with Token Factory

The `set_metadata` entrypoint integrates seamlessly with the existing Token Factory architecture:

- **Storage Module**: Uses existing storage functions for token info management
- **Events Module**: Leverages optimized event emission system
- **Validation Module**: Follows established validation patterns
- **Error Handling**: Uses standard error types from `types::Error`

## Design Rationale

### Why Immutable Metadata?

1. **Trust**: Users can rely on metadata never changing after deployment
2. **Compliance**: Meets regulatory requirements for immutable token information
3. **Security**: Prevents malicious metadata manipulation
4. **Simplicity**: Eliminates complex versioning or update mechanisms

### Why Creator-Only Access?

Only the token creator can set metadata because:

1. **Ownership**: Creator has primary responsibility for token information
2. **Accountability**: Clear attribution of metadata to original creator
3. **Security**: Prevents unauthorized metadata injection

### Why Dual Storage?

Maintaining both index and address lookups provides:

1. **Performance**: Fast lookups by either identifier
2. **Flexibility**: Supports different query patterns
3. **Consistency**: Ensures data integrity across access methods

## Compliance

The implementation follows Stellar/Soroban best practices:

- ✅ Uses `require_auth()` for authorization
- ✅ Implements fail-fast error handling
- ✅ Emits events for off-chain tracking
- ✅ Maintains storage consistency
- ✅ Includes comprehensive documentation
- ✅ Provides extensive test coverage
- ✅ Follows gas optimization patterns

## Future Considerations

While the current implementation is complete and production-ready, potential future enhancements could include:

1. **Metadata Validation**: Optional URI format validation
2. **Metadata Fees**: Charging a fee for metadata setting (already supported via factory fees)
3. **Batch Metadata Setting**: Setting metadata for multiple tokens in one transaction
4. **Metadata Events**: Enhanced event payloads for better off-chain indexing

## Conclusion

The `set_metadata` entrypoint is fully implemented with robust mutability rules, comprehensive security checks, and extensive test coverage. The implementation ensures metadata immutability while maintaining consistency across storage lookups and providing clear error handling for all edge cases.
