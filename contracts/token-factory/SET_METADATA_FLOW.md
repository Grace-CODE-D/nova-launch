# set_metadata Implementation Flow

## Function Call Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Client calls: set_metadata(token_index, admin, uri)        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  1. CHECK: Is contract paused?                               │
│     storage::is_paused(&env)                                 │
│     ├─ YES → Return Error::ContractPaused                    │
│     └─ NO  → Continue                                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  2. AUTHORIZE: Verify caller signature                       │
│     admin.require_auth()                                     │
│     └─ Panics if not authorized                              │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  3. LOAD: Get token info from storage                        │
│     storage::get_token_info(&env, token_index)               │
│     ├─ None → Return Error::TokenNotFound                    │
│     └─ Some(info) → Continue                                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  4. VERIFY: Is caller the token creator?                     │
│     token_info.creator == admin                              │
│     ├─ NO  → Return Error::Unauthorized                      │
│     └─ YES → Continue                                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  5. CHECK: Is metadata already set?                          │
│     token_info.metadata_uri.is_some()                        │
│     ├─ YES → Return Error::MetadataAlreadySet                │
│     └─ NO  → Continue                                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  6. UPDATE: Set metadata URI                                 │
│     token_info.metadata_uri = Some(metadata_uri.clone())     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  7. STORE: Update storage by index                           │
│     storage::set_token_info(&env, token_index, &token_info)  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  8. STORE: Update storage by address                         │
│     storage::set_token_info_by_address(...)                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  9. EVENT: Emit metadata_set event                           │
│     events::emit_metadata_set(...)                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  10. RETURN: Ok(())                                          │
└─────────────────────────────────────────────────────────────┘
```

## State Transitions

```
Initial State:
┌──────────────────────────┐
│ TokenInfo {              │
│   metadata_uri: None     │
│   ...                    │
│ }                        │
└──────────────────────────┘
           │
           │ set_metadata(uri)
           ▼
┌──────────────────────────┐
│ TokenInfo {              │
│   metadata_uri: Some(uri)│
│   ...                    │
│ }                        │
└──────────────────────────┘
           │
           │ set_metadata(new_uri)
           ▼
┌──────────────────────────┐
│ Error::MetadataAlreadySet│
│ (State unchanged)        │
└──────────────────────────┘
```

## Error Handling Paths

```
                    set_metadata()
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
   [Paused?]        [Token Exists?]   [Authorized?]
        │                 │                 │
        ├─YES             ├─NO              ├─NO
        │                 │                 │
        ▼                 ▼                 ▼
  ContractPaused    TokenNotFound     Unauthorized
        │                 │                 │
        └─────────────────┴─────────────────┘
                          │
                          ▼
                  [Already Set?]
                          │
                          ├─YES
                          │
                          ▼
                 MetadataAlreadySet
                          │
                          ├─NO
                          │
                          ▼
                      Success!
```

## Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Contract Storage                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Index-based Lookup:                                         │
│  ┌────────────────────────────────────────────────┐         │
│  │ DataKey::Token(0) → TokenInfo {                │         │
│  │   address: 0xABC...,                           │         │
│  │   metadata_uri: Some("ipfs://Qm..."),          │         │
│  │   ...                                          │         │
│  │ }                                              │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  Address-based Lookup:                                       │
│  ┌────────────────────────────────────────────────┐         │
│  │ DataKey::TokenByAddress(0xABC...) → TokenInfo {│         │
│  │   address: 0xABC...,                           │         │
│  │   metadata_uri: Some("ipfs://Qm..."),          │         │
│  │   ...                                          │         │
│  │ }                                              │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  ⚠️  Both lookups MUST be kept in sync!                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Event Emission

```
┌─────────────────────────────────────────────────────────────┐
│  Event: "meta_set"                                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Topics (Indexed):                                           │
│    - Symbol: "meta_set"                                      │
│    - Token Address: 0xABC...                                 │
│                                                              │
│  Data (Payload):                                             │
│    - Admin Address: 0xDEF...                                 │
│    - Metadata URI: "ipfs://Qm..."                            │
│                                                              │
│  Purpose:                                                    │
│    - Off-chain indexing                                      │
│    - Audit trail                                             │
│    - Frontend notifications                                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Security Layers                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: Contract State                                     │
│  ┌────────────────────────────────────────────────┐         │
│  │ Pause Check → Prevents all operations when     │         │
│  │               contract is paused                │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  Layer 2: Authentication                                     │
│  ┌────────────────────────────────────────────────┐         │
│  │ require_auth() → Verifies caller signature     │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  Layer 3: Authorization                                      │
│  ┌────────────────────────────────────────────────┐         │
│  │ Creator Check → Only token creator can set     │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  Layer 4: Immutability                                       │
│  ┌────────────────────────────────────────────────┐         │
│  │ Already Set Check → Prevents modification      │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Immutability Guarantee

```
Time →

T0: Token Created
    metadata_uri = None
    ┌─────────────────┐
    │ Can set metadata│
    └─────────────────┘

T1: set_metadata() called
    metadata_uri = Some("ipfs://Qm...")
    ┌─────────────────┐
    │ Metadata locked │
    └─────────────────┘

T2: Attempt to change
    ┌─────────────────┐
    │ ❌ REJECTED     │
    │ MetadataAlready │
    │ Set             │
    └─────────────────┘

T3...∞: Forever immutable
    metadata_uri = Some("ipfs://Qm...")
    ┌─────────────────┐
    │ Permanently set │
    │ Cannot change   │
    └─────────────────┘
```

## Integration Points

```
┌─────────────────────────────────────────────────────────────┐
│                    set_metadata                              │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Storage    │  │    Events    │  │    Types     │
│   Module     │  │    Module    │  │    Module    │
├──────────────┤  ├──────────────┤  ├──────────────┤
│ • is_paused  │  │ • emit_      │  │ • TokenInfo  │
│ • get_token_ │  │   metadata_  │  │ • Error      │
│   info       │  │   set        │  │ • DataKey    │
│ • set_token_ │  └──────────────┘  └──────────────┘
│   info       │
│ • set_token_ │
│   info_by_   │
│   address    │
└──────────────┘
```

## Performance Characteristics

```
Operation                    | Gas Cost | Notes
─────────────────────────────┼──────────┼─────────────────────
Pause check                  | ~100     | Single storage read
Authorization                | ~500     | Signature verification
Token info load              | ~1000    | Storage read
Creator verification         | ~50      | Address comparison
Metadata check               | ~50      | Option check
Storage update (by index)    | ~2000    | Storage write
Storage update (by address)  | ~2000    | Storage write
Event emission               | ~500     | Optimized event
─────────────────────────────┼──────────┼─────────────────────
TOTAL (approximate)          | ~6200    | Per successful call
```

## Testing Coverage

```
┌─────────────────────────────────────────────────────────────┐
│                    Test Coverage                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ Success path                                             │
│  ✅ Immutability enforcement                                 │
│  ✅ Unauthorized access                                      │
│  ✅ Token not found                                          │
│  ✅ Contract paused                                          │
│  ✅ Various URI formats                                      │
│  ✅ Event emission                                           │
│  ✅ Dual storage consistency                                 │
│  ✅ Empty string handling                                    │
│  ✅ Multiple token isolation                                 │
│  ✅ Property-based immutability (350 cases)                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```
