// exifr publishes no `exports` map and ships types only for its default
// entry point, so the deep import lib/documents/exif.ts uses to reach the
// lite build (see that file for why) has no declarations of its own.
//
// Narrowed to the one call the codebase makes rather than re-declaring the
// library: a wider hand-written surface would be a second, unmaintained copy
// of exifr's types that drifts the first time it is bumped.
declare module 'exifr/dist/lite.esm.mjs' {
  interface ExifrLite {
    parse(
      input: Buffer | Uint8Array | ArrayBuffer,
      options?: { exif?: boolean | { pick?: readonly string[] } },
    ): Promise<Record<string, unknown> | undefined>
  }
  const exifr: ExifrLite
  export default exifr
}
