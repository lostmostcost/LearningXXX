import { AppError } from "@learningxxx/contracts";
import type { ErrorCode } from "@learningxxx/contracts";

/** A contract AppError as a throwable. Messages never carry URLs or cookies. */
export class CollectionError extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.message);
    this.name = "CollectionError";
    this.appError = appError;
  }
}

export function collectionError(
  code: ErrorCode,
  message: string,
  options: { retryable?: boolean; retryAfter?: string; httpStatus?: number } = {},
): CollectionError {
  const { retryable = false, retryAfter, httpStatus } = options;
  return new CollectionError(
    AppError.parse({
      code,
      message,
      retryable,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(httpStatus === undefined ? {} : { detail: { httpStatus } }),
    }),
  );
}
