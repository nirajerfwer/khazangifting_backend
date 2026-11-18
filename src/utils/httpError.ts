// Error type thrown by the service layer. The central error handler in server.ts turns it
// into the project's standard `{ success: false, message, code }` response, so services
// stay free of Express and controllers stay free of try/catch boilerplate.
export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";
