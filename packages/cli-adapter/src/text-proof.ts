/** Internal, process-local evidence. A JSON cache record cannot authorize a run directly. */
declare const brand: unique symbol;
export type TextCliProof = { readonly [brand]: true };
const proofs = new WeakMap<TextCliProof, { path: string; version: string }>();

/** Used only by the compatibility checker, including its synthetic test run. */
export function issueTextProof(path: string, version: string): TextCliProof {
  const proof = Object.freeze({}) as TextCliProof;
  proofs.set(proof, { path, version });
  return proof;
}

export function textProofVersion(proof: TextCliProof | undefined, path: string): string | undefined {
  const checked = proof && proofs.get(proof);
  return checked?.path === path ? checked.version : undefined;
}
