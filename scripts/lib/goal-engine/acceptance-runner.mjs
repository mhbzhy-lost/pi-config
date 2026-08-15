// Compatibility façade: managed-validation owns validation leases, supervision, proofs, and release.
export {
  createValidationWorkspace,
  runCleanValidation,
  releaseValidationWorkspace,
} from "./managed-validation.mjs";
