/**
 * Type declarations for experimental-fast-webstreams.
 *
 * FastReadableStream, FastWritableStream, and FastTransformStream are
 * API-compatible drop-in replacements for the standard WHATWG stream
 * constructors. We re-export the built-in TypeScript types so that
 * consumers get full type-checking without any custom type definitions.
 */

export declare const FastReadableStream: {
  new <R = any>(
    underlyingSource?: UnderlyingSource<R>,
    strategy?: QueuingStrategy<R>,
  ): ReadableStream<R>;
  from<R>(
    asyncIterable: AsyncIterable<R> | Iterable<R>,
  ): ReadableStream<R>;
  prototype: ReadableStream;
};

export declare const FastWritableStream: {
  new <W = any>(
    underlyingSink?: UnderlyingSink<W>,
    strategy?: QueuingStrategy<W>,
  ): WritableStream<W>;
  prototype: WritableStream;
};

export declare const FastTransformStream: {
  new <I = any, O = any>(
    transformer?: Transformer<I, O>,
    writableStrategy?: QueuingStrategy<I>,
    readableStrategy?: QueuingStrategy<O>,
  ): TransformStream<I, O>;
  prototype: TransformStream;
};

export declare const FastReadableStreamDefaultReader: {
  new <R = any>(stream: ReadableStream<R>): ReadableStreamDefaultReader<R>;
  prototype: ReadableStreamDefaultReader;
};

export declare const FastReadableStreamBYOBReader: {
  new (stream: ReadableStream<Uint8Array>): ReadableStreamBYOBReader;
  prototype: ReadableStreamBYOBReader;
};

export declare const FastWritableStreamDefaultWriter: {
  new <W = any>(stream: WritableStream<W>): WritableStreamDefaultWriter<W>;
  prototype: WritableStreamDefaultWriter;
};

export interface PatchOptions {
  /** Keep TransformStream native. Recommended for Next.js where native C++
   *  handles the 5-8 chained SSR transforms faster than Node.js Transform. */
  skipTransform?: boolean;
  /** Keep WritableStream native. Should be set when skipTransform is true,
   *  since native pipeTo needs real native WritableStream internal slots. */
  skipWritable?: boolean;
}

/** Replace global ReadableStream, WritableStream, TransformStream with fast alternatives. */
export declare function patchGlobalWebStreams(options?: PatchOptions): void;

/** Restore the original native stream constructors. */
export declare function unpatchGlobalWebStreams(): void;
