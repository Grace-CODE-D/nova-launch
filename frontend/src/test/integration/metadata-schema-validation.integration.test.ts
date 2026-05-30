/**
 * Integration tests for IPFS metadata schema validation (#1165).
 * Verifies that malformed or unsupported metadata is rejected before pinning.
 */

import { describe, it, expect } from 'vitest';
import { validateMetadataSchema, SUPPORTED_SCHEMA_VERSIONS } from '../../services/metadataSchema';

describe('validateMetadataSchema', () => {
    describe('valid metadata', () => {
        it('accepts v1 metadata without schemaVersion field', () => {
            const result = validateMetadataSchema({
                name: 'My Token',
                description: 'A test token',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(true);
            expect(result.version).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        it('accepts explicit v1 metadata', () => {
            const result = validateMetadataSchema({
                schemaVersion: 1,
                name: 'My Token',
                description: 'A test token',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(true);
            expect(result.version).toBe(1);
        });

        it('accepts v2 metadata with attributes', () => {
            const result = validateMetadataSchema({
                schemaVersion: 2,
                name: 'My Token',
                description: 'A test token',
                image: 'ipfs://QmTest',
                attributes: [{ trait_type: 'color', value: 'blue' }],
            });
            expect(result.valid).toBe(true);
            expect(result.version).toBe(2);
        });

        it('accepts v2 metadata without optional attributes', () => {
            const result = validateMetadataSchema({
                schemaVersion: 2,
                name: 'My Token',
                description: 'A test token',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(true);
        });
    });

    describe('invalid metadata', () => {
        it('rejects null', () => {
            const result = validateMetadataSchema(null);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toMatch(/non-null object/i);
        });

        it('rejects missing name', () => {
            const result = validateMetadataSchema({
                description: 'desc',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
        });

        it('rejects empty description', () => {
            const result = validateMetadataSchema({
                name: 'Token',
                description: '   ',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('"description"'))).toBe(true);
        });

        it('rejects missing image', () => {
            const result = validateMetadataSchema({
                name: 'Token',
                description: 'desc',
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('"image"'))).toBe(true);
        });

        it('rejects malformed v2 attributes', () => {
            const result = validateMetadataSchema({
                schemaVersion: 2,
                name: 'Token',
                description: 'desc',
                image: 'ipfs://QmTest',
                attributes: [{ trait_type: 123, value: 'blue' }],
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('trait_type'))).toBe(true);
        });
    });

    describe('unsupported schema version', () => {
        it('rejects version 99', () => {
            const result = validateMetadataSchema({
                schemaVersion: 99,
                name: 'Token',
                description: 'desc',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toMatch(/unsupported schema version/i);
            expect(result.errors[0]).toContain(SUPPORTED_SCHEMA_VERSIONS.join(', '));
        });

        it('rejects version 0', () => {
            const result = validateMetadataSchema({
                schemaVersion: 0,
                name: 'Token',
                description: 'desc',
                image: 'ipfs://QmTest',
            });
            expect(result.valid).toBe(false);
        });
    });
});
