import { access, constants, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { IDL } from '@icp-sdk/core/candid';

export function isNil(value: unknown): value is null | undefined {
    return value === null || value === undefined;
  }
  
  export function isNotNil<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
  }

export function optional<T>(value: T | undefined | null): [] | [T] {
  return isNil(value) ? [] : [value];
}

export async function readFileAsBytes(filePath: string): Promise<Buffer> {
    return await readFile(filePath);
  }