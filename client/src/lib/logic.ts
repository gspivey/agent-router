/**
 * Re-export shim for the shared, DOM-free pure logic module.
 *
 * The ONLY cross-directory import in the client is the `@shared/logic` alias,
 * which resolves to the repo-root `src/ui/logic.ts` (see `vite.config.ts` /
 * `tsconfig.json`). Components import stream parsing, status mapping, backoff,
 * hash-route parsing, and the dedup helpers from here so there is a single
 * import site for the shared logic (NFR-2.2).
 */
export * from '@shared/logic';
