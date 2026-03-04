# set_metadata Quick Reference

## Function Signature

```rust
pub fn set_metadata(
    env: Env,
    token_index: u32,
    admin: Address,
    metadata_uri: String,
) -> Result<(), Error>
```

## Mutability Rules

✅ **Can set**: When `metadata_uri` is `None`  
❌ **Cannot set**: When `metadata_uri` is already `Some(value)`

## Security Checks (in order)

1. Contract not paused
2. Admin authorization (`require_auth()`)
3. Token exists
4. Admin is token creator
5. Metadata not already set

## Error Codes

| Error | When |
|-------|------|
| `ContractPaused` | Contract is paused |
| `TokenNotFound` | Invalid token index |
| `Unauthorized` | Caller is not creator |
| `MetadataAlreadySet` | Metadata already exists |

## Usage

```rust
// First time - succeeds
factory.set_metadata(&0, &creator, &uri);

// Second time - fails
factory.try_set_metadata(&0, &creator, &new_uri); // Error::MetadataAlreadySet
```

## Event Emitted

```
Symbol: "meta_set"
Indexed: token_address
Payload: (admin, metadata_uri)
```

## Storage Updates

- Updates token info by index
- Updates token info by address
- Maintains dual lookup consistency

## Key Features

- **Immutable**: Once set, cannot be changed
- **Creator-only**: Only token creator can set
- **Pausable**: Respects contract pause state
- **Atomic**: Both storage lookups updated together
- **Auditable**: Emits event for tracking
