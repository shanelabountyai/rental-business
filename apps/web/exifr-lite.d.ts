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
    /// R-068 phase 2. The library's own type declares this as always
    /// returning `{latitude, longitude}` with no undefined case; the actual
    /// implementation (node_modules/exifr/src/highlevel/gps.mjs) returns
    /// `undefined` when the photo carries no GPS block - narrowed here to
    /// match runtime behaviour rather than the library's own optimistic
    /// declaration, since extractGeotag() has to handle that case anyway.
    gps(
      input: Buffer | Uint8Array | ArrayBuffer,
    ): Promise<{ latitude: number; longitude: number } | undefined>
  }
  const exifr: ExifrLite
  export default exifr
}
