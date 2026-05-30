/**
 * Versioned schema validation for IPFS token metadata (#1165).
 *
 * Schema versions:
 *   v1 – original schema: name, description, image (all required strings)
 *   v2 – adds optional `attributes` array
 *
 * Any metadata object without a `schemaVersion` field is treated as v1
 * for backwards compatibility. Unsupported versions are rejected.
 */

export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;
export type SchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

export interface MetadataSchemaV1 {
    schemaVersion?: 1;
    name: string;
    description: string;
    image: string;
}

export interface MetadataSchemaV2 extends MetadataSchemaV1 {
    schemaVersion: 2;
    attributes?: Array<{ trait_type: string; value: string | number }>;
}

export type VersionedMetadata = MetadataSchemaV1 | MetadataSchemaV2;

export interface SchemaValidationResult {
    valid: boolean;
    version: SchemaVersion;
    errors: string[];
}

/**
 * Validate token metadata against the versioned schema.
 * Returns a result object so callers can surface specific errors.
 */
export function validateMetadataSchema(metadata: unknown): SchemaValidationResult {
    const errors: string[] = [];

    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { valid: false, version: 1, errors: ['Metadata must be a non-null object'] };
    }

    const obj = metadata as Record<string, unknown>;

    // Determine version (default to 1 for backwards compatibility)
    const rawVersion = obj['schemaVersion'];
    const version: SchemaVersion = rawVersion === undefined ? 1 : (rawVersion as SchemaVersion);

    if (rawVersion !== undefined && !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
        return {
            valid: false,
            version: version as SchemaVersion,
            errors: [
                `Unsupported schema version "${rawVersion}". Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
            ],
        };
    }

    // Common required fields (v1+)
    if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
        errors.push('Field "name" is required and must be a non-empty string');
    }
    if (typeof obj['description'] !== 'string' || obj['description'].trim() === '') {
        errors.push('Field "description" is required and must be a non-empty string');
    }
    if (typeof obj['image'] !== 'string' || obj['image'].trim() === '') {
        errors.push('Field "image" is required and must be a non-empty string');
    }

    // v2-specific validation
    if (version === 2 && obj['attributes'] !== undefined) {
        if (!Array.isArray(obj['attributes'])) {
            errors.push('Field "attributes" must be an array');
        } else {
            (obj['attributes'] as unknown[]).forEach((attr, i) => {
                if (!attr || typeof attr !== 'object' || Array.isArray(attr)) {
                    errors.push(`attributes[${i}] must be an object`);
                    return;
                }
                const a = attr as Record<string, unknown>;
                if (typeof a['trait_type'] !== 'string') {
                    errors.push(`attributes[${i}].trait_type must be a string`);
                }
                if (typeof a['value'] !== 'string' && typeof a['value'] !== 'number') {
                    errors.push(`attributes[${i}].value must be a string or number`);
                }
            });
        }
    }

    return { valid: errors.length === 0, version, errors };
}
