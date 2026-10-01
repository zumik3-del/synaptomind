/**
 * Build-time stand-in for `sharp` (ADR 0001 §7.2).
 *
 * `@huggingface/transformers` does a top-level `import sharp from "sharp"` and
 * then branches `else if (sharp)`, throwing "Unable to load image processing
 * library." when the import is falsy. A compiled binary cannot resolve the real
 * package from inside the embedded filesystem, so the build aliases it here.
 *
 * The default export MUST be truthy — exporting `undefined`/`null` moves the
 * failure from call time to module load. SynaptoMind is text-only, so nothing
 * ever calls it; the throw keeps that honest.
 */
function sharpStub(): never {
	throw new Error('sharp is not bundled in this build (text-only embeddings)')
}

export default sharpStub
