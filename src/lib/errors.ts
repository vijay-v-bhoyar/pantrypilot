export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
  status = 422,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
